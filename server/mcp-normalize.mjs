function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePairs(raw) {
  if (Array.isArray(raw)) {
    const out = [];
    for (const entry of raw) {
      if (!isPlainObject(entry)) continue;
      const rawName = typeof entry.name === 'string' ? entry.name : typeof entry.key === 'string' ? entry.key : '';
      const name = rawName.trim();
      if (!name || entry.value === undefined || entry.value === null) continue;
      out.push({ name, value: String(entry.value) });
    }
    return out;
  }
  if (isPlainObject(raw)) {
    const out = [];
    for (const [key, value] of Object.entries(raw)) {
      const name = key.trim();
      if (!name || value === undefined || value === null) continue;
      out.push({ name, value: String(value) });
    }
    return out;
  }
  return [];
}

function normalizeRemoteType(rawType) {
  if (typeof rawType !== 'string') return 'http';
  const lowered = rawType.trim().toLowerCase();
  if (lowered === 'sse') return 'sse';
  if (!lowered || lowered === 'http' || lowered === 'streamable-http' || lowered === 'streamable_http') {
    return 'http';
  }
  return rawType.trim();
}

function normalizeServerEntry(server, fallbackName) {
  if (!isPlainObject(server)) return server;
  const next = { ...server };
  if (fallbackName && (typeof next.name !== 'string' || !next.name.trim())) {
    next.name = fallbackName;
  }
  const hasCommand = typeof next.command === 'string' && next.command.trim().length > 0;
  const hasUrl = typeof next.url === 'string' && next.url.trim().length > 0;
  if (hasUrl && !hasCommand) {
    next.type = normalizeRemoteType(next.type);
    next.headers = normalizePairs(next.headers);
    return next;
  }
  if (hasCommand) {
    next.args = Array.isArray(next.args) ? next.args.map(arg => String(arg)) : [];
    next.env = normalizePairs(next.env);
    return next;
  }
  return next;
}

export function normalizeMcpServersList(rawServers) {
  if (Array.isArray(rawServers)) {
    return rawServers.map(server => normalizeServerEntry(server));
  }
  if (isPlainObject(rawServers)) {
    return Object.entries(rawServers)
      .filter(([, cfg]) => isPlainObject(cfg))
      .map(([name, cfg]) => normalizeServerEntry(cfg, name));
  }
  return rawServers;
}

const SESSION_MCP_METHODS = new Set(['session/new', 'session/load', 'session/resume']);

export function normalizeMcpServersMessage(message) {
  if (
    !isPlainObject(message) ||
    !SESSION_MCP_METHODS.has(message.method) ||
    !isPlainObject(message.params) ||
    message.params.mcpServers === undefined
  ) {
    return message;
  }
  return {
    ...message,
    params: {
      ...message.params,
      mcpServers: normalizeMcpServersList(message.params.mcpServers),
    },
  };
}
