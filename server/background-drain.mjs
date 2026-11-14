import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { TranscriptTail, BackgroundProjection } from './background-transcript.mjs';
import { APPROVAL_SENSITIVE_TOOLS, UUID_RE, inspectSwarmContinuation } from './swarm-state.mjs';

function wait(ms, signal) {
  return new Promise(resolvePromise => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolvePromise();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

async function readLastTranscriptRow(path) {
  let file;
  try {
    file = await open(path, 'r');
    const info = await file.stat();
    if (info.size === 0) return null;
    const size = Math.min(info.size, 256 * 1024);
    const buffer = Buffer.alloc(size);
    await file.read(buffer, 0, size, info.size - size);
    let text = buffer.toString('utf8');
    if (size < info.size) text = text.slice(text.indexOf('\n') + 1);
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]);
      } catch {}
    }
    return null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    await file?.close();
  }
}

export class BackgroundDrain {
  constructor({
    emit,
    dataDir,
    pollMs = 250,
    settleMs = 750,
    timeoutMs = 60 * 60 * 1000,
    approvalStallMs = 30000,
    subagentFailureGraceMs = 5000,
    swarmWakeupGraceMs = 15000,
    nativeFull = process.env.PASEO_AGY_NATIVE_FULL_ACCESS === '1',
  }) {
    this.emit = emit;
    this.dataDir =
      dataDir ??
      resolve(
        process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
          join(
            process.env.HOME || process.env.USERPROFILE || homedir(),
            '.gemini',
            process.env.ANTIGRAVITY_CONFIG_REL_DIR || 'antigravity-cli',
          ),
      );
    this.pollMs = pollMs;
    this.settleMs = settleMs;
    this.timeoutMs = timeoutMs;
    this.approvalStallMs = approvalStallMs;
    this.subagentFailureGraceMs = subagentFailureGraceMs;
    this.swarmWakeupGraceMs = swarmWakeupGraceMs;
    this.nativeFull = nativeFull;
    this.requests = new Map();
    this.permissions = new Map();
    this.sessions = new Map();
    this.closed = false;
  }

  async inspectActiveSubagents(subIds = []) {
    let awaitingApproval = false;
    let terminalFailure;
    for (const subId of subIds) {
      const last = await readLastTranscriptRow(
        join(this.dataDir, 'brain', subId, '.system_generated/logs/transcript.jsonl'),
      );
      if (!last) continue;
      if (last.status === 'ERROR' && (last.type === 'ERROR_MESSAGE' || last.type === 'PLANNER_RESPONSE')) {
        terminalFailure ??= last.error || last.content || `AGY subagent ${subId} failed`;
      } else if (
        last.type === 'PLANNER_RESPONSE' &&
        (last.tool_calls ?? []).some(call => APPROVAL_SENSITIVE_TOOLS.has(call.name))
      ) {
        awaitingApproval = true;
      }
    }
    return { awaitingApproval, terminalFailure };
  }

  async fromClient(message) {
    if (!message.method) {
      if ('id' in message) this.permissions.delete(message.id);
      return message;
    }
    const params = message.params ?? {};
    if (['session/cancel', 'session/close'].includes(message.method)) {
      this.sessions.get(params.sessionId)?.round?.controller.abort();
    }
    if (message.method === 'session/prompt' && UUID_RE.test(params.sessionId ?? '')) {
      const session = this.sessions.get(params.sessionId) ?? {};
      if (session.round) throw new Error('AGY already has an active foreground or background turn');
      const tail = new TranscriptTail(
        join(this.dataDir, 'brain', params.sessionId, '.system_generated/logs/transcript.jsonl'),
      );
      await tail.begin();
      if (this.closed) throw new Error('AGY background bridge is closed');
      session.round = {
        tail,
        projection: new BackgroundProjection(params.sessionId, this.emit),
        controller: new AbortController(),
      };
      this.sessions.set(params.sessionId, session);
    }
    if ('id' in message) this.requests.set(message.id, { method: message.method, sessionId: params.sessionId });
    return message;
  }

