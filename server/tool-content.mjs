// Preserve standard ACP content that generic ACP adapters may otherwise drop when rawOutput is omitted.
export function preserveToolContent(message) {
  const update = message.params?.update;
  if (message.method !== 'session/update' || !['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) {
    return message;
  }
  const normalized = { ...update };
  if (update.sessionUpdate === 'tool_call_update') {
    if (normalized.rawInput == null) delete normalized.rawInput;
    if (normalized.rawOutput == null) delete normalized.rawOutput;
  }
  if (update.rawOutput == null && Array.isArray(update.content) && update.content.length > 0) {
    normalized.rawOutput = { _paseoAgyContent: update.content };
  }
  return { ...message, params: { ...message.params, update: normalized } };
}
