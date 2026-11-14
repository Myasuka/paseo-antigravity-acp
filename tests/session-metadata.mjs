import assert from 'node:assert/strict';
import { SessionMetadata, PROGRESS_INSTRUCTIONS } from '../server/session-metadata.mjs';

const bridge = new SessionMetadata({ progressUpdates: false });
const request = {
  jsonrpc: '2.0',
  id: 2,
  method: 'session/new',
  params: {
    cwd: '/tmp',
    mcpServers: [],
    _meta: { _paseo: { systemPrompt: 'Follow the workspace rules.' }, other: { retained: true } },
  },
};
assert.deepEqual(bridge.fromClient(request), request);
bridge.fromClient({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
bridge.fromAgent({
  jsonrpc: '2.0',
  id: 1,
  result: { agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } } },
});
for (const method of ['session/new', 'session/load']) {
  const input = { ...request, method };
  const output = bridge.fromClient(input);
  assert.equal(output.params._meta.antigravity.systemPrompt.append, 'Follow the workspace rules.');
  assert.deepEqual(output.params._meta._paseo, request.params._meta._paseo);
  assert.deepEqual(output.params._meta.other, { retained: true });
  assert.equal(input.params._meta.antigravity, undefined);
}
const prior = structuredClone(request);
prior.params._meta.antigravity = { systemPrompt: { append: 'Prior native instruction.' }, retained: true };
assert.equal(
  bridge.fromClient(prior).params._meta.antigravity.systemPrompt.append,
  'Prior native instruction.\n\nFollow the workspace rules.',
);
assert.equal(bridge.fromClient(prior).params._meta.antigravity.retained, true);
assert.deepEqual(bridge.fromClient({ ...request, method: 'session/prompt' }), { ...request, method: 'session/prompt' });
assert.deepEqual(
  bridge.fromClient({ ...request, params: { _meta: { _paseo: { systemPrompt: '' } } } }),
  { ...request, params: { _meta: { _paseo: { systemPrompt: '' } } } },
);
const progress = new SessionMetadata();
progress.fromClient({ id: 1, method: 'initialize' });
progress.fromAgent({
  id: 1,
  result: { agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } } },
});
const enhanced = progress.fromClient(request);
assert.ok(enhanced.params._meta.antigravity.systemPrompt.append.startsWith('Follow the workspace rules.'));
assert.ok(enhanced.params._meta.antigravity.systemPrompt.append.includes(PROGRESS_INSTRUCTIONS));
const repeated = progress.fromClient(enhanced);
assert.equal(repeated.params._meta.antigravity.systemPrompt.append.split(PROGRESS_INSTRUCTIONS).length, 2);
assert.equal(
  progress.fromClient({ method: 'session/new', params: { cwd: '/tmp' } }).params._meta.antigravity.systemPrompt.append,
  PROGRESS_INSTRUCTIONS,
);
console.log(
  JSON.stringify({
    passed: true,
    coverage: ['capability-gated native system prompt', 'new/load', 'preserve metadata', 'no input mutation', 'no prompt rewriting'],
  }),
);
