import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { UUID_RE } from './swarm-state.mjs';

const MAX_FINAL_STEP_DURATION_MS = 30 * 60 * 1000;
const PREFIX_LIMIT = 120;
const MIN_PREFIX_MATCH_LEN = 16;

export function resolveAgyDataDir(env = process.env) {
  return resolve(
    env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
      join(
        env.HOME || env.USERPROFILE || homedir(),
        '.gemini',
        env.ANTIGRAVITY_CONFIG_REL_DIR || 'antigravity-cli',
      ),
  );
}

function parseIsoMs(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractCompletedAtIso(content) {
  if (typeof content !== 'string' || !content) return null;
  const match = /^Completed At:\s*(\d{4}-\d{2}-\d{2}T[^\s]+)/m.exec(content);
  if (!match) return null;
  const ms = parseIsoMs(match[1]);
  return ms === null ? null : new Date(ms).toISOString();
}

function extractUserRequestText(raw) {
  if (typeof raw !== 'string') return '';
  const match = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(raw);
  if (match) return match[1].trim();
  return raw.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '').trim();
}

function normalizePrefix(text, maxLen = PREFIX_LIMIT) {
  if (typeof text !== 'string') return '';
  return text.trim().replace(/\s+/g, ' ').slice(0, maxLen);
}

function prefixesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < MIN_PREFIX_MATCH_LEN) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function orderTranscriptRows(rows) {
  const byStep = new Map();
  const unindexed = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (Number.isInteger(row.step_index)) {
      byStep.set(row.step_index, row);
    } else {
      unindexed.push(row);
    }
  }
  const indexed = [...byStep.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
  return [...indexed, ...unindexed];
}

/**
 * Derive an ordered list of replay-matchable timeline timestamp entries from AGY transcript JSONL rows.
 */
export function buildHistoryTimestampEntries(
  rows,
  { fileMtimeMs, maxFinalStepDurationMs = MAX_FINAL_STEP_DURATION_MS } = {},
) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const ordered = orderTranscriptRows(rows);
  if (ordered.length === 0) return [];

  const lastRow = ordered.at(-1);
  const lastRowCreatedMs = parseIsoMs(lastRow?.created_at);
  const roundedMtime = Number.isFinite(fileMtimeMs) ? Math.round(fileMtimeMs) : null;
  const finalMtimeIso =
    roundedMtime !== null &&
    lastRowCreatedMs !== null &&
    lastRow?.status === 'DONE' &&
    roundedMtime >= lastRowCreatedMs &&
    roundedMtime - lastRowCreatedMs <= maxFinalStepDurationMs
      ? new Date(roundedMtime).toISOString()
      : null;

  const entries = [];
  let lastTimestampMs = 0;

  const clampIso = iso => {
    const ms = parseIsoMs(iso);
    if (ms === null) return null;
    const clamped = Math.max(ms, lastTimestampMs);
    lastTimestampMs = clamped;
    return new Date(clamped).toISOString();
  };

  for (let i = 0; i < ordered.length; i++) {
    const row = ordered[i];
    if (row.type === 'USER_INPUT') {
      const timestamp = clampIso(row.created_at);
      if (!timestamp) continue;
      entries.push({
        kind: 'user_message',
        textPrefix: normalizePrefix(extractUserRequestText(row.content)),
        isExplicit: row.source === 'USER_EXPLICIT',
        timestamp,
      });
      continue;
    }

    if (row.type !== 'PLANNER_RESPONSE') continue;
    const stepStartIso = clampIso(row.created_at);
    if (!stepStartIso) continue;

    const toolResults = [];
    for (let j = i + 1; j < ordered.length && ordered[j]?.type === 'GENERIC'; j++) {
      toolResults.push(ordered[j]);
    }

    if (typeof row.thinking === 'string' && row.thinking.trim()) {
      entries.push({
        kind: 'reasoning',
        textPrefix: normalizePrefix(row.thinking),
        timestamp: stepStartIso,
      });
    }

    const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    if (typeof row.content === 'string' && row.content.trim()) {
      const contentIso =
        toolCalls.length === 0 && i === ordered.length - 1 && finalMtimeIso
          ? clampIso(finalMtimeIso)
          : stepStartIso;
      entries.push({
        kind: 'assistant_message',
        textPrefix: normalizePrefix(row.content),
        timestamp: contentIso ?? stepStartIso,
      });
    }

    for (let k = 0; k < toolCalls.length; k++) {
      const res = toolResults[k];
      const isLastTranscriptRow = i + 1 + k === ordered.length - 1;
      const candidateIso =
        extractCompletedAtIso(res?.content) ??
        (isLastTranscriptRow && finalMtimeIso ? finalMtimeIso : null) ??
        (parseIsoMs(res?.created_at) !== null ? res.created_at : null) ??
        stepStartIso;
      entries.push({
        kind: 'tool_call',
        name: String(toolCalls[k]?.name ?? '').trim().toLowerCase(),
        timestamp: clampIso(candidateIso) ?? stepStartIso,
      });
    }
  }

  return entries;
}

/**
 * Matches streamed `session/load` replay timeline items forward against transcript timestamps
 * without crossing user-turn boundaries, caching by item ID across chunk updates.
 */
