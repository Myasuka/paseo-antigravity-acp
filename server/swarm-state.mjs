import { open, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BG_TASK_LAUNCH_RE = new RegExp(
  `(?:^|\\n)Tool is running as a background task with task id: (${UUID_PATTERN}\\/task-\\d+)(?:\\s|$)`,
  'i',
);
const BG_TASK_DONE_RE =
  /content=Task id "([^"]+)" (?:finished|completed|failed|stopped|killed|terminated|canceled|cancelled) with result:/g;
const CREATED_SUBAGENT_RE = new RegExp(
  `(?:^|\\n)Created the following subagent:\\s*\\{[\\s\\S]*?"conversationId"\\s*:\\s*"(${UUID_PATTERN})"`,
  'i',
);
const DIRECT_SUBAGENT_MSG_RE = new RegExp(
  `\\[Message\\][^\\n]*\\bsender=(${UUID_PATTERN})\\b[^\\n]*\\bcontent=([\\s\\S]*?)(?:\\n<\\/SYSTEM_MESSAGE>|$)`,
  'gi',
);
const SYSTEM_SUBAGENT_IDLE_RE = new RegExp(
  `\\bcontent=Subagent "?(${UUID_PATTERN})"? (?:has gone idle\\. This was the subagent's most recent response:[\\s\\S]*?|went idle without reporting anything back[\\s\\S]*?|has been explicitly canceled[\\s\\S]*?)(?:\\n<\\/SYSTEM_MESSAGE>|$)`,
  'gi',
);
const SERVER_RESTART_NOTICE_RE =
  /\bcontent=\[Notice\] All your subagents and background tasks have been stopped due to server restart\./;
const STREAM_INTERRUPTED_RE = /stream was interrupted/i;

export const APPROVAL_SENSITIVE_TOOLS = new Set([
  'run_command',
  'edit_file',
  'write_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
]);

export const SWARM_TOOLS = new Set(['swarm', 'post_message', 'read_board', 'swarm_wait']);

export const DEFAULT_SWARM_WORKER_STALE_MS = 10 * 60 * 1000;

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
  let latest = null;
  if (typeof row?.created_at === 'string') {
    const parsed = Date.parse(row.created_at);
    if (Number.isFinite(parsed)) latest = parsed;
  }
  if (typeof row?.content === 'string') {
    const match = /^Completed At:\s*(\d{4}-\d{2}-\d{2}T[^\s]+)/m.exec(row.content);
    if (match) {
      const completed = Date.parse(match[1]);
      if (Number.isFinite(completed) && (latest === null || completed > latest)) {
        latest = completed;
      }
    }
  }
  return latest;
}

function extractCommandHeader(content) {
  return typeof content === 'string' ? content.split(/\nCommand output:/)[0] : '';
}

function summarizeBackgroundCommand(args, content) {
  const toolSummary = decodeToolArgValue(args?.toolSummary);
  if (typeof toolSummary === 'string' && toolSummary.trim()) {
    return toolSummary.trim().slice(0, 80);
  }
  const cmd = decodeToolArgValue(args?.CommandLine);
  if (typeof cmd === 'string' && cmd.trim()) {
    return cmd.trim().replace(/\s+/g, ' ').slice(0, 80);
  }
  const descMatch = /^Task Description:\s*(.+)$/m.exec(extractCommandHeader(content));
  if (descMatch?.[1]?.trim()) {
    return descMatch[1].trim().slice(0, 80);
  }
  return '';
}

function summarizePendingBackgroundActivity(pendingBgTasks, pendingSubagents) {
  if (pendingBgTasks.size > 0) {
    let latest;
    for (const entry of pendingBgTasks.values()) latest = entry;
    const base = latest.summary
      ? `run_command (${latest.taskName}): ${latest.summary}`
      : `Waiting on background task (${latest.taskName})`;
    const suffix = pendingBgTasks.size > 1 ? ` (+${pendingBgTasks.size - 1})` : '';
    return `${base.slice(0, 120 - suffix.length)}${suffix}`;
  }
  if (pendingSubagents.size > 0) {
    return pendingSubagents.size === 1 ? 'Waiting on subagent' : `Waiting on ${pendingSubagents.size} subagents`;
  }
  return null;
}

