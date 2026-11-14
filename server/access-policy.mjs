import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

export const FULL_ACCESS = 'full-access';
const FULL_DESCRIPTION = 'Automatically approve tool permission requests in this ACP session. AGY deny rules and OS restrictions still apply.';

function canonical(path) {
  const missing = [];
  let current = path;
  for (;;) {
    try {
      return resolve(realpathSync(current), ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return null;
      const parent = dirname(current);
      if (parent === current) return null;
      missing.push(basename(current));
      current = parent;
    }
  }
}

export function isAllowedRead(params, roots, cwd) {
  const call = params?.toolCall;
  const input = call?.rawInput;
  if (!call || !input || typeof input !== 'object' || Array.isArray(input)) return false;
  const fields = {
    read_file: 'Path',
    view_file: 'AbsolutePath',
    list_dir: 'DirectoryPath',
    grep_search: 'SearchPath',
    find_by_name: 'SearchDirectory',
  };
  const field = fields[call.name];
  if (!field || typeof input[field] !== 'string' || !input[field]) return false;
  if (call.kind && !['read', 'search'].includes(call.kind)) return false;
  if (['CommandLine', 'command', 'script', 'Code'].some(key => key in input)) return false;
  if (!isAbsolute(input[field]) && !cwd) return false;
  const path = canonical(resolve(cwd ?? '/', input[field]));
  if (!path) return false;
  return roots.some(root => {
    const expanded = root.startsWith('~/') ? resolve(homedir(), root.slice(2)) : resolve(root);
    const real = canonical(expanded);
    if (!real) return false;
    const rel = relative(real, path);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
  });
}

function allowOnce(params) {
  // Never create persistent grants as a side effect of this bridge policy.
  return params.options?.find(option => option.kind === 'allow_once');
}

function patchOptions(options, full) {
  if (!Array.isArray(options)) return;
  for (const option of options) {
    if (option.category !== 'mode' && option.id !== 'mode') continue;
    if (full) option.currentValue = FULL_ACCESS;
    if (
      option.type === 'select' &&
      Array.isArray(option.options) &&
      !option.options.some(o => o.value === FULL_ACCESS)
    ) {
      option.options.push({ value: FULL_ACCESS, name: 'Full access', description: FULL_DESCRIPTION });
    }
  }
}

export class AccessPolicy {
  constructor(roots) {
    this.roots = roots;
    this.sessions = new Map();
    this.pending = new Map();
  }

  session(id) {
    if (!this.sessions.has(id)) this.sessions.set(id, { full: false, cwd: null });
    return this.sessions.get(id);
  }

  fromClient(message) {
    const m = structuredClone(message);
    const p = m.params ?? {};
    if ('id' in m && m.method) {
      const record = { method: m.method, sessionId: p.sessionId, cwd: p.cwd };
      if (m.method === 'session/set_mode' || (m.method === 'session/set_config_option' && p.configId === 'mode')) {
        const key = m.method === 'session/set_mode' ? 'modeId' : 'value';
        record.setFull = p[key] === FULL_ACCESS;
        if (!record.setFull) this.session(p.sessionId).full = false; // revocation is immediate
        if (record.setFull) p[key] = 'default';
      }
      this.pending.set(m.id, record);
    }
    return m;
  }

  fromAgent(message) {
    const m = structuredClone(message);
    if (m.method === 'session/request_permission') {
      const p = m.params ?? {};
      const state = this.session(p.sessionId);
      const option = allowOnce(p);
      const read = isAllowedRead(p, this.roots, state.cwd);
      const question = /^(ask_user|ask_question|request_user_input)$/.test(p.toolCall?.name ?? '');
      if (option && !question && (state.full || read)) {
        return {
          upstream: {
            jsonrpc: '2.0',
            id: m.id,
            result: { outcome: { outcome: 'selected', optionId: option.optionId } },
          },
          reason: state.full ? 'full-access' : 'read-only',
        };
      }
      return { downstream: m };
    }
    if ('id' in m && !m.method) {
      const pending = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.result && pending) {
        const id = m.result.sessionId ?? pending.sessionId;
        if (id) {
          const state = this.session(id);
          if (pending.cwd) state.cwd = pending.cwd;
          if (pending.setFull !== undefined) state.full = pending.setFull;
          if (m.result.modes) {
            const modes = m.result.modes;
            if (state.full) modes.currentModeId = FULL_ACCESS;
            if (Array.isArray(modes.availableModes) && !modes.availableModes.some(o => o.id === FULL_ACCESS)) {
              modes.availableModes.push({ id: FULL_ACCESS, name: 'Full access', description: FULL_DESCRIPTION });
            }
          }
          patchOptions(m.result.configOptions, state.full);
        }
      }
    }
    if (m.method === 'session/update') {
      const p = m.params ?? {};
      const state = this.session(p.sessionId);
      const update = p.update ?? {};
      if (update.sessionUpdate === 'current_mode_update' && state.full) update.currentModeId = FULL_ACCESS;
      if (update.sessionUpdate === 'config_option_update') patchOptions(update.configOptions, state.full);
    }
    return { downstream: m };
  }
}
