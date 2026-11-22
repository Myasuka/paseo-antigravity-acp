import { randomUUID } from 'node:crypto';
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderPersistence,
  ProviderSessionConfig,
} from '@getpaseo/plugin/server/provider';

interface Session {
  config: ProviderSessionConfig;
  persistence?: ProviderPersistence;
  nativeFull: boolean;
  active: boolean;
  ready: boolean;
  nativeOpen: boolean;
  restarting: boolean;
  restarted?: Promise<void>;
  pendingPermissions: Set<string>;
  staged: ProviderEvent[];
}

interface Waiter {
  expected: ProviderEvent['type'];
  resolve(): void;
  reject(error: Error): void;
}

export interface NativeFullAccessOptions {
  onSessionPersistence?(sessionId: string, nativeSessionId: string): void;
}

const FULL = 'full-access';

function readNativeId(persistence?: ProviderPersistence): string | undefined {
  const data = persistence?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const id = (data as Record<string, unknown>).sessionId;
  return typeof id === 'string' && id ? id : undefined;
}

function launchConfig(config: ProviderSessionConfig): ProviderSessionConfig {
  return {
    ...config,
    env: { ...config.env, PASEO_AGY_NATIVE_FULL_ACCESS: config.mode === FULL ? '1' : '0' },
  };
}

