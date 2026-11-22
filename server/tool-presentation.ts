import {
  runAcpProvider,
  type AcpConnector,
  type AcpOptions,
  type AcpToolCallSnapshot,
  type AcpTransformer,
  type RunAcpProviderOptions,
} from '@getpaseo/plugin/server/acp';
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderPersistence,
  ProviderPrompt,
  ProviderRegistration,
  ProviderToolCallDetail,
} from '@getpaseo/plugin/server/provider';
import { DEFAULT_READ_ONLY_ROOTS } from '../shared/settings.ts';
import { createAgyBridgeStream, type AgyBridgeStream } from './bridge-connector.mjs';
import { loadHistoryTimestampMatcher, type HistoryTimestampMatcher } from './history-timestamps.mjs';
import { withNativeFullAccess } from './native-full-access.ts';
import { resolveAgyBinary } from './resolve-agy.mjs';

export type DetailedAgyProviderBaseOptions = {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  acpOptions?: AcpOptions;
  transformers?: readonly AcpTransformer[];
  command?: readonly [string, ...string[]];
  connector?: AcpConnector;
};

export interface DetailedAgyProviderOptions {
  resolveRuntimeEnv?(): Promise<Readonly<Record<string, string>>> | Readonly<Record<string, string>>;
  resolveConfiguredAgyPath?(): Promise<string> | string;
  onSessionPersistence?(sessionId: string, nativeSessionId: string): void;
  defaultReadOnlyRoots?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNativeSessionId(persistence?: ProviderPersistence): string | undefined {
  if (!isRecord(persistence?.data)) return undefined;
  const sessionId = persistence.data.sessionId;
  return typeof sessionId === 'string' && sessionId ? sessionId : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function text(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof input[key] === 'string') return input[key];
  return undefined;
}

function number(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function contentBlocks(output: unknown): Record<string, unknown>[] {
  const blocks = record(output)._paseoAgyContent;
  return Array.isArray(blocks) ? blocks.map(record) : [];
}

function outputText(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  const fields = record(output);
  const direct = text(fields, 'output', 'text');
  if (direct !== undefined) return direct;
  const streams = [text(fields, 'stdout'), text(fields, 'stderr')].filter(value => value !== undefined);
  if (streams.length > 0) return streams.join('\n');
  const blocks = contentBlocks(output).flatMap(block => {
    const content = record(block.content);
    return block.type === 'content' && content.type === 'text' && typeof content.text === 'string'
      ? [content.text]
      : [];
  });
  return blocks.length > 0 ? blocks.join('\n') : undefined;
}

export function toolDetail(snapshot: AcpToolCallSnapshot): ProviderToolCallDetail | undefined {
  const input = record(snapshot.input);
  const output = record(snapshot.output);
  const name = snapshot.name ?? snapshot.title;
  const path = text(input, 'Path', 'AbsolutePath', 'TargetFile', 'filePath') ?? snapshot.locations[0];
  const result = outputText(snapshot.output);

  if (name === 'run_command') {
    const command = text(input, 'CommandLine');
    if (command) {
      return {
        type: 'shell',
        command,
        cwd: text(input, 'Cwd', 'WorkingDirectory'),
        output: result,
        exitCode: number(output, 'exit_code') ?? number(output, 'exitCode'),
      };
    }
  }
  if ((name === 'read_file' || name === 'view_file') && path) {
    const start = number(input, 'StartLine');
    const end = number(input, 'EndLine');
    return {
      type: 'read',
      filePath: path,
      content: result,
      offset: start,
      limit: start !== undefined && end !== undefined && end >= start ? end - start + 1 : undefined,
    };
  }
  if (['edit_file', 'replace_file_content', 'multi_replace_file_content'].includes(name)) {
    const diff = contentBlocks(snapshot.output).find(block => block.type === 'diff');
    const filePath = path ?? text(diff ?? {}, 'path');
    if (filePath) {
      return {
        type: 'edit',
        filePath,
        oldString: text(input, 'Target', 'TargetContent', 'oldString') ?? text(diff ?? {}, 'oldText'),
        newString: text(input, 'Replacement', 'ReplacementContent', 'newString') ?? text(diff ?? {}, 'newText'),
        unifiedDiff: text(output, 'unifiedDiff', 'diff'),
      };
    }
  }
  if (['write_to_file', 'write_file'].includes(name) && path) {
    return { type: 'write', filePath: path, content: text(input, 'CodeContent', 'Content', 'content') };
  }
  if (['grep_search', 'find_by_name', 'search_web'].includes(name)) {
    const query = text(input, 'Query', 'SearchTerm', 'Pattern');
    if (query) {
      return {
        type: 'search',
        query,
        toolName: name === 'grep_search' ? 'grep' : name === 'find_by_name' ? 'glob' : 'web_search',
        content: result,
      };
    }
  }
  if (name === 'list_dir') {
    const directory = text(input, 'DirectoryPath');
    if (directory) return { type: 'plain_text', label: directory, text: result, icon: 'eye' };
  }
  if (name === 'read_url_content') {
    const url = text(input, 'Url', 'URL');
    if (url) return { type: 'fetch', url, result };
  }
  if (name === 'invoke_subagent') {
    const childSessionId =
      text(output, 'conversationId') ?? /"conversationId"\s*:\s*"([0-9a-f-]{36})"/i.exec(result ?? '')?.[1];
    return {
      type: 'sub_agent',
      subAgentType: text(input, 'TypeName'),
      description: text(input, 'Role') ?? text(input, 'Prompt'),
      ...(childSessionId ? { childSessionId } : {}),
      log: result ?? text(input, 'Prompt') ?? '',
    };
  }
  if (name === 'manage_subagents') {
    const action = text(input, 'Action');
    if (action) return { type: 'plain_text', label: action, text: result };
  }
  if (name === 'send_message') {
    const recipient = text(input, 'Recipient');
    if (recipient) return { type: 'plain_text', label: recipient, text: result ?? text(input, 'Message') };
  }
  if (name === 'swarm') {
    const action = text(input, 'action') ?? 'status';
    const workerName = text(input, 'name');
    const title = text(input, 'title');
    const model = text(input, 'model');
    const brief = text(input, 'brief');
    if (action === 'add') {
      const firstLine = brief ? brief.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 140) : undefined;
      return {
        type: 'sub_agent',
        subAgentType: workerName ? `swarm:${workerName}` : 'swarm',
        description: firstLine ?? workerName ?? 'Add Swarm worker',
        log: [brief, result].filter(Boolean).join('\n\n'),
      };
    }
    let label = `swarm ${action}`;
    if (action === 'title' && title) label = `swarm title: ${title}`;
    else if (action === 'kill' && workerName) label = `swarm kill @${workerName}`;
    else if (action === 'model') label = `swarm model ${workerName ? `@${workerName} -> ` : ''}${model ?? 'default'}`;
    else if (action === 'channel') {
      const op = text(input, 'op') ?? 'list';
      const channel = text(input, 'channel');
      label = `swarm channel ${op}${channel ? ` #${channel}` : ''}`;
    }
    return { type: 'plain_text', label, text: result, icon: 'bot' };
  }
  if (name === 'post_message') {
    const msgText = text(input, 'text');
    const channel = text(input, 'channel');
    const firstLine = msgText?.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 96) ?? 'post_message';
    const label = channel && channel !== 'main' ? `#${channel}: ${firstLine}` : firstLine;
    return {
      type: 'plain_text',
      label,
      text: [msgText, result].filter(Boolean).join('\n\n'),
      icon: 'bot',
    };
  }
  if (name === 'read_board') {
    const since = number(input, 'since');
    const channel = text(input, 'channel');
    const label = `read_board${channel ? ` #${channel}` : ''}${since !== undefined ? ` (since #${since})` : ''}`;
    return { type: 'plain_text', label, text: result, icon: 'eye' };
  }
  if (name === 'swarm_wait') {
    const since = number(input, 'since');
    const mentionsOnly = typeof input.mentions_only === 'boolean' ? input.mentions_only : undefined;
    const label = `swarm_wait${since !== undefined ? ` (since #${since})` : ''}${mentionsOnly === false ? ' [any post]' : ''}`;
    return { type: 'plain_text', label, text: result, icon: 'sparkles' };
  }
  if (name === 'swarm_progress') {
    const label = text(output, 'label') ?? text(input, 'label') ?? 'Swarm active';
    return {
      type: 'plain_text',
      label,
      text: result,
      icon: 'bot',
    };
  }
  return undefined;
}

type SteerBridgeHandle = {
  canSteer(sessionId: string): boolean;
  steer(sessionId: string, prompt: readonly unknown[]): Promise<boolean>;
};

function isSteerBridge(stream: unknown): stream is SteerBridgeHandle {
  return (
    typeof stream === 'object' &&
    stream !== null &&
    typeof (stream as SteerBridgeHandle).canSteer === 'function' &&
    typeof (stream as SteerBridgeHandle).steer === 'function'
  );
}

function toAcpPromptBlocks(prompt: ProviderPrompt): Array<Record<string, unknown>> {
  if (prompt.input.type === 'command') {
    const suffix = prompt.input.arguments ? ` ${prompt.input.arguments}` : '';
    return [{ type: 'text', text: `/${prompt.input.name}${suffix}` }];
  }
  return prompt.input.content.map(content => {
    if (content.type === 'text' || content.type === 'image') return content;
    return { type: 'text', text: JSON.stringify(content) };
  });
}

/** Reuse Paseo's native detail cards while keeping AGY execution, settings, and permission handling intact. */
export function createDetailedAgyProvider(
  options: DetailedAgyProviderBaseOptions,
  extra: DetailedAgyProviderOptions = {},
): ProviderRegistration {
  const defaultRoots = extra.defaultReadOnlyRoots ?? DEFAULT_READ_ONLY_ROOTS;
  const hasExplicitTransport = Boolean(options.command || options.connector);
  const baseOptions: RunAcpProviderOptions = options.connector
    ? {
        id: options.id,
        label: options.label,
        description: options.description,
        icon: options.icon,
        acpOptions: options.acpOptions,
        transformers: options.transformers,
        connector: options.connector,
      }
    : options.command
      ? {
          id: options.id,
          label: options.label,
          description: options.description,
          icon: options.icon,
          acpOptions: options.acpOptions,
          transformers: options.transformers,
          command: options.command,
        }
      : {
          id: options.id,
          label: options.label,
          description: options.description,
          icon: options.icon,
          acpOptions: options.acpOptions,
          transformers: options.transformers,
          connector: () => createAgyBridgeStream({ defaultReadOnlyRoots: defaultRoots }),
        };

  const base = runAcpProvider(baseOptions);
  return {
    ...base,
    async status(request) {
      if (options.connector) {
        return { available: true };
      }
      const configuredPath = (await extra.resolveConfiguredAgyPath?.()) ?? '';
      const resolved = resolveAgyBinary({
        configuredPath,
        env: { ...process.env, ...(request.launch?.env ?? {}) },
      });
      if (!resolved.found || !resolved.path) {
        return {
          available: false,
          diagnostic:
            'Antigravity CLI (agy) was not found. Install agy or configure its executable path in Antigravity ACP plugin settings.',
        };
      }
      return { available: true, diagnostic: `Using ${resolved.path}` };
    },
    async getCatalogCacheKey() {
      const configuredPath = (await extra.resolveConfiguredAgyPath?.()) ?? '';
      return `antigravity-acp:${configuredPath || process.env.PASEO_AGY_BIN || 'auto'}`;
    },
    async connect(request) {
      const details = new Map<string, Map<string, ProviderToolCallDetail>>();
      const replayTimestamps = new Map<string, HistoryTimestampMatcher>();
      const openRequests = new Map<string, string>();
      const runtimeEnv = (await extra.resolveRuntimeEnv?.()) ?? {};
      const pendingSessionEnvs: Record<string, string>[] = [];
      const activeBridges = new Set<SteerBridgeHandle>();
      let connectorSupportsSteer = !hasExplicitTransport;

      const wrappedConnector: AcpConnector | undefined = options.connector
        ? async () => {
            const stream = await options.connector!();
            if (isSteerBridge(stream)) {
              connectorSupportsSteer = true;
              activeBridges.add(stream);
            }
            return stream;
          }
        : undefined;

      const mergedLaunch =
        hasExplicitTransport && request.launch
          ? { ...request.launch, env: { ...runtimeEnv, ...request.launch.env } }
          : options.command
            ? {
                command: options.command[0],
                args: [...options.command.slice(1)],
                env: { ...process.env, ...runtimeEnv } as Record<string, string>,
              }
            : undefined;

      const enrichedTransformers: readonly AcpTransformer[] = [
        ...(options.transformers ?? []),
        {
          toolCall(snapshot, context) {
            const detail = toolDetail(snapshot);
            if (detail) {
              let session = details.get(context.sessionId);
              if (!session) {
                session = new Map();
                details.set(context.sessionId, session);
              }
              session.set(snapshot.id, detail);
            } else {
              details.get(context.sessionId)?.delete(snapshot.id);
            }
            return snapshot;
          },
        },
      ];

      const connectOptions: RunAcpProviderOptions = wrappedConnector
        ? {
            id: options.id,
            label: options.label,
            description: options.description,
            icon: options.icon,
            acpOptions: options.acpOptions,
            transformers: enrichedTransformers,
            connector: wrappedConnector,
          }
        : options.command
          ? {
              id: options.id,
              label: options.label,
              description: options.description,
              icon: options.icon,
              acpOptions: options.acpOptions,
              transformers: enrichedTransformers,
              command: options.command,
            }
          : {
              id: options.id,
              label: options.label,
              description: options.description,
              icon: options.icon,
              acpOptions: options.acpOptions,
              transformers: enrichedTransformers,
              connector: () => {
                const nextEnv =
                  pendingSessionEnvs.shift() ??
                  ({
                    ...process.env,
                    ...runtimeEnv,
                    ...(request.launch?.env ?? {}),
                    PASEO_AGY_NATIVE_FULL_ACCESS: '0',
                  } as Record<string, string>);
                const handle: AgyBridgeStream = createAgyBridgeStream({
                  env: nextEnv,
                  defaultReadOnlyRoots: defaultRoots,
                  onClose: () => {
                    activeBridges.delete(handle);
                  },
                });
                activeBridges.add(handle);
                return handle;
              },
            };

      const rawInner = await runAcpProvider(connectOptions).connect({
        ...request,
        ...(mergedLaunch ? { launch: mergedLaunch } : {}),
      });

      const steerEnabled = connectorSupportsSteer && request.capabilities.includes('prompt.steer');
      const connectionCapabilities =
        steerEnabled && !rawInner.capabilities.includes('prompt.steer')
          ? [...rawInner.capabilities, 'prompt.steer']
          : rawInner.capabilities;

      const bridgeListeners = new Set<(event: ProviderEvent) => void>();
      const steerSessions = new Map<string, { nativeSessionId?: string; activeTurnId: string | null }>();
      const emitBridgeEvent = (event: ProviderEvent) => {
        for (const listener of bridgeListeners) listener(event);
      };
      const unsubscribeRaw = rawInner.onEvent(rawEvent => {
        let event = rawEvent;
        if (event.type === 'session.opened') {
          steerSessions.set(event.sessionId, {
            nativeSessionId: readNativeSessionId(event.persistence),
            activeTurnId: null,
          });
          if (steerEnabled && !event.capabilities.includes('prompt.steer')) {
            event = { ...event, capabilities: [...event.capabilities, 'prompt.steer'] };
          }
        } else if (event.type === 'session.persistence') {
          const existing = steerSessions.get(event.sessionId);
          if (existing) existing.nativeSessionId = readNativeSessionId(event.persistence);
        } else if (event.type === 'session.prompt_result' && event.result.type === 'turn') {
          const existing = steerSessions.get(event.sessionId);
          if (existing) existing.activeTurnId = event.result.turnId;
        } else if (event.type === 'session.turn') {
          const existing = steerSessions.get(event.sessionId);
          if (existing) {
            if (event.state === 'started') existing.activeTurnId = event.turnId;
            else if (existing.activeTurnId === event.turnId) existing.activeTurnId = null;
          }
        } else if (event.type === 'session.closed' || event.type === 'session.runtime_failed') {
          steerSessions.delete(event.sessionId);
        }
        emitBridgeEvent(event);
      });

      const bridgeAwareInner: ProviderConnection = {
        version: rawInner.version,
        capabilities: connectionCapabilities,
        onEvent(listener) {
          bridgeListeners.add(listener);
          return () => {
            bridgeListeners.delete(listener);
          };
        },
        async close() {
          try {
            await rawInner.close();
          } finally {
            unsubscribeRaw();
            steerSessions.clear();
            activeBridges.clear();
            bridgeListeners.clear();
          }
        },
        async send(input) {
          if (input.type === 'session.open' && !hasExplicitTransport) {
            const freshEnv = (await extra.resolveRuntimeEnv?.()) ?? {};
            pendingSessionEnvs.push({
              ...process.env,
              ...freshEnv,
              ...(request.launch?.env ?? {}),
              ...input.config.env,
            } as Record<string, string>);
          }
          if (input.type === 'session.prompt' && input.prompt.delivery === 'steer') {
            const state = steerSessions.get(input.sessionId);
            const nativeId = state?.nativeSessionId;
            if (steerEnabled && nativeId && state.activeTurnId) {
              const bridge = [...activeBridges].find(candidate => candidate.canSteer(nativeId));
              if (bridge) {
                const accepted = await bridge.steer(nativeId, toAcpPromptBlocks(input.prompt));
                if (accepted && state.activeTurnId) {
                  emitBridgeEvent({
                    type: 'session.prompt_result',
                    sessionId: input.sessionId,
                    clientMessageId: input.prompt.clientMessageId,
                    result: { type: 'steer', turnId: state.activeTurnId },
                  });
                  return;
                }
              }
            }
            emitBridgeEvent({
              type: 'session.prompt_result',
              sessionId: input.sessionId,
              clientMessageId: input.prompt.clientMessageId,
              result: { type: 'completed' },
            });
            return;
          }
          return rawInner.send(input);
        },
      };

      const connection = withNativeFullAccess(bridgeAwareInner, {
        onSessionPersistence: extra.onSessionPersistence,
      });

      return {
        version: connection.version,
        capabilities: connection.capabilities,
        async send(input) {
          if (input.type === 'session.open') {
            const freshEnv = (await extra.resolveRuntimeEnv?.()) ?? {};
            const mergedConfigEnv = { ...freshEnv, ...input.config.env };
            replayTimestamps.delete(input.sessionId);
            openRequests.delete(input.requestId);
            if (input.history === 'replay') {
              const nativeSessionId = readNativeSessionId(input.persistence);
              if (nativeSessionId) {
                const lookupEnv = {
                  ...process.env,
                  ...(request.launch?.env ?? {}),
                  ...mergedConfigEnv,
                } as Record<string, string>;
                const matcher = await loadHistoryTimestampMatcher({
                  nativeSessionId,
                  env: lookupEnv,
                }).catch(() => null);
                if (matcher) {
                  replayTimestamps.set(input.sessionId, matcher);
                  openRequests.set(input.requestId, input.sessionId);
                }
              }
            }
            try {
              return await connection.send({
                ...input,
                config: {
                  ...input.config,
                  env: mergedConfigEnv,
                },
              });
            } catch (error) {
              replayTimestamps.delete(input.sessionId);
              openRequests.delete(input.requestId);
              throw error;
            }
          }
          return connection.send(input);
        },
        onEvent(listener) {
          return connection.onEvent(event => {
            if (event.type === 'timeline.item') {
              const detail =
                event.item.type === 'tool_call' ? details.get(event.sessionId)?.get(event.item.id) : undefined;
              const item =
                event.item.type === 'tool_call' && detail ? { ...event.item, detail } : event.item;
              const timestamp = event.timestamp ?? replayTimestamps.get(event.sessionId)?.match(item);
              if (item !== event.item || (timestamp && !event.timestamp)) {
                listener({
                  ...event,
                  item,
                  ...(timestamp && !event.timestamp ? { timestamp } : {}),
                });
                return;
              }
            }
            if (
              event.type === 'session.opened' ||
              event.type === 'session.ready' ||
              event.type === 'session.closed' ||
              event.type === 'session.runtime_failed'
            ) {
              replayTimestamps.delete(event.sessionId);
              if ('requestId' in event && typeof event.requestId === 'string') {
                openRequests.delete(event.requestId);
              }
            } else if (event.type === 'request.failed') {
              const failedSessionId = openRequests.get(event.requestId);
              if (failedSessionId) {
                replayTimestamps.delete(failedSessionId);
                openRequests.delete(event.requestId);
              }
            }
            if (
              event.type === 'session.ready' ||
              event.type === 'session.closed' ||
              event.type === 'session.runtime_failed' ||
              (event.type === 'session.turn' && event.state !== 'started')
            ) {
              details.delete(event.sessionId);
            }
            listener(event);
          });
        },
        async close() {
          try {
            await connection.close();
          } finally {
            details.clear();
            replayTimestamps.clear();
            openRequests.clear();
          }
        },
      };
    },
  };
}
