import { open, stat } from 'node:fs/promises';
import { SWARM_TOOLS } from './swarm-state.mjs';

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CREATED_SUBAGENT_RE = new RegExp(
  `(?:^|\\n)Created the following subagent:\\s*\\{[\\s\\S]*?"conversationId"\\s*:\\s*"(${UUID_PATTERN})"`,
  'i',
);
const DIRECT_SUBAGENT_MSG_RE = new RegExp(
  `\\[Message\\][^\\n]*\\bsender=(${UUID_PATTERN})\\b[^\\n]*\\bcontent=([\\s\\S]*?)(?:\\n<\\/SYSTEM_MESSAGE>|$)`,
  'i',
);
const SYSTEM_SUBAGENT_IDLE_RE = new RegExp(
  `\\bcontent=Subagent "?(${UUID_PATTERN})"? (has gone idle\\. This was the subagent's most recent response:\\s*([\\s\\S]*?)|went idle without reporting anything back[\\s\\S]*?|has been explicitly canceled[\\s\\S]*?)(?:\\n<\\/SYSTEM_MESSAGE>|$)`,
  'gi',
);
const SERVER_RESTART_NOTICE_RE =
  /\bcontent=\[Notice\] All your subagents and background tasks have been stopped due to server restart\./;

// Read only additions, and recover if AGY replaces or rewrites its JSONL snapshot.
export class TranscriptTail {
  constructor(path) {
    this.path = path;
    this.compactPath = path;
    this.fullPath = /transcript\.jsonl$/.test(path) ? path.replace(/transcript\.jsonl$/, 'transcript_full.jsonl') : null;
    this.activePath = null;
    this.offset = 0;
    this.inode = null;
    this.anchor = '';
    this.partial = Buffer.alloc(0);
    this.baseline = -1;
  }

  async resolvePath() {
    if (this.activePath) return this.activePath;
    if (this.fullPath) {
      try {
        await stat(this.fullPath);
        this.activePath = this.fullPath;
        return this.activePath;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    try {
      const info = await stat(this.compactPath);
      if (info.size > 0) {
        this.activePath = this.compactPath;
        return this.activePath;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return null;
  }

  async begin() {
    const targetPath = await this.resolvePath();
    if (!targetPath) return;
    let file;
    try {
      file = await open(targetPath, 'r');
      const info = await file.stat();
      const size = Math.min(info.size, 8 * 1024 * 1024);
      const buffer = Buffer.alloc(size);
      await file.read(buffer, 0, size, info.size - size);
      let tail = buffer.toString('utf8');
      if (size < info.size) tail = tail.slice(tail.indexOf('\n') + 1);
      const lines = tail.split('\n');
      for (const line of lines.slice(0, -1)) {
        try {
          const row = JSON.parse(line);
          if (Number.isInteger(row.step_index)) this.baseline = Math.max(this.baseline, row.step_index);
        } catch {}
      }
      if (info.size > 0 && this.baseline < 0) throw new Error('Cannot establish AGY transcript position');
      this.offset = info.size - Buffer.byteLength(lines.at(-1) ?? '');
      this.inode = info.ino;
      await this.saveAnchor(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally {
      await file?.close();
    }
  }

  async saveAnchor(file) {
    const bytes = Math.min(64, this.offset);
    const buffer = Buffer.alloc(bytes);
    await file.read(buffer, 0, bytes, this.offset - bytes);
    this.anchor = buffer.toString('hex');
  }

  async read() {
    const targetPath = await this.resolvePath();
    if (!targetPath) return [];
    let info;
    try {
      info = await stat(targetPath);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const file = await open(targetPath, 'r');
    try {
      const bytes = Math.min(64, this.offset);
      const check = Buffer.alloc(bytes);
      if (info.size >= this.offset) await file.read(check, 0, bytes, this.offset - bytes);
      if (info.ino !== this.inode || info.size < this.offset || check.toString('hex') !== this.anchor) {
        this.offset = 0;
        this.partial = Buffer.alloc(0);
        this.inode = info.ino;
      }
      const rows = [];
      while (this.offset < info.size) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, info.size - this.offset));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        let pending = Buffer.concat([this.partial, buffer.subarray(0, bytesRead)]);
        let newline;
        while ((newline = pending.indexOf(10)) !== -1) {
          const line = pending.subarray(0, newline).toString('utf8');
          pending = pending.subarray(newline + 1);
          if (!line.trim()) continue;
          let raw;
          try {
            raw = JSON.parse(line);
          } catch {
            throw new Error('Invalid AGY transcript JSONL record');
          }
          if (Number.isInteger(raw.step_index) && raw.step_index > this.baseline) {
            rows.push(raw);
          }
        }
        if (pending.length > 8 * 1024 * 1024) throw new Error('AGY transcript line exceeds 8 MiB');
        this.partial = Buffer.from(pending);
      }
      await this.saveAnchor(file);
      return rows;
    } finally {
      await file.close();
    }
  }
}

function decodeArgs(args = {}) {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      if (typeof value !== 'string') return [key, value];
      try {
        return [key, JSON.parse(value)];
      } catch {
        return [key, value];
      }
    }),
  );
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, stable(value[key])]),
    );
  }
  return value;
}

