// Paseo's generic ACP metadata and AGY's advertised append contract use different namespaces.
export const PROGRESS_INSTRUCTIONS =
  "For multi-step tasks, give a brief user-facing progress update before substantial tool work and at meaningful milestones. Describe observable actions and results in the user's language. Keep updates concise; do not narrate every routine tool call.";

export const BACKGROUND_APPROVAL_INSTRUCTIONS =
  'Keep approval-sensitive work in the foreground ACP turn. If a terminal command runs asynchronously, wait for its result with manage_task and finish its follow-up actions before ending your response. Background wakeups may not expose new permission requests through ACP. Do not end with a promise to continue later while commands or required approvals are unfinished.';

export class SessionMetadata {
  #initializeId;
  #supportsAppend = false;

  constructor({ progressUpdates = true, backgroundApprovals = false } = {}) {
    this.progressUpdates = progressUpdates;
    this.backgroundApprovals = backgroundApprovals;
  }

  fromAgent(message) {
    if (message.id === this.#initializeId && !message.method && message.result) {
      this.#supportsAppend = message.result.agentCapabilities?._meta?.antigravity?.systemPrompt?.append === true;
      this.#initializeId = undefined;
    }
    return message;
  }

  fromClient(message) {
    if (message.method === 'initialize') this.#initializeId = message.id;
    const prompt = message.params?._meta?._paseo?.systemPrompt;
    if (!this.#supportsAppend || !['session/new', 'session/load'].includes(message.method)) return message;
    if ((!prompt || typeof prompt !== 'string' || !prompt.trim()) && !this.progressUpdates && !this.backgroundApprovals) {
      return message;
    }
    const output = structuredClone(message);
    output.params ??= {};
    const meta = (output.params._meta ??= {});
    const agy = meta.antigravity ?? {};
    const systemPrompt = agy.systemPrompt ?? {};
    const prior = typeof systemPrompt.append === 'string' ? systemPrompt.append : '';
    let append = [prior, typeof prompt === 'string' ? prompt : ''].filter(Boolean).join('\n\n');
    if (this.progressUpdates && !append.includes(PROGRESS_INSTRUCTIONS)) {
      append = [append, PROGRESS_INSTRUCTIONS].filter(Boolean).join('\n\n');
    }
    if (this.backgroundApprovals && !append.includes(BACKGROUND_APPROVAL_INSTRUCTIONS)) {
      append = [append, BACKGROUND_APPROVAL_INSTRUCTIONS].filter(Boolean).join('\n\n');
    }
    meta.antigravity = {
      ...agy,
      systemPrompt: {
        ...systemPrompt,
        append,
      },
    };
    return output;
  }
}
