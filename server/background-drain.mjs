import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { TranscriptTail, BackgroundProjection, signature } from './background-transcript.mjs';
import {
  APPROVAL_SENSITIVE_TOOLS,
  DEFAULT_SWARM_WORKER_STALE_MS,
  UUID_RE,
  inspectSwarmContinuation,
} from './swarm-state.mjs';

const STALE_PASS_THROUGH_UPDATES = new Set([
  'available_commands_update',
  'usage_update',
  'session_info_update',
  'current_mode_update',
  'config_option_update',
]);

// Post-load metadata updates that should flush after LOAD_RES (and after
// AcpRuntime exits replayWindow) rather than before LOAD_RES where
// history:"skip" would drop them. Excludes current_mode_update and
// config_option_update so pre-load notifications cannot race applyInitialConfig().
const DEFERRED_LOAD_META_UPDATES = new Set([
  'available_commands_update',
  'usage_update',
  'session_info_update',
]);

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

function formatProgressBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  if (bytes < 1024 * 1024) {
    const kb = (bytes / 1024).toFixed(1).replace(/\.0$/, '');
    return `${kb}KB`;
  }
  const mb = (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
  return `${mb}MB`;
}

function formatActivityClock(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  const pad = value => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatSwarmProgress(progress, { phase = 'running', note } = {}) {
  if (!progress) {
    const cleanNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 110) : '';
    const label = phase === 'failed' ? `Failed · ${cleanNote || 'Swarm continuation failed'}` : 'Settled';
    const text = cleanNote ? `Swarm status: ${label}\n${cleanNote}` : `Swarm status: ${label}`;
    const key = `empty:${phase}:${cleanNote}`;
    return { label: label.slice(0, 140), text, structuralKey: key, digest: key };
  }

  const clock = formatActivityClock(progress.lastActivityMs);
  const workers = Array.isArray(progress.workers) ? progress.workers : [];
  const activeWorkers = workers.filter(worker => worker.status === 'active');
  const staleWorkers = workers.filter(worker => worker.status === 'stale');
  const waitingWorkers = workers.filter(worker => worker.status === 'waiting');

  const summaryParts = [];
  if (phase === 'settled') {
    summaryParts.push('Settled');
    if (progress.waitingCount > 0) summaryParts.push(`${progress.waitingCount} waiting`);
    if (progress.headSeq > 0) summaryParts.push(`#${progress.headSeq}`);
  } else if (phase === 'paused') {
    summaryParts.push('Guidance sent');
    if (progress.activeCount > 0) summaryParts.push(`${progress.activeCount} active`);
    if (progress.headSeq > 0) summaryParts.push(`#${progress.headSeq}`);
  } else if (phase === 'failed') {
    summaryParts.push('Failed');
    summaryParts.push((note ?? 'Swarm continuation failed').trim().slice(0, 96));
  } else {
    if (progress.awaitingApproval) summaryParts.push('Approval needed');
    if (progress.activeCount > 0) summaryParts.push(`${progress.activeCount} active`);
    else if (progress.hasPendingWakeup) summaryParts.push('Waking coordinator');
    else summaryParts.push('Waiting');
    if (progress.waitingCount > 0) summaryParts.push(`${progress.waitingCount} waiting`);
    if (progress.staleCount > 0) summaryParts.push(`${progress.staleCount} stale`);
    if (progress.headSeq > 0) summaryParts.push(`#${progress.headSeq}`);
    if (activeWorkers.length > 0) {
      const preview = activeWorkers.slice(0, 2).map(worker => {
        const bytesLabel = formatProgressBytes(worker.taskLogBytes);
        const hint = worker.activity
          ? worker.activity.replace(/^run_command(?:\s*\([^)]+\))?:\s*/i, '').trim().slice(0, 28)
          : '';
        if (hint && bytesLabel) return `@${worker.name} (${hint} · ${bytesLabel})`;
        if (bytesLabel) return `@${worker.name} (${bytesLabel})`;
        if (hint) return `@${worker.name} (${hint})`;
        return `@${worker.name}`;
      });
      const extra = activeWorkers.length > 2 ? ` +${activeWorkers.length - 2}` : '';
      summaryParts.push(preview.join(', ') + extra);
    }
    if (clock) summaryParts.push(clock);
  }
  const label = summaryParts.join(' · ').slice(0, 140);

  const workerMeta = worker => {
    const meta = [];
    const bytesLabel = formatProgressBytes(worker.taskLogBytes);
    if (bytesLabel) meta.push(`log ${bytesLabel}`);
    else if (worker.steps > 0) meta.push(`step ${worker.steps}`);
    const workerClock = formatActivityClock(worker.lastActivityMs);
    if (workerClock) meta.push(workerClock);
    return meta.length > 0 ? ` [${meta.join(', ')}]` : '';
  };

  const headerMeta = [
    `board #${progress.headSeq ?? 0}`,
    clock ? `last activity ${clock}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  const lines = [`Swarm${progress.title ? `: ${progress.title}` : ''} (${headerMeta})`];
  if (phase === 'failed' && note) {
    lines.push(`Error: ${note}`);
  }
  if (activeWorkers.length > 0) {
    lines.push(`Active (${activeWorkers.length}):`);
    for (const worker of activeWorkers) {
      const detail = worker.activity ?? (worker.awaitingApproval ? 'awaiting approval' : 'working');
      lines.push(`- @${worker.name}: ${detail}${workerMeta(worker)}`);
    }
  }
  if (staleWorkers.length > 0) {
    lines.push(`Stale (${staleWorkers.length}):`);
    for (const worker of staleWorkers) {
      const detail = worker.failure ? `error: ${worker.failure}` : (worker.activity ?? 'idle without progress');
      lines.push(`- @${worker.name}: [stale] ${detail}${workerMeta(worker)}`);
    }
  }
  if (waitingWorkers.length > 0) {
    const withFailures = waitingWorkers.filter(worker => worker.failure);
    if (withFailures.length > 0) {
      lines.push(`Waiting (${waitingWorkers.length}):`);
      for (const worker of waitingWorkers) {
        lines.push(`- @${worker.name}: ${worker.failure ? `error: ${worker.failure}` : 'waiting'}${workerMeta(worker)}`);
      }
    } else {
      lines.push(`Waiting (${waitingWorkers.length}): ${waitingWorkers.map(worker => `@${worker.name}`).join(', ')}`);
    }
  }
  if (progress.latestPost) {
    const ch =
      progress.latestPost.channel && progress.latestPost.channel !== 'main' ? ` #${progress.latestPost.channel}` : '';
    lines.push(
      `Latest board (#${progress.latestPost.seq} @${progress.latestPost.agent}${ch}): ${progress.latestPost.preview}`,
    );
  }

  const structuralKey = [
    phase,
    progress.activeCount,
    progress.waitingCount,
    progress.staleCount,
    progress.hasPendingWakeup,
    progress.awaitingApproval,
    progress.headSeq,
    workers
      .map(worker => `${worker.name}:${worker.status}:${worker.activity ?? ''}:${worker.failure ?? ''}`)
      .join(','),
  ].join('|');

  const digest = [
    structuralKey,
    workers
      .map(
        worker =>
          `${worker.name}:${worker.steps}:${Math.floor((worker.taskLogBytes ?? 0) / 1024)}:${worker.lastActivityMs ? Math.floor(worker.lastActivityMs / 1000) : 0}`,
      )
      .join(','),
  ].join('|');

  return {
    label,
    text: lines.join('\n'),
    structuralKey,
    digest,
  };
}