function trackPendingBackgroundWork(rows) {
  const queue = [];
  const pendingBgTasks = new Map();
  const knownSubagents = new Map();
  const pendingSubagents = new Map();

  for (const row of rows) {
    if (row.type === 'PLANNER_RESPONSE') {
      const calls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
      for (const call of calls) {
        queue.push({
          name: typeof call?.name === 'string' ? call.name : '',
          args: call?.args && typeof call.args === 'object' ? call.args : {},
        });
      }
      continue;
    }

    if (row.type === 'GENERIC' && queue.length > 0) {
      const ref = queue.shift();
      const content = typeof row.content === 'string' ? row.content : '';
      const isDaemon = ref.name === 'run_command' && decodeToolArgValue(ref.args?.IsDaemon) === true;
      const launchMatch =
        ref.name === 'run_command' && !isDaemon
          ? BG_TASK_LAUNCH_RE.exec(extractCommandHeader(content))
          : null;
      if (launchMatch) {
        const taskId = launchMatch[1].toLowerCase();
        const taskName = taskId.split('/')[1] || taskId;
        pendingBgTasks.set(taskId, {
          taskName,
          summary: summarizeBackgroundCommand(ref.args, content),
        });
        continue;
      }

      if (ref.name === 'manage_task' && row.status === 'DONE') {
        const action = decodeToolArgValue(ref.args?.Action);
        const rawTarget = decodeToolArgValue(ref.args?.TaskId);
        if (action === 'kill' && typeof rawTarget === 'string' && rawTarget.trim()) {
          const target = rawTarget.trim().toLowerCase();
          pendingBgTasks.delete(target);
          for (const existingKey of [...pendingBgTasks.keys()]) {
            if (existingKey.endsWith(`/${target}`)) pendingBgTasks.delete(existingKey);
          }
        }
        continue;
      }

      if (ref.name === 'invoke_subagent' && row.status === 'DONE') {
        const createdMatch = CREATED_SUBAGENT_RE.exec(content);
        if (createdMatch) {
          const subId = createdMatch[1].toLowerCase();
          knownSubagents.set(subId, true);
          pendingSubagents.set(subId, true);
        }
        continue;
      }

      if (ref.name === 'send_message' && row.status === 'DONE') {
        const recipient = decodeToolArgValue(ref.args?.Recipient);
        if (typeof recipient === 'string') {
          const subId = recipient.trim().toLowerCase();
          if (knownSubagents.has(subId)) pendingSubagents.set(subId, true);
        }
        continue;
      }

      if (ref.name === 'manage_subagents' && row.status === 'DONE' && pendingSubagents.size > 0) {
        const action = decodeToolArgValue(ref.args?.Action);
        if (action === 'kill_all') {
          pendingSubagents.clear();
        } else if (action === 'kill') {
          const ids = decodeToolArgValue(ref.args?.ConversationIds);
          if (Array.isArray(ids)) {
            for (const rawId of ids) {
              if (typeof rawId === 'string') pendingSubagents.delete(rawId.trim().toLowerCase());
            }
          }
        } else if (action === 'list') {
          if (/\b(?:no|0) active subagents?\b/i.test(content)) {
            pendingSubagents.clear();
          } else {
            const listMatch = /\n(\[[\s\S]*\])\s*$/.exec(content);
            if (listMatch) {
              try {
                const parsed = JSON.parse(listMatch[1]);
                if (Array.isArray(parsed)) {
                  const running = new Set(
                    parsed
                      .filter(item => item?.state === 'running' && typeof item.conversationId === 'string')
                      .map(item => item.conversationId.toLowerCase()),
                  );
                  for (const subId of [...pendingSubagents.keys()]) {
                    if (!running.has(subId)) pendingSubagents.delete(subId);
                  }
                }
              } catch {}
            }
          }
        }
      }
      continue;
    }

    if (row.type === 'SYSTEM_MESSAGE') {
      const content = typeof row.content === 'string' ? row.content : '';
      for (const doneMatch of content.matchAll(BG_TASK_DONE_RE)) {
        pendingBgTasks.delete(doneMatch[1].toLowerCase());
      }
      for (const directMatch of content.matchAll(DIRECT_SUBAGENT_MSG_RE)) {
        pendingSubagents.delete(directMatch[1].toLowerCase());
      }
      for (const idleMatch of content.matchAll(SYSTEM_SUBAGENT_IDLE_RE)) {
        pendingSubagents.delete(idleMatch[1].toLowerCase());
      }
      if (SERVER_RESTART_NOTICE_RE.test(content)) {
        pendingBgTasks.clear();
        pendingSubagents.clear();
      }
      continue;
    }

    if (row.type === 'ERROR_MESSAGE') {
      const errMsg = String(row.error || row.content || '');
      if (row.status === 'ERROR' || STREAM_INTERRUPTED_RE.test(errMsg)) {
        pendingBgTasks.clear();
        pendingSubagents.clear();
      }
    }
  }

  return { pendingBgTasks, pendingSubagents };
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
        pendingBackgroundCount: 0,
        backgroundTaskBytes: 0,
        backgroundProgressKey: '',
      };
    }
    const readBytes = Math.min(info.size, 512 * 1024);
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
        pendingBackgroundCount: 0,
        backgroundTaskBytes: 0,
        backgroundProgressKey: '',
      };
    }

    rows.sort((a, b) => (a.step_index ?? 0) - (b.step_index ?? 0));
    const maxStepIndex = rows.reduce(
      (acc, row) => (Number.isInteger(row.step_index) ? Math.max(acc, row.step_index) : acc),
      rows.length - 1,
    );
    const steps = maxStepIndex + 1;
    const newest = rows.at(-1);
    let lastProgressMs = parseStepTimeMs(newest) ?? info.mtimeMs;

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

    const { pendingBgTasks, pendingSubagents } = trackPendingBackgroundWork(rows);
    const backgroundProgressParts = [];
    let backgroundTaskBytes = 0;
    if (pendingBgTasks.size > 0 || pendingSubagents.size > 0) {
      const systemGenDir = dirname(dirname(transcriptPath));
      for (const taskInfo of pendingBgTasks.values()) {
        try {
          const taskStat = await stat(join(systemGenDir, 'tasks', `${taskInfo.taskName}.log`));
          if (Number.isFinite(taskStat.size) && taskStat.size > 0) {
            backgroundTaskBytes += taskStat.size;
          }
          backgroundProgressParts.push(`t:${taskInfo.taskName}:${taskStat.size}:${Math.round(taskStat.mtimeMs)}`);
          if (
            Number.isFinite(taskStat.mtimeMs) &&
            taskStat.mtimeMs <= nowMs + 60_000 &&
            taskStat.mtimeMs > lastProgressMs
          ) {
            lastProgressMs = taskStat.mtimeMs;
          }
        } catch {}
      }
      if (pendingSubagents.size > 0 && basename(systemGenDir) === '.system_generated') {
        const brainDir = dirname(dirname(systemGenDir));
        for (const subId of pendingSubagents.keys()) {
          try {
            const subStat = await stat(join(brainDir, subId, '.system_generated', 'logs', 'transcript.jsonl'));
            backgroundProgressParts.push(`s:${subId}:${subStat.size}:${Math.round(subStat.mtimeMs)}`);
            if (
              Number.isFinite(subStat.mtimeMs) &&
              subStat.mtimeMs <= nowMs + 60_000 &&
              subStat.mtimeMs > lastProgressMs
            ) {
              lastProgressMs = subStat.mtimeMs;
            }
          } catch {}
        }
      }
    }
    const pendingBackgroundCount = pendingBgTasks.size + pendingSubagents.size;
    const backgroundProgressKey = backgroundProgressParts.sort().join(',');

    const isStreamInterrupted =
      newest?.type === 'ERROR_MESSAGE' &&
      STREAM_INTERRUPTED_RE.test(String(newest.error || newest.content || ''));

    // Terminal model/planner error or stream interruption stops the current run.
    if (
      isStreamInterrupted ||
      (newest &&
        newest.status === 'ERROR' &&
        (newest.type === 'ERROR_MESSAGE' || newest.type === 'PLANNER_RESPONSE'))
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
        pendingBackgroundCount: 0,
        backgroundTaskBytes: 0,
        backgroundProgressKey: '',
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
        activity: pendingBackgroundCount > 0 ? summarizePendingBackgroundActivity(pendingBgTasks, pendingSubagents) : null,
        activityKind: pendingBackgroundCount > 0 ? 'tool' : null,
        failure,
        lastProgressMs,
        lastTurnBoundaryMs,
        hasPostInitialWakeup,
        awaitingApproval: false,
        pendingBackgroundCount,
        backgroundTaskBytes,
        backgroundProgressKey,
      };
    }

    const lastPlanner = rows[lastPlannerIdx];
    const toolCalls = Array.isArray(lastPlanner.tool_calls) ? lastPlanner.tool_calls : [];

    // Stopped on a completed planner reply with zero tool calls unless background tasks/subagents are still running.
    if (toolCalls.length === 0 && lastPlanner.status === 'DONE') {
      if (pendingBackgroundCount > 0) {
        return {
          exists: true,
          mtimeMs: info.mtimeMs,
          size: info.size,
          steps,
          runState: 'working',
          activity: summarizePendingBackgroundActivity(pendingBgTasks, pendingSubagents),
          activityKind: 'tool',
          failure,
          lastProgressMs,
          lastTurnBoundaryMs,
          hasPostInitialWakeup,
          awaitingApproval: false,
          pendingBackgroundCount,
          backgroundTaskBytes,
          backgroundProgressKey,
        };
      }
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
        pendingBackgroundCount: 0,
        backgroundTaskBytes: 0,
        backgroundProgressKey: '',
      };
    }

    const genericsAfter = rows.slice(lastPlannerIdx + 1).filter(row => row.type === 'GENERIC');
    const swarmWaitIndex = toolCalls.findIndex(call => call?.name === 'swarm_wait');
    if (
      swarmWaitIndex !== -1 &&
      genericsAfter.length >= toolCalls.length &&
      genericsAfter[swarmWaitIndex]?.status === 'DONE' &&
      pendingBackgroundCount === 0
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
        pendingBackgroundCount: 0,
        backgroundTaskBytes: 0,
        backgroundProgressKey: '',
      };
    }

    const awaitingApproval =
      genericsAfter.length < toolCalls.length &&
      toolCalls.slice(genericsAfter.length).some(call => APPROVAL_SENSITIVE_TOOLS.has(call?.name));
    const plannerActivity = summarizePlannerActivity(lastPlanner);
    const bgActivity =
      pendingBackgroundCount > 0 ? summarizePendingBackgroundActivity(pendingBgTasks, pendingSubagents) : null;

    return {
      exists: true,
      mtimeMs: info.mtimeMs,
      size: info.size,
      steps,
      runState: 'working',
      activity: plannerActivity.activity ?? bgActivity,
      activityKind: plannerActivity.activityKind ?? (bgActivity ? 'tool' : null),
      failure,
      lastProgressMs,
      lastTurnBoundaryMs,
      hasPostInitialWakeup,
      awaitingApproval,
      pendingBackgroundCount,
      backgroundTaskBytes,
      backgroundProgressKey,
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
        pendingBackgroundCount: 0,
        backgroundTaskBytes: 0,
        backgroundProgressKey: '',
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

async function readBoundedJsonWithStat(filePath, maxBytes = 64 * 1024) {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size === 0 || info.size > maxBytes) return null;
    const raw = await readFile(filePath, 'utf8');
    return {
      data: JSON.parse(raw),
      mtimeMs: info.mtimeMs,
      size: info.size,
    };
  } catch {
    return null;
  }
}