export function signature(name, args) {
  return JSON.stringify([name, stable(args)]);
}

function toolKind(name) {
  if (name === 'run_command') return 'execute';
  if (['read_file', 'view_file', 'list_dir'].includes(name)) return 'read';
  if (['edit_file', 'write_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(name)) {
    return 'edit';
  }
  if (['grep_search', 'find_by_name', 'search_web'].includes(name)) return 'search';
  return 'other';
}

function header(content) {
  return content.split(/\nCommand output:/)[0];
}

function exitCode(content) {
  const match = /Command exited with code (-?\d+)\./.exec(header(content));
  return match ? Number(match[1]) : undefined;
}

function matchForegroundGroups(groups, plannerRows, textField = 'content') {
  const covered = new Set();
  let foregroundEnd = -1;
  let cursor = 0;
  for (const rawGroup of groups) {
    const target = rawGroup.trim();
    if (!target) continue;
    for (let start = cursor; start < plannerRows.length; start++) {
      const first = (plannerRows[start][textField] ?? '').trim();
      if (first === target) {
        covered.add(plannerRows[start].step_index);
        foregroundEnd = Math.max(foregroundEnd, plannerRows[start].step_index);
        cursor = start + 1;
        break;
      }
      if (!target.startsWith(first)) continue;
      let joined = first;
      let matchedEnd = -1;
      for (let end = start + 1; end < plannerRows.length; end++) {
        const piece = (plannerRows[end][textField] ?? '').trim();
        const direct = joined + piece;
        const spaced = joined + '\n' + piece;
        if (direct === target || spaced === target) {
          matchedEnd = end;
          break;
        }
        if (target.startsWith(direct)) joined = direct;
        else if (target.startsWith(spaced)) joined = spaced;
        else break;
      }
      if (matchedEnd !== -1) {
        for (let idx = start; idx <= matchedEnd; idx++) {
          covered.add(plannerRows[idx].step_index);
          foregroundEnd = Math.max(foregroundEnd, plannerRows[idx].step_index);
        }
        cursor = matchedEnd + 1;
        break;
      }
    }
  }
  return { covered, foregroundEnd };
}

export class BackgroundProjection {
  constructor(sessionId, emit) {
    this.sessionId = sessionId;
    this.emit = emit;
    this.rows = new Map();
    this.tools = new Map();
    this.groups = [];
    this.currentGroup = null;
    this.thoughtGroups = [];
    this.currentThoughtGroup = null;
    this.sent = new Map();
    this.covered = new Set();
    this.coveredThoughts = new Set();
    this.foregroundEnd = -1;
    this.closedForegroundToolIds = new Set();
    this.drainedThoughts = [];
    this.drainedMessages = [];
    this.drainedToolSigs = [];
    this.expectedUserInputs = 1;
    this.usageForegroundEnd = null;
  }

  freezeUsageForegroundEnd() {
    if (this.usageForegroundEnd === null) {
      this.usageForegroundEnd = this.foregroundEnd;
    }
  }

  beginSteer() {
    let currentInputs = 0;
    for (const row of this.rows.values()) {
      if (row.type === 'USER_INPUT') currentInputs++;
    }
    this.expectedUserInputs = Math.max(this.expectedUserInputs, currentInputs) + 1;
    this.currentGroup = null;
    this.currentThoughtGroup = null;
  }

  observe(update) {
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      if (this.currentGroup === null) {
        this.groups.push('');
        this.currentGroup = this.groups.length - 1;
      }
      this.groups[this.currentGroup] += update.content.text;
      this.currentThoughtGroup = null;
    } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') {
      if (this.currentThoughtGroup === null) {
        this.thoughtGroups.push('');
        this.currentThoughtGroup = this.thoughtGroups.length - 1;
      }
      this.thoughtGroups[this.currentThoughtGroup] += update.content.text;
      this.currentGroup = null;
    } else if (['tool_call', 'user_message_chunk', 'plan'].includes(update.sessionUpdate)) {
      this.currentGroup = null;
      this.currentThoughtGroup = null;
    }
    if (!['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) return;
    const old = this.tools.get(update.toolCallId) ?? {};
    this.tools.set(update.toolCallId, {
      ...old,
      id: update.toolCallId,
      name: update.name ?? old.name ?? update.title,
      input: update.rawInput ?? old.input,
      status: update.status ?? old.status,
    });
  }

  hasOpenForegroundTools() {
    for (const tool of this.tools.values()) {
      if (tool.status === 'pending' || tool.status === 'in_progress') return true;
    }
    return false;
  }

  flushCompletedForegroundTools() {
    this.inspect({ publish: false, flushForegroundOnly: true });
  }

  takeStaleReplaySnapshot() {
    return {
      closedForegroundToolIds: [...this.closedForegroundToolIds],
      thoughts: [...this.drainedThoughts],
      messages: [...this.drainedMessages],
      toolSigs: [...this.drainedToolSigs],
    };
  }

  hasVisibleOutput() {
    if (this.groups.some(group => typeof group === 'string' && group.trim().length > 0)) return true;
    if (this.tools.size > 0 || this.sent.size > 0) return true;
    for (const row of this.rows.values()) {
      if (row.type !== 'PLANNER_RESPONSE') continue;
      if (typeof row.content === 'string' && row.content.trim().length > 0) return true;
      if (Array.isArray(row.tool_calls) && row.tool_calls.length > 0) return true;
    }
    return false;
  }

  add(rows) {
    for (const row of rows) this.rows.set(row.step_index, row);
  }

  notify(update) {
    this.emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: this.sessionId, update } });
  }

  once(key, value, update) {
    const encoded = JSON.stringify(value);
    if (this.sent.get(key) === encoded) return false;
    this.sent.set(key, encoded);
    this.notify(update);
    return true;
  }

  inspect({ publish = false, flushForegroundOnly = false } = {}) {
    const rows = [...this.rows.values()].sort((a, b) => a.step_index - b.step_index);
    if (rows.filter(row => row.type === 'USER_INPUT').length > this.expectedUserInputs) {
      return { seenBackground: true, foreignInput: true, drained: false };
    }
    const matchedTools = new Set();
    const calls = new Map();
    for (const row of rows) {
      const refs = (row.tool_calls ?? []).map((call, index) => {
        const input = decodeArgs(call.args);
        const key = `${row.step_index}:${index}`;
        const raw = this.sent.has(`call:${key}`)
          ? undefined
          : [...this.tools.values()].find(
              tool => !matchedTools.has(tool.id) && signature(tool.name, tool.input) === signature(call.name, input),
            );
        if (raw) {
          matchedTools.add(raw.id);
          this.foregroundEnd = Math.max(this.foregroundEnd, row.step_index);
        }
        return { key, id: raw?.id ?? `agy:${this.sessionId}:${key}`, name: call.name, input, raw };
      });
      if (refs.length) calls.set(row.step_index, refs);
    }
    const plannerRows = rows.filter(
      row => row.type === 'PLANNER_RESPONSE' && row.content?.trim() && !this.sent.has(`message:${row.step_index}`),
    );
    const groupMatch = matchForegroundGroups(this.groups, plannerRows, 'content');
    for (const step of groupMatch.covered) this.covered.add(step);
    this.foregroundEnd = Math.max(this.foregroundEnd, groupMatch.foregroundEnd);

    const thoughtRows = rows.filter(
      row => row.type === 'PLANNER_RESPONSE' && row.thinking?.trim() && !this.sent.has(`thought:${row.step_index}`),
    );
    const thoughtMatch = matchForegroundGroups(this.thoughtGroups, thoughtRows, 'thinking');
    for (const step of thoughtMatch.covered) this.coveredThoughts.add(step);
    this.foregroundEnd = Math.max(this.foregroundEnd, thoughtMatch.foregroundEnd);
    const usageBoundary = this.usageForegroundEnd ?? this.foregroundEnd;

    const queue = [];
    const pending = new Map();
    const tasks = new Map();
    const knownSubagents = new Map();
    const subagents = new Map();
    const settledSubagents = new Map();
    let seenBackground = false;
    let seenSwarm = false;
    let lastWake = -1;
    let latest = null;
    let lastPlannerStep = -1;
    let lastPlannerCalls = [];
    let genericsSinceLastPlanner = [];
    let failure;
    const extraUsage = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, totalTokens: 0 };

    const markForegroundToolClosed = (ref, status) => {
      if (!ref.raw) return;
      const existing = this.tools.get(ref.id);
      if (existing) existing.status = status;
      this.closedForegroundToolIds.add(ref.id);
    };

    const complete = (ref, content, failed = false, extraOutput = {}) => {
      pending.delete(ref.key);
      const isForegroundOpen =
        ref.raw &&
        (this.tools.get(ref.id)?.status === 'pending' || this.tools.get(ref.id)?.status === 'in_progress');
      if (!publish && !(flushForegroundOnly && isForegroundOpen)) return;
      if (flushForegroundOnly && !isForegroundOpen) return;
      const code = exitCode(content);
      const status = failed || (code !== undefined && code !== 0) ? 'failed' : 'completed';
      const rawOutput = { output: content, ...(code !== undefined ? { exit_code: code } : {}), ...extraOutput };
      this.once(`result:${ref.key}`, [status, rawOutput], {
        sessionUpdate: 'tool_call_update',
        toolCallId: ref.id,
        status,
        rawOutput,
      });
      markForegroundToolClosed(ref, status);
    };

    const settleSubagent = (subId, output, failed = false) => {
      const entry = subagents.get(subId) ?? knownSubagents.get(subId);
      subagents.delete(subId);
      if (entry) settledSubagents.set(entry.ref.key, { ref: entry.ref, subId, output, failed });
    };

    for (const row of rows) {
      if (['PLANNER_RESPONSE', 'GENERIC', 'SYSTEM_MESSAGE', 'ERROR_MESSAGE'].includes(row.type)) latest = row;
      if (
        (row.type === 'ERROR_MESSAGE' && row.status === 'ERROR') ||
        (row.type === 'PLANNER_RESPONSE' && row.status === 'ERROR')
      ) {
        failure = row.error || row.content || 'AGY background task processing failed';
      }
      if (row.type === 'PLANNER_RESPONSE') {
        const refs = calls.get(row.step_index) ?? [];
        lastPlannerStep = row.step_index;
        lastPlannerCalls = refs;
        genericsSinceLastPlanner = [];
        if (
          publish &&
          row.step_index > this.foregroundEnd &&
          !this.coveredThoughts.has(row.step_index) &&
          row.status === 'DONE' &&
          row.thinking?.trim()
        ) {
          const thoughtKey = `thought:${row.step_index}`;
          if (!this.sent.has(thoughtKey)) {
            this.sent.set(thoughtKey, row.thinking);
            this.drainedThoughts.push(row.thinking);
            this.notify({
              sessionUpdate: 'agent_thought_chunk',
              messageId: `agy:${this.sessionId}:thought:${row.step_index}`,
              content: { type: 'text', text: row.thinking },
            });
          }
        }
        if (
          publish &&
          row.step_index > this.foregroundEnd &&
          !this.covered.has(row.step_index) &&
          row.status === 'DONE' &&
          row.content
        ) {
          const key = `message:${row.step_index}`;
          if (!this.sent.has(key)) {
            this.sent.set(key, row.content);
            this.drainedMessages.push(row.content);
            this.notify({
              sessionUpdate: 'agent_message_chunk',
              messageId: `agy:${this.sessionId}:message:${row.step_index}`,
              content: { type: 'text', text: row.content },
            });
          }
        }
        for (const ref of refs) {
          if (SWARM_TOOLS.has(ref.name)) seenSwarm = true;
          queue.push(ref);
          pending.set(ref.key, ref);
          if (publish && !ref.raw && row.step_index > this.foregroundEnd) {
            const emittedCall = this.once(`call:${ref.key}`, [ref.name, ref.input], {
              sessionUpdate: 'tool_call',
              toolCallId: ref.id,
              name: ref.name,
              title: ref.name,
              kind: toolKind(ref.name),
              status: 'in_progress',
              rawInput: ref.input,
            });
            if (emittedCall) this.drainedToolSigs.push(signature(ref.name, ref.input));
          }
        }
        if (row.step_index > usageBoundary && row.status === 'DONE') {
          const input = row.input_tokens ?? 0;
          const output = row.output_tokens ?? 0;
          const cached = row.cache_read_tokens ?? 0;
          extraUsage.inputTokens += input;
          extraUsage.outputTokens += output;
          extraUsage.cachedReadTokens += cached;
          extraUsage.totalTokens += input + output + cached;
        }
      } else if (row.type === 'USER_INPUT' && row.step_index > usageBoundary) {
        lastPlannerStep = -1;
        lastPlannerCalls = [];
        genericsSinceLastPlanner = [];
        lastWake = Math.max(lastWake, row.step_index);
      } else if (row.type === 'GENERIC' && queue.length) {
        genericsSinceLastPlanner.push(row);
        const ref = queue.shift();
        const content = row.content ?? '';
        const isDaemon = ref.name === 'run_command' && ref.input?.IsDaemon === true;
        const task =
          ref.name === 'run_command' && !isDaemon
            ? /(?:^|\n)Tool is running as a background task with task id: ([^\s]+)/.exec(header(content))?.[1]
            : undefined;
        const createdSubId =
          ref.name === 'invoke_subagent' && row.status === 'DONE'
            ? CREATED_SUBAGENT_RE.exec(content)?.[1]?.toLowerCase()
            : undefined;
        if (
          task?.startsWith(this.sessionId + '/task-') &&
          /^task-\d+$/.test(task.slice(this.sessionId.length + 1))
        ) {
          seenBackground = true;
          tasks.set(task, ref);
        } else if (createdSubId) {
          seenBackground = true;
          pending.delete(ref.key);
          const entry = { ref, launchContent: content };
          knownSubagents.set(createdSubId, entry);
          subagents.set(createdSubId, entry);
          settledSubagents.delete(ref.key);
        } else if (row.status === 'DONE' || row.status === 'ERROR') {
          if (ref.name === 'send_message' && row.status === 'DONE') {
            const recipient = typeof ref.input?.Recipient === 'string' ? ref.input.Recipient.toLowerCase() : undefined;
            const target = recipient ? knownSubagents.get(recipient) : undefined;
            if (target) {
              seenBackground = true;
              subagents.set(recipient, target);
              settledSubagents.delete(target.ref.key);
            }
          } else if (ref.name === 'manage_subagents' && row.status === 'DONE') {
            const action = ref.input?.Action;
            if (action === 'kill_all' && subagents.size > 0) {
              for (const subId of [...subagents.keys()]) settleSubagent(subId, content, false);
              lastWake = Math.max(lastWake, row.step_index);
            } else if (action === 'kill' && Array.isArray(ref.input?.ConversationIds)) {
              for (const rawId of ref.input.ConversationIds) {
                const subId = typeof rawId === 'string' ? rawId.toLowerCase() : '';
                if (subagents.has(subId)) {
                  settleSubagent(subId, content, false);
                  lastWake = Math.max(lastWake, row.step_index);
                }
              }
            } else if (action === 'list' && subagents.size > 0) {
              if (/\b(?:no|0) active subagents?\b/i.test(content)) {
                for (const subId of [...subagents.keys()]) settleSubagent(subId, content, false);
                lastWake = Math.max(lastWake, row.step_index);
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
                      for (const subId of [...subagents.keys()]) {
                        if (!running.has(subId)) {
                          settleSubagent(subId, content, false);
                          lastWake = Math.max(lastWake, row.step_index);
                        }
                      }
                    }
                  } catch {}
                }
              }
            }
          }
          if (ref.raw?.status === 'completed' || ref.raw?.status === 'failed') pending.delete(ref.key);
          else complete(ref, content, row.status === 'ERROR' || !!row.error);
        }
      } else if (row.type === 'SYSTEM_MESSAGE') {
        lastPlannerStep = -1;
        lastPlannerCalls = [];
        genericsSinceLastPlanner = [];
        if (row.step_index > this.foregroundEnd) {
          lastWake = Math.max(lastWake, row.step_index);
        }
        const content = row.content ?? '';
        const match =
          /content=Task id "([^"]+)" (finished|completed|failed|stopped|killed|terminated|canceled|cancelled) with result:\n([\s\S]*?)(?:\n<\/SYSTEM_MESSAGE>|$)/.exec(
            content,
          );
        const ref = match && tasks.get(match[1]);
        if (ref) {
          tasks.delete(match[1]);
          lastWake = Math.max(lastWake, row.step_index);
          complete(ref, match[3], !['finished', 'completed'].includes(match[2]));
        }
        const directSub = DIRECT_SUBAGENT_MSG_RE.exec(content);
        if (directSub && knownSubagents.has(directSub[1].toLowerCase())) {
          settleSubagent(directSub[1].toLowerCase(), directSub[2].trim(), false);
          lastWake = Math.max(lastWake, row.step_index);
        }
        for (const idleMatch of content.matchAll(SYSTEM_SUBAGENT_IDLE_RE)) {
          const subId = idleMatch[1].toLowerCase();
          if (!knownSubagents.has(subId)) continue;
          const canceled = /^has been explicitly canceled/i.test(idleMatch[2]);
          const report = idleMatch[3] !== undefined ? idleMatch[3].trim() : idleMatch[2].trim();
          settleSubagent(subId, report, canceled);
          lastWake = Math.max(lastWake, row.step_index);
        }
        if (SERVER_RESTART_NOTICE_RE.test(content) && (tasks.size > 0 || subagents.size > 0)) {
          for (const [taskId, taskRef] of [...tasks.entries()]) {
            tasks.delete(taskId);
            complete(taskRef, 'Stopped due to server restart', true);
          }
          for (const subId of [...subagents.keys()]) {
            settleSubagent(subId, 'Stopped due to server restart', true);
          }
          lastWake = Math.max(lastWake, row.step_index);
        }
      }
    }

    if (publish) {
      for (const [subId, entry] of subagents.entries()) {
        const rawOutput = { conversationId: subId, output: entry.launchContent };
        this.once(`result:${entry.ref.key}`, ['in_progress', rawOutput], {
          sessionUpdate: 'tool_call_update',
          toolCallId: entry.ref.id,
          status: 'in_progress',
          rawOutput,
        });
      }
      for (const settled of settledSubagents.values()) {
        if ([...subagents.values()].some(entry => entry.ref.key === settled.ref.key)) continue;
        complete(settled.ref, settled.output, settled.failed, { conversationId: settled.subId });
      }
    }

    const totalPendingBg = tasks.size + subagents.size;
    const swarmWaitIdx = lastPlannerCalls.findIndex(ref => ref.name === 'swarm_wait');
    const parkedOnSwarmWait =
      lastPlannerStep > lastWake &&
      swarmWaitIdx !== -1 &&
      genericsSinceLastPlanner.length >= lastPlannerCalls.length &&
      genericsSinceLastPlanner[swarmWaitIdx]?.status === 'DONE';
    const coordinatorSettled =
      totalPendingBg === 0 &&
      pending.size === 0 &&
      ((latest?.type === 'PLANNER_RESPONSE' &&
        latest.status === 'DONE' &&
        !latest.tool_calls?.length &&
        latest.step_index > lastWake) ||
        parkedOnSwarmWait);

    const hasPostForegroundWork = rows.some(
      row =>
        row.step_index > this.foregroundEnd &&
        ['PLANNER_RESPONSE', 'SYSTEM_MESSAGE', 'ERROR_MESSAGE'].includes(row.type),
    );

    return {
      seenBackground,
      seenSwarm,
      hasPostForegroundWork,
      parkedOnSwarmWait,
      coordinatorSettled,
      pendingTasks: totalPendingBg,
      activeSubagents: [...subagents.keys()],
      pendingTools: pending.size,
      failure,
      extraUsage,
      awaitingCommandStart:
        latest?.type === 'PLANNER_RESPONSE' &&
        (calls.get(latest.step_index) ?? []).some(ref => ref.name === 'run_command' && pending.has(ref.key)),
      drained: seenBackground && coordinatorSettled,
    };
  }
}
