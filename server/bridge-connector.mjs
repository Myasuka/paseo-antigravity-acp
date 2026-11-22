import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { AccessPolicy } from './access-policy.mjs';
import { BackgroundDrain } from './background-drain.mjs';
import { normalizeMcpServersMessage } from './mcp-normalize.mjs';
import { mergeReadOnlyRoots, parseExtraReadRoots, resolveAgyBinary } from './resolve-agy.mjs';
import { SessionMetadata } from './session-metadata.mjs';
import { preserveToolContent } from './tool-content.mjs';

function killChildTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to direct child signal if process group already exited.
    }
  }
  try {
    child.kill(signal);
  } catch {}
}

export function createAgyBridgeStream({ env = process.env, defaultReadOnlyRoots = [], onClose } = {}) {
  let baseRoots = defaultReadOnlyRoots;
  if (env.PASEO_AGY_READ_POLICY_FILE) {
    const rules = JSON.parse(readFileSync(env.PASEO_AGY_READ_POLICY_FILE, 'utf8'));
    if (!Array.isArray(rules.readOnlyRoots) || !rules.readOnlyRoots.every(root => typeof root === 'string')) {
      throw new Error('Invalid read-only policy');
    }
    baseRoots = rules.readOnlyRoots;
  }
  const extraRoots = parseExtraReadRoots(env.PASEO_AGY_EXTRA_READ_ROOTS);
  const policy = new AccessPolicy(mergeReadOnlyRoots(baseRoots, extraRoots));

  const metadata = new SessionMetadata({
    progressUpdates: env.PASEO_AGY_PROGRESS_UPDATES !== '0',
    backgroundApprovals: env.PASEO_AGY_NATIVE_FULL_ACCESS !== '1',
  });

  const backgroundTimeout = Number(env.PASEO_AGY_BACKGROUND_TIMEOUT_MS ?? 3600000);
  if (!Number.isInteger(backgroundTimeout) || backgroundTimeout < 1000 || backgroundTimeout > 86400000) {
    throw new Error('PASEO_AGY_BACKGROUND_TIMEOUT_MS must be between 1000 and 86400000');
  }
  const cancelTimeout = Number(env.PASEO_AGY_CANCEL_TIMEOUT_MS ?? 30000);
  if (!Number.isInteger(cancelTimeout) || cancelTimeout < 0 || cancelTimeout > 600000) {
    throw new Error('PASEO_AGY_CANCEL_TIMEOUT_MS must be between 0 and 600000');
  }

  const resolved = resolveAgyBinary({ env });
  if (!resolved.found || !resolved.path) {
    throw new Error(
      `Antigravity CLI (agy) executable not found. Checked: ${resolved.checked.join(', ') || 'PATH and standard locations'}`,
    );
  }

  const args = ['acp', '--process-per-session'];
  if (env.PASEO_AGY_NATIVE_FULL_ACCESS === '1') {
    args.push('--dangerously-skip-permissions');
  }

  const child = spawn(resolved.path, args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  child.stderr?.on('data', () => undefined);

  let readableController = null;
  let streamClosed = false;
  let stopping = false;
  let killTimer = null;

  const writeChild = message => {
    if (child.stdin && !child.stdin.destroyed && !stopping) {
      child.stdin.write(JSON.stringify(message) + '\n');
    }
  };

  const enqueueDownstream = message => {
    if (streamClosed || !readableController) return;
    try {
      readableController.enqueue(message);
    } catch {
      streamClosed = true;
    }
  };

  const closeDownstream = () => {
    if (streamClosed) return;
    streamClosed = true;
    try {
      readableController?.close();
    } catch {}
  };

  const errorDownstream = err => {
    if (streamClosed) return;
    streamClosed = true;
    try {
      readableController?.error(err);
    } catch {}
  };

  const deliver = message => {
    if (!message) return;
    const result = policy.fromAgent(metadata.fromAgent(preserveToolContent(message)));
    if (result.upstream) {
      background.permissionResolved(result.upstream.id);
      if (env.PASEO_AGY_POLICY_AUDIT) {
        appendFileSync(
          env.PASEO_AGY_POLICY_AUDIT,
          JSON.stringify({ event: 'automatic-permission', reason: result.reason }) + '\n',
        );
      }
      writeChild(result.upstream);
    }
    if (result.downstream) {
      enqueueDownstream(result.downstream);
    }
  };

  const background = new BackgroundDrain({
    emit: deliver,
    writeUpstream: writeChild,
    dataDir: env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || undefined,
    timeoutMs: backgroundTimeout,
    cancelTimeoutMs: cancelTimeout,
    onCancelTimeout: () => {
      const timer = setTimeout(stop, 25);
      timer.unref?.();
    },
    nativeFull: env.PASEO_AGY_NATIVE_FULL_ACCESS === '1',
  });

  const rl = createInterface({ input: child.stdout });

  const stop = () => {
    if (stopping) return;
    stopping = true;
    background.close();
    try {
      onClose?.();
    } catch {}
    try {
      rl.close();
    } catch {}
    if (child.exitCode === null && child.signalCode === null) {
      killChildTree(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          killChildTree(child, 'SIGKILL');
        }
      }, 2000);
      killTimer.unref?.();
    }
    closeDownstream();
  };

  let agentQueue = Promise.resolve();
  rl.on('line', line => {
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      agentQueue = agentQueue.then(() => {
        if (stopping || streamClosed) return;
        errorDownstream(err instanceof Error ? err : new Error('Invalid agent ACP JSON'));
        stop();
      });
      return;
    }
    if (background.isDeferredPromptResponse(parsed)) {
      // Wait for prior ordered notifications, then run long background/Swarm drain off agentQueue
      // so steer updates, steer responses, and interactive permissions never deadlock.
      void agentQueue.then(async () => {
        if (stopping || streamClosed) return;
        try {
          deliver(await background.fromAgent(parsed));
        } catch (err) {
          errorDownstream(err instanceof Error ? err : new Error('Invalid agent ACP JSON'));
          stop();
        }
      });
      return;
    }
    agentQueue = agentQueue.then(async () => {
      if (stopping || streamClosed) return;
      try {
        deliver(await background.fromAgent(parsed));
      } catch (err) {
        errorDownstream(err instanceof Error ? err : new Error('Invalid agent ACP JSON'));
        stop();
      }
    });
  });

  child.on('error', err => {
    errorDownstream(err);
    stop();
  });

  child.on('close', () => {
    background.close();
    if (killTimer) clearTimeout(killTimer);
    closeDownstream();
  });

  child.stdin?.on('error', () => {
    stop();
  });

  const readable = new ReadableStream({
    start(controller) {
      readableController = controller;
    },
    cancel() {
      stop();
    },
  });

  const writable = new WritableStream({
    async write(message) {
      try {
        const next = await background.fromClient(
          normalizeMcpServersMessage(metadata.fromClient(policy.fromClient(message))),
        );
        writeChild(next);
      } catch (error) {
        if (message && typeof message === 'object' && 'id' in message && message.id !== undefined) {
          deliver({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
          });
        } else {
          throw error;
        }
      }
    },
    close() {
      stop();
    },
    abort() {
      stop();
    },
  });

  return {
    readable,
    writable,
    canSteer: sessionId => background.canSteer(sessionId),
    steer: (sessionId, prompt) => background.steer(sessionId, prompt),
  };
}