// AGY's autonomous wakeups use its native launch policy, outside the foreground ACP callback.
// Keep that policy equal to the displayed mode. Crossing the Full access boundary requires
// an idle native driver restart; never report a safer mode while a skip-permissions driver lives.
export function withNativeFullAccess(
  inner: ProviderConnection,
  options: NativeFullAccessOptions = {},
): ProviderConnection {
  const sessions = new Map<string, Session>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  const waiters = new Map<string, Waiter>();
  let closed = false;

  const emit = (event: ProviderEvent) => {
    for (const listener of listeners) listener(event);
  };

  const trackPersistence = (sessionId: string, persistence?: ProviderPersistence) => {
    const nativeId = readNativeId(persistence);
    if (nativeId) options.onSessionPersistence?.(sessionId, nativeId);
  };

  const observe = (event: ProviderEvent, session: Session) => {
    if (event.type === 'session.ready') session.ready = true;
    if (event.type === 'session.opened' && event.persistence) {
      session.persistence = event.persistence;
      trackPersistence(event.sessionId, event.persistence);
    }
    if (event.type === 'session.persistence') {
      session.persistence = event.persistence;
      trackPersistence(event.sessionId, event.persistence);
    }
    if (event.type === 'session.config') {
      session.config = {
        ...session.config,
        mode: event.config.mode,
        model: event.config.model,
        thinkingOption: event.config.thinkingOption,
      };
    }
    if (event.type === 'session.turn') session.active = event.state === 'started';
    if (event.type === 'session.prompt_result' && event.result.type === 'failed') session.active = false;
    if (event.type === 'session.permission') session.pendingPermissions.add(event.request.id);
    if (event.type === 'session.permission_resolved') session.pendingPermissions.delete(event.permissionId);
  };

  const unsubscribe = inner.onEvent(event => {
    const session = 'sessionId' in event ? sessions.get(event.sessionId) : undefined;
    if (session && event.type === 'session.opened') session.nativeOpen = true;
    if (session && event.type === 'session.closed') session.nativeOpen = false;
    const requestId = 'requestId' in event ? event.requestId : undefined;
    const waiter = requestId ? waiters.get(requestId) : undefined;
    if (waiter) {
      if (event.type === 'request.failed') {
        waiter.reject(new Error(event.error.message));
      } else if (event.type === waiter.expected) {
        // The generic adapter registers the opened session after emitting ready.
        if (event.type === 'session.ready') setImmediate(() => waiter.resolve());
        else waiter.resolve();
      }
      return;
    }
    if (session?.restarting) {
      session.staged.push(event);
      return;
    }
    if (session && event.type === 'session.ready') {
      setImmediate(() => {
        if (!closed && sessions.get(event.sessionId) === session && session.nativeOpen) {
          observe(event, session);
          emit(event);
        }
      });
      return;
    }
    if (session) observe(event, session);
    emit(event);
    if (event.type === 'session.closed') sessions.delete(event.sessionId);
  });

  function request(input: ProviderInput, expected: ProviderEvent['type']): Promise<void> {
    if (closed || !('requestId' in input)) {
      return Promise.reject(new Error('Permission-mode restart is unavailable'));
    }
    const id = input.requestId;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        waiters.delete(id);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error('AGY permission-mode restart timed out')), 60000);
      waiters.set(id, { expected, resolve: () => finish(), reject: finish });
      void inner.send(input).catch(error => finish(error instanceof Error ? error : new Error(String(error))));
    });
  }

  const operationId = () => 'agy-access:' + randomUUID();

  async function reopen(id: string, session: Session, config: ProviderSessionConfig) {
    if (session.nativeOpen) {
      await request({ type: 'session.close', requestId: operationId(), sessionId: id }, 'request.completed');
    }
    await request(
      {
        type: 'session.open',
        requestId: operationId(),
        sessionId: id,
        history: 'skip',
        persistence: session.persistence,
        config: launchConfig(config),
      },
      'session.ready',
    );
  }

  function publishStaged(session: Session) {
    const types = ['session.config', 'session.commands', 'session.persistence'];
    for (const type of types) {
      const event = session.staged.filter(item => item.type === type).at(-1);
      if (event) {
        observe(event, session);
        emit(event);
      }
    }
    for (const event of session.staged.filter(item => item.type === 'session.notice')) emit(event);
    session.staged = [];
  }

  return {
    version: inner.version,
    capabilities: inner.capabilities,
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async send(input) {
      if (input.type === 'session.open') {
        trackPersistence(input.sessionId, input.persistence);
        sessions.set(input.sessionId, {
          config: structuredClone(input.config),
          persistence: input.persistence,
          nativeFull: input.config.mode === FULL,
          active: false,
          ready: false,
          nativeOpen: false,
          restarting: false,
          pendingPermissions: new Set(),
          staged: [],
        });
        return inner.send({ ...input, config: launchConfig(input.config) });
      }
      const session = 'sessionId' in input ? sessions.get(input.sessionId) : undefined;
      if (session?.restarting) {
        if (input.type === 'session.close') {
          await session.restarted;
          return inner.send(input);
        }
        if (input.type === 'session.interrupt') {
          emit({ type: 'request.completed', requestId: input.requestId });
          return;
        }
        if ('requestId' in input) {
          emit({
            type: 'request.failed',
            requestId: input.requestId,
            error: { message: 'AGY is changing its native permission mode; wait for it to finish' },
          });
        } else if (input.type === 'session.prompt') {
          emit({
            type: 'session.prompt_result',
            sessionId: input.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: { type: 'failed', error: { message: 'AGY is changing its native permission mode' } },
          });
        }
        return;
      }
      if (input.type === 'session.configure' && session && input.changes.mode !== undefined) {
        const target = input.changes.mode ?? 'default';
        if ((target === FULL) !== session.nativeFull) {
          if (!session.ready || session.active || session.pendingPermissions.size > 0 || !session.persistence) {
            emit({
              type: 'request.failed',
              requestId: input.requestId,
              error: {
                message: 'Finish or cancel the current AGY turn and pending approvals before entering or leaving Full access',
              },
            });
            return;
          }
          const old = structuredClone(session.config);
          session.restarting = true;
          session.staged = [];
          let finishRestart!: () => void;
          session.restarted = new Promise(resolve => {
            finishRestart = resolve;
          });
          try {
            await reopen(input.sessionId, session, { ...old, mode: target });
            await request({ ...input, requestId: operationId() }, 'request.completed');
            session.nativeFull = target === FULL;
            publishStaged(session);
            emit({ type: 'request.completed', requestId: input.requestId });
          } catch (error) {
            session.staged = [];
            try {
              if (!closed) {
                await reopen(input.sessionId, session, old);
                publishStaged(session);
              }
            } catch (rollback) {
              emit({
                type: 'session.runtime_failed',
                sessionId: input.sessionId,
                error: { message: 'AGY could not restore its previous permission mode: ' + String(rollback) },
              });
            }
            emit({ type: 'request.failed', requestId: input.requestId, error: { message: String(error) } });
          } finally {
            session.restarting = false;
            finishRestart();
          }
          return;
        }
      }
      const isForegroundPrompt = input.type === 'session.prompt' && input.prompt.delivery !== 'steer';
      if (isForegroundPrompt && session) session.active = true;
      try {
        await inner.send(input);
      } catch (error) {
        if (isForegroundPrompt && session) session.active = false;
        throw error;
      }
    },
    async close() {
      closed = true;
      for (const waiter of [...waiters.values()]) waiter.reject(new Error('AGY connection closed'));
      try {
        await inner.close();
      } finally {
        unsubscribe();
        sessions.clear();
        listeners.clear();
      }
    },
  };
}