  async fromAgent(message) {
    if (message.method === 'session/request_permission' && 'id' in message) {
      this.permissions.set(message.id, message.params?.sessionId);
    }
    if (message.method === 'session/update') {
      this.sessions.get(message.params?.sessionId)?.round?.projection.observe(message.params.update);
    }
    if (!('id' in message) || message.method) return message;
    const request = this.requests.get(message.id);
    this.requests.delete(message.id);
    if (request?.method !== 'session/prompt') return message;
    const session = this.sessions.get(request.sessionId);
    const round = session?.round;
    if (!round) return message;
    try {
      if (message.error || message.result?.stopReason !== 'end_turn') return message;
      if (round.controller.signal.aborted) {
        return { ...message, result: { ...message.result, stopReason: 'cancelled' } };
      }
      round.projection.add(await round.tail.read());
      let state = round.projection.inspect();
      let swarmState = await inspectSwarmContinuation({
        dataDir: this.dataDir,
        sessionId: request.sessionId,
        wakeupGraceMs: this.swarmWakeupGraceMs,
      });
      if (!state.seenBackground && !swarmState.active) return message;
      const deadline = Date.now() + this.timeoutMs;
      let idleSince;
      let approvalStallSince;
      let subagentFailureSince;
      while (!round.controller.signal.aborted) {
        state = round.projection.inspect({ publish: true });
        if (state.foreignInput) return { ...message, result: { ...message.result, stopReason: 'cancelled' } };
        if (state.failure) throw new Error(state.failure);
        swarmState = await inspectSwarmContinuation({
          dataDir: this.dataDir,
          sessionId: request.sessionId,
          wakeupGraceMs: this.swarmWakeupGraceMs,
        });
        const subStatus = await this.inspectActiveSubagents(state.activeSubagents);
        if (subStatus.terminalFailure) {
          subagentFailureSince ??= Date.now();
          if (Date.now() - subagentFailureSince >= this.subagentFailureGraceMs) {
            throw new Error(subStatus.terminalFailure);
          }
        } else {
          subagentFailureSince = undefined;
        }
        const hasPendingAcpPermission = [...this.permissions.values()].includes(request.sessionId);
        const needsApprovalChannel =
          !this.nativeFull &&
          !hasPendingAcpPermission &&
          ((state.awaitingCommandStart && state.pendingTasks === 0) ||
            subStatus.awaitingApproval ||
            Boolean(swarmState.awaitingApproval));
        if (needsApprovalChannel) {
          approvalStallSince ??= Date.now();
          if (Date.now() - approvalStallSince >= this.approvalStallMs) {
            throw new Error(
              'AGY background command or Swarm worker has not returned progress or an ACP approval request. It may be blocked by native background approval; no permission was granted. Resume approval-sensitive work in the foreground or explicitly select Full access when idle.',
            );
          }
        } else {
          approvalStallSince = undefined;
        }
        if (state.coordinatorSettled && !swarmState.active) {
          idleSince ??= Date.now();
          if (Date.now() - idleSince >= this.settleMs) {
            const result = structuredClone(message);
            if (result.result.usage) {
              for (const [key, delta] of Object.entries(state.extraUsage)) {
                if (typeof result.result.usage[key] === 'number') result.result.usage[key] += delta;
              }
            }
            return result;
          }
        } else {
          idleSince = undefined;
        }
        if (Date.now() >= deadline) {
          throw new Error('Timed out waiting for AGY background work to finish; its final result has not been confirmed');
        }
        await wait(this.pollMs, round.controller.signal);
        round.projection.add(await round.tail.read());
      }
      return { ...message, result: { ...message.result, stopReason: 'cancelled' } };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: `AGY background continuation failed: ${error.message}` },
      };
    } finally {
      if (session.round === round) session.round = null;
    }
  }

  permissionResolved(id) {
    this.permissions.delete(id);
  }

  close() {
    this.closed = true;
    for (const session of this.sessions.values()) session.round?.controller.abort();
    this.sessions.clear();
    this.requests.clear();
    this.permissions.clear();
  }
}