export class HistoryTimestampMatcher {
  constructor(entries) {
    this.entries = Array.isArray(entries) ? entries : [];
    this.cursor = 0;
    this.consumed = new Set();
    this.assignedByItemId = new Map();
    this.lastAssignedTimestamp = null;
  }

  advanceCursor() {
    while (this.cursor < this.entries.length && this.consumed.has(this.cursor)) {
      this.cursor += 1;
    }
  }

  findTurnEnd() {
    for (let i = this.cursor; i < this.entries.length; i++) {
      if (this.entries[i].kind === 'user_message' && !this.consumed.has(i)) {
        return i;
      }
    }
    return this.entries.length;
  }

  findInRange(start, end, predicate) {
    for (let i = start; i < end; i++) {
      if (!this.consumed.has(i) && predicate(this.entries[i])) {
        return i;
      }
    }
    return -1;
  }

  assign(itemId, index, { moveCursorToNext = false } = {}) {
    const timestamp = this.entries[index].timestamp;
    this.consumed.add(index);
    if (moveCursorToNext) {
      this.cursor = Math.max(this.cursor, index + 1);
    }
    this.advanceCursor();
    this.lastAssignedTimestamp = timestamp;
    if (typeof itemId === 'string' && itemId) {
      this.assignedByItemId.set(itemId, timestamp);
    }
    return timestamp;
  }

  cacheFallback(itemId) {
    if (!this.lastAssignedTimestamp) return undefined;
    if (typeof itemId === 'string' && itemId) {
      this.assignedByItemId.set(itemId, this.lastAssignedTimestamp);
    }
    return this.lastAssignedTimestamp;
  }

  match(item) {
    if (!item || typeof item !== 'object') return undefined;
    const itemId = typeof item.id === 'string' && item.id ? item.id : undefined;
    if (itemId && this.assignedByItemId.has(itemId)) {
      return this.assignedByItemId.get(itemId);
    }

    if (item.type === 'user_message') {
      const prefix = normalizePrefix(item.text);
      const end = this.entries.length;
      let idx = -1;
      if (prefix) {
        idx = this.findInRange(
          this.cursor,
          end,
          entry => entry.kind === 'user_message' && prefixesMatch(entry.textPrefix, prefix),
        );
      }
      if (idx === -1) {
        idx = this.findInRange(this.cursor, end, entry => entry.kind === 'user_message' && entry.isExplicit);
      }
      if (idx === -1) {
        idx = this.findInRange(this.cursor, end, entry => entry.kind === 'user_message');
      }
      if (idx !== -1) {
        return this.assign(itemId, idx, { moveCursorToNext: true });
      }
      return this.cacheFallback(itemId);
    }

    const turnEnd = this.findTurnEnd();

    if (item.type === 'assistant_message' || item.type === 'reasoning') {
      const prefix = normalizePrefix(item.text);
      let idx = -1;
      if (prefix) {
        idx = this.findInRange(
          this.cursor,
          turnEnd,
          entry => entry.kind === item.type && prefixesMatch(entry.textPrefix, prefix),
        );
      }
      if (idx === -1) {
        idx = this.findInRange(this.cursor, turnEnd, entry => entry.kind === item.type);
      }
      if (idx !== -1) {
        return this.assign(itemId, idx);
      }
      return this.cacheFallback(itemId);
    }

    if (item.type === 'tool_call') {
      const name = String(item.name ?? '').trim().toLowerCase();
      let idx = -1;
      if (name) {
        idx = this.findInRange(
          this.cursor,
          turnEnd,
          entry =>
            entry.kind === 'tool_call' &&
            Boolean(entry.name) &&
            (entry.name === name || name.includes(entry.name)),
        );
      }
      if (idx === -1) {
        idx = this.findInRange(this.cursor, turnEnd, entry => entry.kind === 'tool_call');
      }
      if (idx !== -1) {
        return this.assign(itemId, idx);
      }
      return this.cacheFallback(itemId);
    }

    return this.cacheFallback(itemId);
  }
}

/**
 * Load a `HistoryTimestampMatcher` from the local AGY transcript for `nativeSessionId`.
 * Returns `null` when the transcript is missing, unreadable, or contains no timestamped steps.
 */
export async function loadHistoryTimestampMatcher({ nativeSessionId, env = process.env, dataDir } = {}) {
  if (typeof nativeSessionId !== 'string' || !UUID_RE.test(nativeSessionId)) return null;
  const root = dataDir ?? resolveAgyDataDir(env);
  const logsDir = join(root, 'brain', nativeSessionId.toLowerCase(), '.system_generated', 'logs');
  const candidates = [join(logsDir, 'transcript.jsonl'), join(logsDir, 'transcript_full.jsonl')];

  for (const path of candidates) {
    let info;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (!info.isFile() || info.size === 0) continue;

    let raw;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      continue;
    }

    const rows = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed/partial trailing JSONL line gracefully during history reads.
      }
    }

    const entries = buildHistoryTimestampEntries(rows, { fileMtimeMs: info.mtimeMs });
    if (entries.length > 0) {
      return new HistoryTimestampMatcher(entries);
    }
  }

  return null;
}
