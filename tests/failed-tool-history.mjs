import assert from 'node:assert/strict';
import { AgentSideConnection } from '@agentclientprotocol/sdk';
import { runAcpProvider } from '@getpaseo/plugin/server/acp';
import { AgentTimelineItemPayloadSchema } from '@getpaseo/protocol/messages';
import { failedToolErrors } from '../server/failed-tools.ts';

async function exercise(transformers, status = 'failed', output = null) {
  const registration = runAcpProvider({
    id: 'regression',
    label: 'regression',
    transformers,
    connector: () => {
      const input = new TransformStream();
      const result = new TransformStream();
      let server;
      server = new AgentSideConnection(
        () => ({
          initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
          newSession: async () => ({ sessionId: 'fake-session' }),
          async prompt() {
            await server.sessionUpdate({
              sessionId: 'fake-session',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'read-missing',
                title: 'read_file',
                kind: 'read',
                status: 'in_progress',
                rawInput: { path: '/tmp/nonexistent-regression' },
              },
            });
            await server.sessionUpdate({
              sessionId: 'fake-session',
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'read-missing',
                status,
                rawOutput: output,
              },
            });
            return { stopReason: 'end_turn' };
          },
          cancel: async () => {},
          unstable_closeSession: async () => ({}),
        }),
        { readable: input.readable, writable: result.writable },
      );
      return { readable: result.readable, writable: input.writable };
    },
  });

  const c = await registration.connect({ versions: [1], capabilities: ['prompt.message', 'permission'] });
  const events = [];
  const waiters = [];
  c.onEvent(e => {
    events.push(e);
    for (const w of [...waiters]) {
      if (w.predicate(e)) {
        clearTimeout(w.timer);
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(e);
      }
    }
  });
  const wait = predicate => {
    const hit = events.find(predicate);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = {
        predicate,
        resolve,
        timer: setTimeout(() => reject(new Error('test event timeout')), 5000),
      };
      waiters.push(w);
    });
  };
  try {
    await c.send({
      type: 'session.open',
      requestId: 'open',
      sessionId: 'test',
      history: 'skip',
      config: { cwd: '/tmp', env: {}, mcpServers: {}, settings: {}, persist: false },
    });
    await wait(e => e.type === 'session.ready');
    await new Promise(r => setImmediate(r));
    await c.send({
      type: 'session.prompt',
      sessionId: 'test',
      prompt: {
        clientMessageId: 'prompt',
        delivery: 'auto',
        input: { type: 'message', content: [{ type: 'text', text: 'synthetic fixture' }] },
      },
    });
    await wait(e => e.type === 'session.turn' && e.state === 'completed');
    const item = events.filter(e => e.type === 'timeline.item' && e.item.type === 'tool_call').at(-1).item;
    const { id, revertToken, ...canonical } = item;
    return { item: canonical, valid: AgentTimelineItemPayloadSchema.safeParse(canonical).success };
  } finally {
    for (const w of waiters) clearTimeout(w.timer);
    await c.close();
  }
}

const original = await exercise([]);
assert.equal(original.valid, false);
assert.equal(original.item.error, null);

const fixed = await exercise([failedToolErrors]);
assert.equal(fixed.valid, true);
assert.equal(fixed.item.status, 'failed');
assert.equal(typeof fixed.item.error.message, 'string');

const completed = await exercise([failedToolErrors], 'completed');
assert.equal(completed.valid, true);
assert.equal(completed.item.error, null);

const explicit = await exercise([failedToolErrors], 'failed', 'File not found');
assert.equal(explicit.valid, true);
assert.equal(explicit.item.error, 'File not found');

console.log(
  JSON.stringify({
    passed: true,
    originalFailureReproduced: true,
    fixedFailedToolValid: true,
    completedToolUnchanged: true,
    explicitErrorPreserved: true,
    inferenceRequestsSent: 0,
  }),
);