export async function readBoundedJson(filePath, maxBytes = 64 * 1024) {
  const loaded = await readBoundedJsonWithStat(filePath, maxBytes);
  return loaded ? loaded.data : null;
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
  workerStaleMs = DEFAULT_SWARM_WORKER_STALE_MS,
  observedWorkers = null,
}) {
  const emptyState = {
    exists: false,
    active: false,
    activeWorkerConversations: [],
    staleWorkerConversations: [],
    hasWorkingTaskWorkers: false,
    hasPendingWakeup: false,
    awaitingApproval: false,
    workingWorkers: [],
    signature: null,
    progress: null,
  };
  if (!UUID_RE.test(sessionId ?? '')) {
    return emptyState;
  }
  const swarmDir = join(dataDir, 'brain', sessionId, '.system_generated', 'swarm');
  const membersFile = await readBoundedJsonWithStat(join(swarmDir, 'members.json'), 256 * 1024);
  const membersDoc = membersFile?.data;
  if (!membersDoc || typeof membersDoc !== 'object' || !membersDoc.members || typeof membersDoc.members !== 'object') {
    return emptyState;
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
  const staleWorkerKeys = [];
  const workingWorkers = [];
  const workerSignatureParts = [];
  const progressWorkers = [];
  let activeCount = 0;
  let waitingCount = 0;
  let staleCount = 0;
  let lastProgressActivityMs = null;
  let hasPendingWakeup = false;
  let awaitingApproval = false;

  const bumpActivity = ms => {
    if (Number.isFinite(ms) && ms > 0 && (lastProgressActivityMs === null || ms > lastProgressActivityMs)) {
      lastProgressActivityMs = ms;
    }
  };

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
    const workerKey = UUID_RE.test(convId) ? convId : `swarm:${name}`;
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
          pendingBackgroundCount: 0,
          backgroundTaskBytes: 0,
          backgroundProgressKey: '',
        };

    const baseProgressKey = transcriptSummary.exists
      ? `${transcriptSummary.steps}:${transcriptSummary.size}:${Math.round(transcriptSummary.mtimeMs)}`
      : 'missing';
    const progressKey = transcriptSummary.backgroundProgressKey
      ? `${baseProgressKey}:bg[${transcriptSummary.backgroundProgressKey}]`
      : baseProgressKey;
    workerSignatureParts.push(`${workerKey}:${progressKey}`);

    const pendingForMember = board.messages.some(
      post => isUnservicedRecentWakeup(post, transcriptSummary) && postWakesMember(post, name, member, rosterNames),
    );
    const status = resolveEffectiveMemberStatus(name, member, transcriptSummary, pendingForMember);
    if (status !== 'working') {
      if (observedWorkers instanceof Map) observedWorkers.delete(workerKey);
      if (pendingForMember) hasPendingWakeup = true;
      waitingCount++;
      bumpActivity(transcriptSummary.lastProgressMs);
      progressWorkers.push({
        name,
        status: 'waiting',
        activity: null,
        steps: transcriptSummary.steps,
        lastActivityMs: transcriptSummary.lastProgressMs,
        taskLogBytes: 0,
        awaitingApproval: false,
        failure: transcriptSummary.failure?.message ?? null,
      });
      continue;
    }

    let lastActivityMs = null;
    if (transcriptSummary.exists && Number.isFinite(transcriptSummary.lastProgressMs)) {
      lastActivityMs = transcriptSummary.lastProgressMs;
    } else {
      for (const post of board.messages) {
        if (!postWakesMember(post, name, member, rosterNames)) continue;
        const refMs = getPostRefMs(post);
        if (Number.isFinite(refMs) && (lastActivityMs === null || refMs > lastActivityMs)) {
          lastActivityMs = refMs;
        }
      }
      if (lastActivityMs === null && Number.isFinite(membersFile.mtimeMs)) {
        lastActivityMs = membersFile.mtimeMs;
      }
    }

    let effectiveLastActivityMs = lastActivityMs;
    if (observedWorkers instanceof Map) {
      const prev = observedWorkers.get(workerKey);
      if (!prev) {
        const baselineMs = Number.isFinite(lastActivityMs) ? lastActivityMs : nowMs;
        observedWorkers.set(workerKey, { progressKey, observedAtMs: baselineMs });
        effectiveLastActivityMs = baselineMs;
      } else if (prev.progressKey !== progressKey) {
        observedWorkers.set(workerKey, { progressKey, observedAtMs: nowMs });
        effectiveLastActivityMs = Number.isFinite(lastActivityMs) ? Math.max(lastActivityMs, nowMs) : nowMs;
      } else {
        effectiveLastActivityMs = Number.isFinite(prev.observedAtMs)
          ? Number.isFinite(lastActivityMs)
            ? Math.max(lastActivityMs, prev.observedAtMs)
            : prev.observedAtMs
          : lastActivityMs;
      }
    }

    const isStale =
      !pendingForMember &&
      workerStaleMs > 0 &&
      Number.isFinite(effectiveLastActivityMs) &&
      nowMs - effectiveLastActivityMs >= workerStaleMs;

    const workerLastMs = Number.isFinite(effectiveLastActivityMs) ? effectiveLastActivityMs : null;
    bumpActivity(workerLastMs);

    workingWorkers.push({
      name,
      conversationId: UUID_RE.test(convId) ? convId : null,
      key: workerKey,
      progressKey,
      lastActivityMs: workerLastMs,
      awaitingApproval: Boolean(transcriptSummary.awaitingApproval),
      pendingWakeup: pendingForMember,
      stale: isStale,
    });

    progressWorkers.push({
      name,
      status: isStale ? 'stale' : 'active',
      activity: transcriptSummary.activity ?? null,
      steps: transcriptSummary.steps,
      lastActivityMs: workerLastMs,
      taskLogBytes: transcriptSummary.backgroundTaskBytes ?? 0,
      awaitingApproval: Boolean(transcriptSummary.awaitingApproval),
      failure: transcriptSummary.failure?.message ?? null,
    });

    if (isStale) {
      staleWorkerKeys.push(workerKey);
      staleCount++;
    } else {
      if (transcriptSummary.awaitingApproval) awaitingApproval = true;
      activeWorkerConversations.push(workerKey);
      activeCount++;
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

  const boardHeadSeq = board.messages.at(-1)?.seq ?? 0;
  const rawLatestPost = [...board.messages].reverse().find(post => !post.control) ?? board.messages.at(-1) ?? null;
  let latestPost = null;
  if (rawLatestPost) {
    const previewLine = rawLatestPost.text.split(/\r?\n/).find(line => line.trim())?.trim() ?? '';
    latestPost = {
      seq: rawLatestPost.seq,
      agent: rawLatestPost.agent,
      channel: rawLatestPost.channel || 'main',
      preview: previewLine.slice(0, 120),
      time: rawLatestPost.time,
    };
    bumpActivity(getPostRefMs(rawLatestPost));
  }

  const statusRank = { active: 0, stale: 1, waiting: 2 };
  progressWorkers.sort((a, b) => statusRank[a.status] - statusRank[b.status] || a.name.localeCompare(b.name));
  const title = typeof membersDoc.title === 'string' && membersDoc.title.trim() ? membersDoc.title.trim() : null;

  const signature = [
    `m:${Math.round(membersFile.mtimeMs)}:${membersFile.size}`,
    `b:${boardHeadSeq}:${Math.round(board.mtimeMs)}:${board.size}`,
    ...workerSignatureParts.sort(),
  ].join('|');

  return {
    exists: true,
    active: activeWorkerConversations.length > 0 || hasPendingWakeup,
    activeWorkerConversations: activeWorkerConversations.filter(id => UUID_RE.test(id)),
    staleWorkerConversations: staleWorkerKeys.filter(id => UUID_RE.test(id)),
    hasWorkingTaskWorkers: activeWorkerConversations.length > 0,
    hasPendingWakeup,
    awaitingApproval,
    workingWorkers,
    signature,
    progress: {
      title,
      headSeq: boardHeadSeq,
      activeCount,
      waitingCount,
      staleCount,
      hasPendingWakeup,
      awaitingApproval,
      lastActivityMs: lastProgressActivityMs,
      workers: progressWorkers,
      latestPost,
    },
  };
}