async function readLastTranscriptRowFromPath(path) {
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

async function readLastTranscriptRow(path) {
  const fullPath = /transcript\.jsonl$/.test(path) ? path.replace(/transcript\.jsonl$/, 'transcript_full.jsonl') : null;
  if (fullPath && fullPath !== path) {
    const fullRow = await readLastTranscriptRowFromPath(fullPath);
    if (fullRow) return fullRow;
  }
  return readLastTranscriptRowFromPath(path);
}

export class BackgroundDrain {
  constructor({
    emit,
    writeUpstream = null,
    dataDir,
    pollMs = 250,
    settleMs = 750,
    timeoutMs = 60 * 60 * 1000,
    approvalStallMs = 30000,
    subagentFailureGraceMs = 5000,
    swarmWakeupGraceMs = 15000,
    swarmWorkerStaleMs = DEFAULT_SWARM_WORKER_STALE_MS,
    preExistingSwarmWorkerStaleMs = 2 * 60 * 1000,
    swarmProgressThrottleMs = 1500,
    nativeFull = process.env.PASEO_AGY_NATIVE_FULL_ACCESS === '1',
    loadSettleMs = 400,
    loadMaxWaitMs = 15000,
    loadMetaFlushDelayMs = 15,
  }) {
    this.emit = emit;
    this.writeUpstream = typeof writeUpstream === 'function' ? writeUpstream : null;
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
    this.swarmWorkerStaleMs = swarmWorkerStaleMs;
    this.preExistingSwarmWorkerStaleMs = preExistingSwarmWorkerStaleMs;
    this.swarmProgressThrottleMs = swarmProgressThrottleMs;
    this.nativeFull = nativeFull;
    this.loadSettleMs = loadSettleMs;
    this.loadMaxWaitMs = loadMaxWaitMs;
    this.loadMetaFlushDelayMs = loadMetaFlushDelayMs;
    this.requests = new Map();
    this.steerRequests = new Map();
    this.steerSeq = 0;
    this.roundSeq = 0;
    this.permissions = new Map();
    this.sessions = new Map();
    this.agentLane = Promise.resolve();
    this.closed = false;
  }

  isDeferredPromptResponse(message) {
    return Boolean(
      message &&
        !message.method &&
        'id' in message &&
        this.requests.get(message.id)?.method === 'session/prompt',
    );
  }

  canSteer(sessionId) {
    if (this.closed || !this.writeUpstream) return false;
    const round = this.sessions.get(sessionId)?.round;
    if (!round || !round.draining || round.controller.signal.aborted || round.steerInFlight) {
      return false;
    }
    for (const permSessionId of this.permissions.values()) {
      if (permSessionId === sessionId) return false;
    }
    return true;
  }

  updateSwarmProgressCard(sessionId, round, swarmState, nowMs = Date.now()) {
    if (!swarmState?.exists || !swarmState.progress) return;
    const progress = swarmState.progress;
    const formatted = formatSwarmProgress(progress, { phase: 'running' });
    if (!round.swarmProgress) {
      const toolCallId = `agy:${sessionId}:swarm-progress:${round.id}:${++round.progressCardSeq}`;
      round.swarmProgress = {
        toolCallId,
        lastDigest: formatted.digest,
        lastStructuralKey: formatted.structuralKey,
        lastEmittedAt: nowMs,
      };
      this.emit({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            name: 'swarm_progress',
            title: 'Swarm progress',
            kind: 'other',
            status: 'in_progress',
            rawInput: {
              label: formatted.label,
              active: progress.activeCount,
              waiting: progress.waitingCount,
              headSeq: progress.headSeq,
            },
            rawOutput: { output: formatted.text, label: formatted.label },
          },
        },
      });
      return;
    }
    const entry = round.swarmProgress;
    if (formatted.digest === entry.lastDigest) return;
    const structuralChange = formatted.structuralKey !== entry.lastStructuralKey;
    if (!structuralChange && nowMs - entry.lastEmittedAt < this.swarmProgressThrottleMs) {
      return;
    }
    entry.lastDigest = formatted.digest;
    entry.lastStructuralKey = formatted.structuralKey;
    entry.lastEmittedAt = nowMs;
    this.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: entry.toolCallId,
          status: 'in_progress',
          rawInput: {
            label: formatted.label,
            active: progress.activeCount,
            waiting: progress.waitingCount,
            headSeq: progress.headSeq,
          },
          rawOutput: { output: formatted.text, label: formatted.label },
        },
      },
    });
  }

  finalizeSwarmProgressCard(sessionId, round, swarmState, { status = 'completed', phase = 'settled', note } = {}) {
    if (!round?.swarmProgress) return;
    const entry = round.swarmProgress;
    round.swarmProgress = null;
    const progress = swarmState?.progress ?? null;
    const formatted = formatSwarmProgress(progress, { phase, note });
    this.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: entry.toolCallId,
          status,
          rawInput: {
            label: formatted.label,
            ...(progress
              ? { active: progress.activeCount, waiting: progress.waitingCount, headSeq: progress.headSeq }
              : {}),
          },
          rawOutput: { output: formatted.text, label: formatted.label },
        },
      },
    });
  }

  async steer(sessionId, promptBlocks) {
    if (!this.canSteer(sessionId)) return false;
    const session = this.sessions.get(sessionId);
    const round = session?.round;
    if (!round) return false;
    const steerId = `agy-steer:${++this.steerSeq}`;
    round.steerInFlight = { id: steerId, startedAt: Date.now() };
    let preSteerUserInputs = 0;
    try {
      round.projection.add(await round.tail.read());
      if (this.closed || session.round !== round || !round.draining || round.controller.signal.aborted) {
        round.steerInFlight = null;
        return false;
      }
      round.projection.inspect({ publish: true });
      for (const row of round.projection.rows.values()) {
        if (row.type === 'USER_INPUT') preSteerUserInputs++;
      }
    } catch {
      round.steerInFlight = null;
      return false;
    }

    const steerMeta = { sessionId, round, preSteerUserInputs };
    this.steerRequests.set(steerId, steerMeta);
    try {
      this.writeUpstream({
        jsonrpc: '2.0',
        id: steerId,
        method: 'session/prompt',
        params: { sessionId, prompt: promptBlocks },
      });
    } catch {
      this.steerRequests.delete(steerId);
      round.steerInFlight = null;
      return false;
    }

    round.steered = true;
    round.projection.beginSteer();
    if (round.swarmProgress) {
      this.finalizeSwarmProgressCard(sessionId, round, round.lastSwarmState, {
        status: 'completed',
        phase: 'paused',
      });
    }
    this.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: '' },
        },
      },
    });
    return true;
  }

  ensureSession(sessionId) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        round: null,
        suppressedToolIds: new Set(),
        staleReplay: null,
        pendingLoad: null,
        deferredMetaFlush: null,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  cancelPendingLoad(session) {
    const pending = session?.pendingLoad;
    if (!pending) return;
    if (pending.settleTimer) clearTimeout(pending.settleTimer);
    if (pending.maxTimer) clearTimeout(pending.maxTimer);
    pending.settleTimer = null;
    pending.maxTimer = null;
    session.pendingLoad = null;
  }

  cancelDeferredMetaFlush(session) {
    const deferred = session?.deferredMetaFlush;
    if (!deferred) return;
    if (deferred.timer) clearTimeout(deferred.timer);
    deferred.timer = null;
    session.deferredMetaFlush = null;
  }

  flushDeferredMeta(session) {
    const deferred = session?.deferredMetaFlush;
    if (!deferred) return;
    if (deferred.timer) clearTimeout(deferred.timer);
    session.deferredMetaFlush = null;
    if (this.closed) return;
    for (const meta of deferred.items) {
      this.emit(meta);
    }
  }

  armPendingLoadSettleTimer(sessionId, pending) {
    if (pending.settleTimer) clearTimeout(pending.settleTimer);
    const expectedGen = pending.generation;
    pending.settleTimer = setTimeout(() => {
      pending.settleTimer = null;
      const run = this.agentLane.then(() => {
        const session = this.sessions.get(sessionId);
        if (this.closed || !session || session.pendingLoad !== pending || pending.generation !== expectedGen) {
          return;
        }
        this.flushPendingLoad(session);
      });
      this.agentLane = run.catch(() => undefined);
    }, this.loadSettleMs);
  }

  holdPendingLoad(sessionId, session, response) {
    this.cancelPendingLoad(session);
    this.cancelDeferredMetaFlush(session);
    const pending = {
      sessionId,
      response,
      deferredMeta: new Map(),
      generation: 0,
      settleTimer: null,
      maxTimer: null,
    };
    session.pendingLoad = pending;
    this.armPendingLoadSettleTimer(sessionId, pending);
    if (this.loadMaxWaitMs > 0) {
      pending.maxTimer = setTimeout(() => {
        pending.maxTimer = null;
        const run = this.agentLane.then(() => {
          const currentSession = this.sessions.get(sessionId);
          if (this.closed || !currentSession || currentSession.pendingLoad !== pending) {
            return;
          }
          this.flushPendingLoad(currentSession);
        });
        this.agentLane = run.catch(() => undefined);
      }, this.loadMaxWaitMs);
    }
  }

  flushPendingLoad(session, { immediateMeta = false } = {}) {
    const pending = session?.pendingLoad;
    if (!pending) return;
    this.cancelPendingLoad(session);
    if (this.closed) return;
    this.emit(pending.response);
    const metaMessages = [...pending.deferredMeta.values()];
    if (metaMessages.length === 0) return;
    if (immediateMeta || this.loadMetaFlushDelayMs <= 0) {
      for (const meta of metaMessages) {
        this.emit(meta);
      }
      return;
    }
    const deferred = {
      items: metaMessages,
      timer: null,
    };
    deferred.timer = setTimeout(() => {
      if (session.deferredMetaFlush === deferred) {
        this.flushDeferredMeta(session);
      }
    }, this.loadMetaFlushDelayMs);
    session.deferredMetaFlush = deferred;
  }

  recordRoundReplay(session, round) {
    if (!session || !round) return;
    const snap = round.projection.takeStaleReplaySnapshot();
    for (const toolId of snap.closedForegroundToolIds) {
      session.suppressedToolIds.add(toolId);
    }
    while (session.suppressedToolIds.size > 512) {
      const oldest = session.suppressedToolIds.values().next().value;
      if (oldest === undefined) break;
      session.suppressedToolIds.delete(oldest);
    }
    if (snap.thoughts.length || snap.messages.length || snap.toolSigs.length) {
      session.staleReplay = {
        active: true,
        thoughts: [...snap.thoughts],
        thoughtBuf: '',
        thoughtTemplate: null,
        messages: [...snap.messages],
        messageBuf: '',
        messageTemplate: null,
        toolSigs: [...snap.toolSigs],
      };
    } else {
      session.staleReplay = null;
    }
  }

  filterStaleReplay(session, sessionId, update) {
    if (!session || !update) return false;
    if (
      (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
      session.suppressedToolIds.has(update.toolCallId)
    ) {
      return true;
    }
    const stale = session.staleReplay;
    if (!stale?.active) return false;
    if (STALE_PASS_THROUGH_UPDATES.has(update.sessionUpdate)) return false;

    const flushBufferedKind = kind => {
      const queue = kind === 'thought' ? stale.thoughts : stale.messages;
      const bufKey = kind === 'thought' ? 'thoughtBuf' : 'messageBuf';
      const templateKey = kind === 'thought' ? 'thoughtTemplate' : 'messageTemplate';
      const buf = stale[bufKey];
      const template = stale[templateKey];
      stale[bufKey] = '';
      stale[templateKey] = null;
      if (!buf) return;
      if (queue[0] !== undefined && queue[0].trim() === buf.trim()) {
        queue.shift();
        return;
      }
      if (template) {
        this.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId, update: { ...template, content: { type: 'text', text: buf } } },
        });
      }
      stale.active = false;
    };

    const flushBufferedPrefixes = excludeKind => {
      if (excludeKind !== 'thought' && stale.thoughtBuf) flushBufferedKind('thought');
      if (excludeKind !== 'message' && stale.messageBuf) flushBufferedKind('message');
    };

    const checkDone = () => {
      if (
        !stale.thoughts.length &&
        !stale.messages.length &&
        !stale.toolSigs.length &&
        !stale.thoughtBuf &&
        !stale.messageBuf
      ) {
        stale.active = false;
      }
    };

    if (update.sessionUpdate === 'agent_thought_chunk' || update.sessionUpdate === 'agent_message_chunk') {
      const kind = update.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'message';
      flushBufferedPrefixes(kind);
      if (!stale.active) return false;

      const queue = kind === 'thought' ? stale.thoughts : stale.messages;
      const bufKey = kind === 'thought' ? 'thoughtBuf' : 'messageBuf';
      const templateKey = kind === 'thought' ? 'thoughtTemplate' : 'messageTemplate';
      const chunkText = update.content?.type === 'text' ? update.content.text : '';
      if (!chunkText) return true;

      if (!stale[bufKey]) {
        const idx = queue.findIndex(
          target => target === chunkText || target.trim() === chunkText.trim() || target.startsWith(chunkText),
        );
        if (idx !== -1) queue.splice(0, idx);
      }

      const target = queue[0];
      if (target !== undefined) {
        const next = stale[bufKey] + chunkText;
        if (target === next || (next.length >= target.trim().length && target.trim() === next.trim())) {
          queue.shift();
          stale[bufKey] = '';
          stale[templateKey] = null;
          checkDone();
          return true;
        }
        if (target.startsWith(next)) {
          stale[bufKey] = next;
          stale[templateKey] ??= update;
          return true;
        }
      }

      flushBufferedKind(kind);
      stale.active = false;
      return false;
    }

    if (update.sessionUpdate === 'tool_call') {
      flushBufferedPrefixes(null);
      if (!stale.active) return false;
      const sig = signature(update.name ?? update.title, update.rawInput ?? {});
      const idx = stale.toolSigs.indexOf(sig);
      if (idx !== -1) {
        stale.toolSigs.splice(idx, 1);
        session.suppressedToolIds.add(update.toolCallId);
        checkDone();
        return true;
      }
      stale.active = false;
      return false;
    }

    flushBufferedPrefixes(null);
    stale.active = false;
    return false;
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
    if (['session/load', 'session/close'].includes(message.method) && params.sessionId) {
      const session = this.sessions.get(params.sessionId);
      if (session) {
        session.suppressedToolIds.clear();
        session.staleReplay = null;
        this.cancelPendingLoad(session);
        this.cancelDeferredMetaFlush(session);
      }
    }
    if (['session/cancel', 'session/close'].includes(message.method)) {
      this.sessions.get(params.sessionId)?.round?.controller.abort();
    }
    if (message.method === 'session/prompt') {
      const existing = params.sessionId ? this.sessions.get(params.sessionId) : undefined;
      if (existing?.pendingLoad) {
        this.flushPendingLoad(existing, { immediateMeta: true });
      } else if (existing?.deferredMetaFlush) {
        this.flushDeferredMeta(existing);
      }
    }
    if (message.method === 'session/prompt' && UUID_RE.test(params.sessionId ?? '')) {
      const session = this.ensureSession(params.sessionId);
      if (session.round) throw new Error('AGY already has an active foreground or background turn');
      const tail = new TranscriptTail(
        join(this.dataDir, 'brain', params.sessionId, '.system_generated/logs/transcript.jsonl'),
      );
      await tail.begin();
      const swarmBaseline = await inspectSwarmContinuation({
        dataDir: this.dataDir,
        sessionId: params.sessionId,
        wakeupGraceMs: this.swarmWakeupGraceMs,
        workerStaleMs: this.swarmWorkerStaleMs,
      });
      if (this.closed) throw new Error('AGY background bridge is closed');
      if (session.round) throw new Error('AGY already has an active foreground or background turn');
      const observedSwarmWorkers = new Map();
      for (const worker of swarmBaseline.workingWorkers ?? []) {
        observedSwarmWorkers.set(worker.key, {
          progressKey: worker.progressKey,
          observedAtMs: worker.lastActivityMs,
        });
      }
      session.round = {
        id: ++this.roundSeq,
        tail,
        projection: new BackgroundProjection(params.sessionId, this.emit),
        controller: new AbortController(),
        swarmBaseline,
        observedSwarmWorkers,
        draining: false,
        steered: false,
        steerInFlight: null,
        swarmProgress: null,
        progressCardSeq: 0,
        lastSwarmState: null,
      };
    }
    if ('id' in message) this.requests.set(message.id, { method: message.method, sessionId: params.sessionId });
    return message;
  }

  fromAgent(message) {
    if (message.method === 'session/request_permission' && 'id' in message) {
      this.permissions.set(message.id, message.params?.sessionId);
      return Promise.resolve(message);
    }
    if (message.method === 'session/update') {
      const sid = message.params?.sessionId;
      const pending = sid ? this.sessions.get(sid)?.pendingLoad : null;
      if (pending) pending.generation += 1;
      const run = this.agentLane.then(() => this._fromAgent(message));
      this.agentLane = run.catch(() => undefined);
      return run;
    }
    if ('id' in message && !message.method) {
      if (this.steerRequests.has(message.id)) {
        return this.agentLane.then(() => this._fromAgent(message));
      }
      const reqMethod = this.requests.get(message.id)?.method;
      if (reqMethod === 'session/prompt' || reqMethod === 'session/load') {
        // Wait for queued session/update reads before draining end_turn or arming session/load quiescence,
        // without blocking unrelated RPC responses.
        return this.agentLane.then(() => this._fromAgent(message));
      }
    }
    return this._fromAgent(message);
  }

  isUnchangedPreExistingSwarmStale(state, round, swarmState, nowMs = Date.now()) {
    if (!(this.preExistingSwarmWorkerStaleMs > 0)) return false;
    if (round?.steered) return false;
    if (
      state.seenSwarm ||
      state.seenBackground ||
      state.hasPostForegroundWork ||
      state.parkedOnSwarmWait ||
      round.projection.hasOpenForegroundTools()
    ) {
      return false;
    }
    if (!swarmState?.exists || !swarmState.active || swarmState.hasPendingWakeup) return false;
    const baseline = round?.swarmBaseline;
    if (!baseline?.exists || !baseline.signature || baseline.signature !== swarmState.signature) {
      return false;
    }
    const activeWorkers = (swarmState.workingWorkers ?? []).filter(worker => !worker.stale);
    if (activeWorkers.length === 0) return false;
    const baselineWorkers = new Map((baseline.workingWorkers ?? []).map(worker => [worker.key, worker]));
    return activeWorkers.every(worker => {
      if (worker.pendingWakeup) return false;
      const baseWorker = baselineWorkers.get(worker.key);
      if (!baseWorker || baseWorker.progressKey !== worker.progressKey) return false;
      return (
        Number.isFinite(worker.lastActivityMs) &&
        nowMs - worker.lastActivityMs >= this.preExistingSwarmWorkerStaleMs
      );
    });
  }

  async _fromAgent(message) {
    if (message.method === 'session/update') {
      const sessionId = message.params?.sessionId;
      const update = message.params?.update;
      const session = sessionId ? this.sessions.get(sessionId) : undefined;
      if (session?.pendingLoad) {
        this.armPendingLoadSettleTimer(sessionId, session.pendingLoad);
        const kind = update?.sessionUpdate;
        if (DEFERRED_LOAD_META_UPDATES.has(kind)) {
          // Refresh insertion order so the latest snapshot for each metadata kind flushes after LOAD_RES.
          session.pendingLoad.deferredMeta.delete(kind);
          session.pendingLoad.deferredMeta.set(kind, message);
          return null;
        }
        return message;
      }
      if (this.filterStaleReplay(session, sessionId, update)) return null;
      if (
        session?.round &&
        session.round.projection.hasOpenForegroundTools() &&
        !(update?.sessionUpdate === 'tool_call_update' && session.round.projection.tools.has(update.toolCallId))
      ) {
        session.round.projection.add(await session.round.tail.read());
        session.round.projection.flushCompletedForegroundTools();
      }
      session?.round?.projection.observe(update);
      return message;
    }
    if (!('id' in message) || message.method) return message;
    const steerReq = this.steerRequests.get(message.id);
    if (steerReq) {
      this.steerRequests.delete(message.id);
      const session = this.sessions.get(steerReq.sessionId);
      const activeRound = session?.round === steerReq.round ? steerReq.round : null;
      if (activeRound) {
        try {
          activeRound.projection.add(await activeRound.tail.read());
          activeRound.projection.flushCompletedForegroundTools();
          activeRound.projection.inspect({ publish: false });
          if (message.error) {
            let actualInputs = 0;
            for (const row of activeRound.projection.rows.values()) {
              if (row.type === 'USER_INPUT') actualInputs++;
            }
            if (actualInputs <= steerReq.preSteerUserInputs && activeRound.projection.expectedUserInputs > 1) {
              activeRound.projection.expectedUserInputs -= 1;
            }
          }
        } catch {}
        if (message.error && !activeRound.controller.signal.aborted) {
          this.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: steerReq.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: `\n\n[Mid-turn guidance failed: ${message.error.message ?? 'unknown error'}]`,
                },
              },
            },
          });
        }
        if (activeRound.steerInFlight?.id === message.id) {
          activeRound.steerInFlight = null;
        }
      }
      return null;
    }
    if (typeof message.id === 'string' && message.id.startsWith('agy-steer:') && !this.requests.has(message.id)) {
      return null;
    }
    const request = this.requests.get(message.id);
    this.requests.delete(message.id);
    if (request?.method === 'session/load') {
      if (message.error || this.closed || this.loadSettleMs <= 0) return message;
      const sessionId = request.sessionId || message.result?.sessionId;
      if (!sessionId) return message;
      const session = this.ensureSession(sessionId);
      this.holdPendingLoad(sessionId, session, message);
      return null;
    }
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
      round.projection.flushCompletedForegroundTools();
      let state = round.projection.inspect();
      const initialNowMs = Date.now();
      let swarmState = await inspectSwarmContinuation({
        dataDir: this.dataDir,
        sessionId: request.sessionId,
        nowMs: initialNowMs,
        wakeupGraceMs: this.swarmWakeupGraceMs,
        workerStaleMs: this.swarmWorkerStaleMs,
        observedWorkers: round.observedSwarmWorkers,
      });
      const initialSwarmActive =
        swarmState.active && !this.isUnchangedPreExistingSwarmStale(state, round, swarmState, initialNowMs);
      if (
        (!state.seenBackground && !initialSwarmActive) ||
        (state.coordinatorSettled &&
          !initialSwarmActive &&
          !state.hasPostForegroundWork &&
          !round.projection.hasOpenForegroundTools())
      ) {
        this.recordRoundReplay(session, round);
        return message;
      }
      round.draining = true;
      round.projection.freezeUsageForegroundEnd();
      const deadline = Date.now() + this.timeoutMs;
      let idleSince;
      let approvalStallSince;
      let subagentFailureSince;
      while (!round.controller.signal.aborted) {
        if (round.steerInFlight) {
          idleSince = undefined;
          approvalStallSince = undefined;
          subagentFailureSince = undefined;
          if (Date.now() >= deadline) {
            throw new Error('Timed out waiting for AGY background work to finish; its final result has not been confirmed');
          }
          await wait(this.pollMs, round.controller.signal);
          continue;
        }
        state = round.projection.inspect({ publish: true });
        if (state.foreignInput) return { ...message, result: { ...message.result, stopReason: 'cancelled' } };
        if (state.failure) throw new Error(state.failure);
        const loopNowMs = Date.now();
        swarmState = await inspectSwarmContinuation({
          dataDir: this.dataDir,
          sessionId: request.sessionId,
          nowMs: loopNowMs,
          wakeupGraceMs: this.swarmWakeupGraceMs,
          workerStaleMs: this.swarmWorkerStaleMs,
          observedWorkers: round.observedSwarmWorkers,
        });
        round.lastSwarmState = swarmState;
        const effectiveSwarmActive =
          swarmState.active && !this.isUnchangedPreExistingSwarmStale(state, round, swarmState, loopNowMs);
        if (swarmState.exists && (effectiveSwarmActive || round.swarmProgress)) {
          this.updateSwarmProgressCard(request.sessionId, round, swarmState, loopNowMs);
        }
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
            (effectiveSwarmActive && Boolean(swarmState.awaitingApproval)));
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
        if (state.coordinatorSettled && !effectiveSwarmActive) {
          idleSince ??= Date.now();
          if (Date.now() - idleSince >= this.settleMs) {
            if (round.steerInFlight) {
              idleSince = undefined;
              await wait(this.pollMs, round.controller.signal);
              continue;
            }
            round.draining = false;
            this.finalizeSwarmProgressCard(request.sessionId, round, swarmState, {
              status: 'completed',
              phase: 'settled',
            });
            const result = structuredClone(message);
            if (result.result.usage) {
              for (const [key, delta] of Object.entries(state.extraUsage)) {
                if (typeof result.result.usage[key] === 'number') result.result.usage[key] += delta;
              }
            }
            this.recordRoundReplay(session, round);
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
      this.finalizeSwarmProgressCard(request.sessionId, round, round.lastSwarmState, {
        status: 'failed',
        phase: 'failed',
        note: error.message,
      });
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: `AGY background continuation failed: ${error.message}` },
      };
    } finally {
      round.draining = false;
      round.steerInFlight = null;
      for (const [steerId, entry] of this.steerRequests.entries()) {
        if (entry.round === round) this.steerRequests.delete(steerId);
      }
      if (session.round === round) session.round = null;
    }
  }

  permissionResolved(id) {
    this.permissions.delete(id);
  }

  close() {
    this.closed = true;
    for (const session of this.sessions.values()) {
      session.round?.controller.abort();
      this.cancelPendingLoad(session);
      this.cancelDeferredMetaFlush(session);
    }
    this.sessions.clear();
    this.requests.clear();
    this.steerRequests.clear();
    this.permissions.clear();
  }
}
