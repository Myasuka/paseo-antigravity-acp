import { open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const APPROVAL_SENSITIVE_TOOLS = new Set([
  'run_command',
  'edit_file',
  'write_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
]);

export const SWARM_TOOLS = new Set(['swarm', 'post_message', 'read_board', 'swarm_wait']);

export function isObserverMember(name, member) {
  if (typeof name === 'string' && /^(?:narrator|monitor)(?:-\d+)?$/i.test(name)) return true;
  const role = typeof member?.role === 'string' ? member.role.trim().toLowerCase() : '';
  return role !== '' && role !== 'worker' && role !== 'coordinator';
}

export function extractMentions(text, rosterNames = []) {
  if (typeof text !== 'string' || !text) {
    return { mentions: [], channelMentions: [], all: false };
  }
  const byLower = new Map();
  for (const name of rosterNames) {
    if (typeof name === 'string' && name) byLower.set(name.toLowerCase(), name);
  }

  const mentionsSet = new Set();
  const channelSet = new Set();
  let all = false;

  const pattern = /(?:^|[^A-Za-z0-9_/-])@(#?[A-Za-z0-9][A-Za-z0-9_-]*)/g;
  for (const match of text.matchAll(pattern)) {
    const rawToken = match[1];
    if (!rawToken) continue;
    if (rawToken.startsWith('#')) {
      const ch = rawToken.slice(1).toLowerCase();
      if (ch && ch !== 'main') channelSet.add(ch);
      continue;
    }
    const lower = rawToken.toLowerCase();
    if (lower === 'all') {
      all = true;
      continue;
    }
    const exact = byLower.get(lower);
    if (exact) {
      mentionsSet.add(exact);
    }
    // Numbered worker pool addressing: @worker addresses worker-1..worker-k when spawned as a group.
    const groupPrefix = `${lower}-`;
    let matchedGroup = false;
    for (const [candidateLower, canonical] of byLower.entries()) {
      if (candidateLower.startsWith(groupPrefix) && /^\d+$/.test(candidateLower.slice(groupPrefix.length))) {
        mentionsSet.add(canonical);
        matchedGroup = true;
      }
    }
    if (!exact && !matchedGroup && lower === 'coordinator') {
      mentionsSet.add('coordinator');
    }
  }

  return {
    mentions: [...mentionsSet],
    channelMentions: [...channelSet],
    all,
  };
}

export function extractSeqRefs(text) {
  if (typeof text !== 'string' || !text) return [];
  const refs = new Set();
  const pattern = /(?:^|[^A-Za-z0-9&#/])#(\d+)\b/g;
  for (const match of text.matchAll(pattern)) {
    const seq = Number.parseInt(match[1], 10);
    if (Number.isInteger(seq) && seq > 0) refs.add(seq);
  }
  return [...refs].sort((a, b) => a - b);
}

function decodeToolArgValue(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function summarizePlannerActivity(plannerRow) {
  const calls = Array.isArray(plannerRow?.tool_calls) ? plannerRow.tool_calls : [];
  if (calls.length > 0) {
    const latestCall = calls.at(-1);
    const name = typeof latestCall?.name === 'string' ? latestCall.name : 'tool';
    const args = latestCall?.args && typeof latestCall.args === 'object' ? latestCall.args : {};
    const summary = decodeToolArgValue(args.toolSummary);
    if (typeof summary === 'string' && summary.trim()) {
      return { activity: summary.trim().slice(0, 120), activityKind: 'tool' };
    }
    const cmd = decodeToolArgValue(args.CommandLine);
    if (name === 'run_command' && typeof cmd === 'string' && cmd.trim()) {
      return { activity: `run_command: ${cmd.trim().slice(0, 96)}`, activityKind: 'tool' };
    }
    const pathArg =
      decodeToolArgValue(args.Path) ??
      decodeToolArgValue(args.TargetFile) ??
      decodeToolArgValue(args.DirectoryPath);
    if (typeof pathArg === 'string' && pathArg.trim()) {
      const shortPath = pathArg.trim().split(/[\\/]/).slice(-2).join('/');
      return { activity: `${name}: ${shortPath}`, activityKind: 'tool' };
    }
    if (name === 'swarm') {
      const action = decodeToolArgValue(args.action);
      const target = decodeToolArgValue(args.name);
      return {
        activity: `swarm ${typeof action === 'string' ? action : 'status'}${typeof target === 'string' ? ` @${target}` : ''}`,
        activityKind: 'tool',
      };
    }
    return { activity: name, activityKind: 'tool' };
  }

  const thinkingText = typeof plannerRow?.thinking === 'string' ? plannerRow.thinking.trim() : '';
  if (thinkingText) {
    const firstLine = thinkingText.split(/\r?\n/).find(line => line.trim()) ?? '';
    return {
      activity: firstLine.replace(/^#+\s*/, '').trim().slice(0, 120),
      activityKind: 'thinking',
    };
  }
  return { activity: null, activityKind: null };
}

function classifyErrorKind(message) {
  return /\b(?:429|RESOURCE_EXHAUSTED|quota|rate[\s_-]?limit|too many requests)\b/i.test(message) ? 'quota' : 'error';
}

function parseStepTimeMs(row) {
  if (typeof row?.created_at === 'string') {
    const parsed = Date.parse(row.created_at);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export async function summarizeMemberTranscript(transcriptPath, nowMs = Date.now()) {
  let file;
  try {
    file = await open(transcriptPath, 'r');
    const info = await file.stat();
    if (info.size === 0) {
      return {
        exists: true,
        mtimeMs: info.mtimeMs,
        size: 0,
        steps: 0,
        runState: 'none',
        activity: null,
        activityKind: null,
        failure: null,
        lastProgressMs: info.mtimeMs,
        lastTurnBoundaryMs: null,
        awaitingApproval: false,
      };
    }
    const readBytes = Math.min(info.size, 256 * 1024);
    const buffer = Buffer.alloc(readBytes);
    await file.read(buffer, 0, readBytes, info.size - readBytes);
    let text = buffer.toString('utf8');
    if (readBytes < info.size) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }

    const rows = [];
    for (const rawLine of text.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') rows.push(parsed);
      } catch {
        // Ignore partial trailing line while AGY is actively flushing.
      }
    }

    if (rows.length === 0) {
      return {
        exists: true,
        mtimeMs: info.mtimeMs,
        size: info.size,
        steps: 0,
        runState: 'none',
        activity: null,
        activityKind: null,
        failure: null,
        lastProgressMs: info.mtimeMs,
        lastTurnBoundaryMs: null,
        awaitingApproval: false,
      };
    }

    rows.sort((a, b) => (a.step_index ?? 0) - (b.step_index ?? 0));
    const maxStepIndex = rows.reduce(
      (acc, row) => (Number.isInteger(row.step_index) ? Math.max(acc, row.step_index) : acc),
      rows.length - 1,
    );
    const steps = maxStepIndex + 1;
    const newest = rows.at(-1);
    const lastProgressMs = parseStepTimeMs(newest) ?? info.mtimeMs;

    let failure = null;
    if (
      newest &&
      newest.status === 'ERROR' &&
      (newest.type === 'ERROR_MESSAGE' || newest.type === 'PLANNER_RESPONSE')
    ) {
      const msg = String(newest.error || newest.content || 'Agent step failed').trim();
      failure = { kind: classifyErrorKind(msg), message: msg.slice(0, 300), timestampMs: lastProgressMs };
    } else if (
      newest &&
      newest.type === 'GENERIC' &&
      newest.status === 'ERROR' &&
      nowMs - lastProgressMs >= 60 * 1000
    ) {
      const msg = String(newest.error || newest.content || 'Tool step failed').trim();
      failure = { kind: classifyErrorKind(msg), message: msg.slice(0, 300), timestampMs: lastProgressMs };
    }

    let lastTurnBoundaryIdx = -1;
    let lastPlannerIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      const type = rows[i].type;
      if (type === 'USER_INPUT' || type === 'SYSTEM_MESSAGE') lastTurnBoundaryIdx = i;
      if (type === 'PLANNER_RESPONSE') lastPlannerIdx = i;
    }
    const lastTurnBoundaryMs =
      lastTurnBoundaryIdx >= 0 ? parseStepTimeMs(rows[lastTurnBoundaryIdx]) : null;
    const hasPostInitialWakeup = lastTurnBoundaryIdx > 0;

    // Terminal model/planner error stops the current run.
    if (
      newest &&
      newest.status === 'ERROR' &&
      (newest.type === 'ERROR_MESSAGE' || newest.type === 'PLANNER_RESPONSE')
    ) {
      return {
        exists: true,
        mtimeMs: info.mtimeMs,
        size: info.size,
        steps,
        runState: 'waiting',
        activity: null,
        activityKind: null,
        failure,
        lastProgressMs,
        lastTurnBoundaryMs,
        hasPostInitialWakeup,
        awaitingApproval: false,
      };
    }

    // Just woken up; first planner step of the new turn has not landed yet.
    if (lastPlannerIdx === -1 || lastTurnBoundaryIdx > lastPlannerIdx) {
      return {
        exists: true,
        mtimeMs: info.mtimeMs,
        size: info.size,
        steps,
        runState: 'working',
        activity: null,
        activityKind: null,
        failure,
        lastProgressMs,
        lastTurnBoundaryMs,
        hasPostInitialWakeup,
        awaitingApproval: false,
      };
    }

    const lastPlanner = rows[lastPlannerIdx];
    const toolCalls = Array.isArray(lastPlanner.tool_calls) ? lastPlanner.tool_calls : [];

    // Stopped on a completed planner reply with zero tool calls.
    if (toolCalls.length === 0 && lastPlanner.status === 'DONE') {
      return {
        exists: true,
        mtimeMs: info.mtimeMs,
        size: info.size,
        steps,
        runState: 'waiting',
        activity: null,
        activityKind: null,
        failure,
        lastProgressMs,
        lastTurnBoundaryMs,
        hasPostInitialWakeup,
        awaitingApproval: false,
      };
    }

    const genericsAfter = rows.slice(lastPlannerIdx + 1).filter(row => row.type === 'GENERIC');
    const swarmWaitIndex = toolCalls.findIndex(call => call?.name === 'swarm_wait');
    if (
      swarmWaitIndex !== -1 &&
      genericsAfter.length >= toolCalls.length &&
      genericsAfter[swarmWaitIndex]?.status === 'DONE'
    ) {
      return {
        exists: true,
        mtimeMs: info.mtimeMs,
        size: info.size,
        steps,
        runState: 'waiting',
        activity: null,
        activityKind: null,
        failure,
        lastProgressMs,
        lastTurnBoundaryMs,
        hasPostInitialWakeup,
        awaitingApproval: false,
      };
    }

    const awaitingApproval =
      genericsAfter.length < toolCalls.length &&
      toolCalls.slice(genericsAfter.length).some(call => APPROVAL_SENSITIVE_TOOLS.has(call?.name));
    const { activity, activityKind } = summarizePlannerActivity(lastPlanner);

    return {
      exists: true,
      mtimeMs: info.mtimeMs,
      size: info.size,
      steps,
      runState: 'working',
      activity,
      activityKind,
      failure,
      lastProgressMs,
      lastTurnBoundaryMs,
      hasPostInitialWakeup,
      awaitingApproval,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        exists: false,
        mtimeMs: 0,
        size: 0,
        steps: 0,
        runState: 'none',
        activity: null,
        activityKind: null,
        failure: null,
        lastProgressMs: null,
        lastTurnBoundaryMs: null,
        awaitingApproval: false,
      };
    }
    throw error;
  } finally {
    await file?.close();
  }
}

export function resolveEffectiveMemberStatus(name, member, transcriptSummary, hasPendingWakeup = false) {
  if (member?.killed) return 'killed';
  if (transcriptSummary.runState === 'working') return 'working';
  if (transcriptSummary.runState === 'waiting') return 'waiting';
  if (member?.wait_since != null) return 'waiting';
  if (typeof member?.wake_mode === 'string' && member.wake_mode.length > 0 && !hasPendingWakeup) {
    return 'waiting';
  }
  if (name === 'coordinator') return 'waiting';
  return 'working';
}

export async function readBoundedJson(filePath, maxBytes = 64 * 1024) {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size === 0 || info.size > maxBytes) return null;
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function readBoardMessages(boardPath, maxBytes = 2 * 1024 * 1024) {
  let file;
  try {
    file = await open(boardPath, 'r');
    const info = await file.stat();
    if (info.size === 0) return { messages: [], mtimeMs: info.mtimeMs, size: 0 };
    const readBytes = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(readBytes);
    await file.read(buffer, 0, readBytes, info.size - readBytes);
    let text = buffer.toString('utf8');
    if (readBytes < info.size) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    const messages = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        if (row && typeof row === 'object' && Number.isInteger(row.seq) && typeof row.agent === 'string') {
          messages.push({
            seq: row.seq,
            agent: row.agent,
            text: typeof row.text === 'string' ? row.text : '',
            time: typeof row.time === 'string' ? row.time : null,
            channel: typeof row.channel === 'string' && row.channel ? row.channel : 'main',
            control: Boolean(row.control),
          });
        }
      } catch {
        // Ignore partial line while board append is in flight.
      }
    }
    messages.sort((a, b) => a.seq - b.seq);
    return { messages, mtimeMs: info.mtimeMs, size: info.size };
  } catch (error) {
    if (error?.code === 'ENOENT') return { messages: [], mtimeMs: 0, size: 0 };
    throw error;
  } finally {
    await file?.close();
  }
}

export function postWakesMember(post, name, member, rosterNames) {
  if (!post || member?.killed) return false;
  const lastRead = Number.isInteger(member?.last_read_seq) ? member.last_read_seq : 0;
  if (post.seq <= lastRead) return false;
  if (typeof post.agent === 'string' && post.agent.toLowerCase() === name.toLowerCase()) return false;

  const { mentions, channelMentions, all } = extractMentions(post.text, rosterNames);
  if (all) return true;
  if (mentions.some(m => m.toLowerCase() === name.toLowerCase())) return true;

  const memberChannels = Array.isArray(member?.channels)
    ? member.channels.filter(c => typeof c === 'string').map(c => c.toLowerCase())
    : [];
  const seesAllChannels = name === 'coordinator' || isObserverMember(name, member);
  if (channelMentions.length > 0) {
    if (seesAllChannels || channelMentions.some(ch => memberChannels.includes(ch))) return true;
  }

  if (member?.wake_mode === 'any') {
    const postChannel = (post.channel || 'main').toLowerCase();
    if (postChannel === 'main' || seesAllChannels || memberChannels.includes(postChannel)) return true;
  }

  return false;
}

export async function inspectSwarmContinuation({
  dataDir,
  sessionId,
  nowMs = Date.now(),
  wakeupGraceMs = 15000,
}) {
  if (!UUID_RE.test(sessionId ?? '')) {
    return { exists: false, active: false, activeWorkerConversations: [], awaitingApproval: false };
  }
  const swarmDir = join(dataDir, 'brain', sessionId, '.system_generated', 'swarm');
  const membersDoc = await readBoundedJson(join(swarmDir, 'members.json'), 256 * 1024);
  if (!membersDoc || typeof membersDoc !== 'object' || !membersDoc.members || typeof membersDoc.members !== 'object') {
    return { exists: false, active: false, activeWorkerConversations: [], awaitingApproval: false };
  }

  const entries = Object.entries(membersDoc.members).filter(([, m]) => m && typeof m === 'object');
  const rosterNames = ['coordinator', ...entries.map(([name]) => name)];
  const board = await readBoardMessages(join(swarmDir, 'board.jsonl'));
  const coordinatorSummary = await summarizeMemberTranscript(
    join(dataDir, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl'),
    nowMs,
  );

  const getPostRefMs = post => {
    const parsed = post.time ? Date.parse(post.time) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : board.mtimeMs;
  };
  const isUnservicedRecentWakeup = (post, summary) => {
    const refMs = getPostRefMs(post);
    if (!(refMs > 0 && nowMs - refMs <= wakeupGraceMs)) return false;
    if (summary?.runState === 'waiting') {
      if (summary.lastTurnBoundaryMs != null && summary.lastTurnBoundaryMs >= refMs) {
        return false;
      }
      if (
        summary.lastTurnBoundaryMs == null &&
        summary.hasPostInitialWakeup &&
        summary.mtimeMs > 0 &&
        board.mtimeMs > 0 &&
        summary.mtimeMs >= board.mtimeMs
      ) {
        return false;
      }
    }
    return true;
  };

  const activeWorkerConversations = [];
  let hasPendingWakeup = false;
  let awaitingApproval = false;

  for (const [name, member] of entries) {
    if (member.killed) continue;
    const observer = isObserverMember(name, member);

    if (name === 'coordinator') {
      const pendingForCoordinator = board.messages.some(
        post => isUnservicedRecentWakeup(post, coordinatorSummary) && postWakesMember(post, name, member, rosterNames),
      );
      if (pendingForCoordinator) hasPendingWakeup = true;
      continue;
    }

    if (observer) {
      // Narrator and monitor never hold the user-facing Paseo turn open on their own.
      continue;
    }

    const convId = typeof member.conversation_id === 'string' ? member.conversation_id.toLowerCase() : '';
    const transcriptSummary = UUID_RE.test(convId)
      ? await summarizeMemberTranscript(join(dataDir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl'), nowMs)
      : {
          exists: false,
          mtimeMs: 0,
          size: 0,
          steps: 0,
          runState: 'none',
          activity: null,
          activityKind: null,
          failure: null,
          lastProgressMs: null,
          lastTurnBoundaryMs: null,
          awaitingApproval: false,
        };

    const pendingForMember = board.messages.some(
      post => isUnservicedRecentWakeup(post, transcriptSummary) && postWakesMember(post, name, member, rosterNames),
    );
    const status = resolveEffectiveMemberStatus(name, member, transcriptSummary, pendingForMember);
    if (status === 'working') {
      if (transcriptSummary.awaitingApproval) awaitingApproval = true;
      if (UUID_RE.test(convId)) activeWorkerConversations.push(convId);
      else activeWorkerConversations.push(`swarm:${name}`);
    } else if (pendingForMember) {
      hasPendingWakeup = true;
    }
  }

  // Even when "coordinator" is not explicitly stored in members.json, check posts addressing @coordinator/@all after the coordinator's latest post.
  if (!('coordinator' in membersDoc.members) && board.messages.length > 0) {
    let lastCoordinatorSeq = 0;
    for (const post of board.messages) {
      if (post.agent === 'coordinator') lastCoordinatorSeq = Math.max(lastCoordinatorSeq, post.seq);
    }
    const syntheticCoord = { last_read_seq: lastCoordinatorSeq, wake_mode: 'mentions', killed: false };
    if (
      board.messages.some(
        post =>
          isUnservicedRecentWakeup(post, coordinatorSummary) &&
          postWakesMember(post, 'coordinator', syntheticCoord, rosterNames),
      )
    ) {
      hasPendingWakeup = true;
    }
  }

  return {
    exists: true,
    active: activeWorkerConversations.length > 0 || hasPendingWakeup,
    activeWorkerConversations: activeWorkerConversations.filter(id => UUID_RE.test(id)),
    hasWorkingTaskWorkers: activeWorkerConversations.length > 0,
    awaitingApproval,
  };
}
