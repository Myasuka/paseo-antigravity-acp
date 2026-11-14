import assert from 'node:assert/strict';
import { withNativeFullAccess } from '../server/native-full-access.ts';

function harness({ failFull = false, onSessionPersistence } = {}) {
  const listeners = new Set();
  const opens = [];
  const exposed = [];
  const state = { mode: 'default' };
  const emit = event => {
    for (const listener of listeners) listener(event);
  };
  const config = () => ({
    mode: state.mode,
    model: 'model',
    thinkingOption: 'high',
    models: [],
    modes: [],
    thinkingOptions: [],
    settings: [],
  });
  const inner = {
    version: 1,
    capabilities: ['session.configure', 'session.persistence', 'prompt.message'],
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(input) {
      if (input.type === 'session.open') {
        opens.push(input);
        if (failFull && input.config.env.PASEO_AGY_NATIVE_FULL_ACCESS === '1') {
          emit({ type: 'request.failed', requestId: input.requestId, error: { message: 'Synthetic startup failure' } });
          return;
        }
        state.mode = input.config.mode ?? 'default';
        emit({
          type: 'session.opened',
          sessionId: input.sessionId,
          requestId: input.requestId,
          persistence: { version: 1, data: { sessionId: 'native-session' } },
          restoration: 'core',
          capabilities: [],
          cwd: '/tmp',
        });
        emit({ type: 'session.config', sessionId: input.sessionId, config: config() });
        emit({ type: 'session.ready', sessionId: input.sessionId, requestId: input.requestId });
      } else if (input.type === 'session.close') {
        emit({ type: 'session.closed', sessionId: input.sessionId });
        emit({ type: 'request.completed', requestId: input.requestId });
      } else if (input.type === 'session.configure') {
        state.mode = input.changes.mode ?? 'default';
        emit({ type: 'session.config', sessionId: input.sessionId, config: config() });
        emit({ type: 'request.completed', requestId: input.requestId });
      } else if (input.type === 'session.prompt') {
        emit({ type: 'session.turn', sessionId: input.sessionId, turnId: 'turn', state: 'started' });
      } else if (input.type === 'session.interrupt') {
        emit({ type: 'session.turn', sessionId: input.sessionId, turnId: 'turn', state: 'canceled' });
        emit({ type: 'request.completed', requestId: input.requestId });
      }
    },
    async close() {},
  };
  const connection = withNativeFullAccess(inner, { onSessionPersistence });
  connection.onEvent(event => exposed.push(event));
  const open = async mode => {
    await connection.send({
      type: 'session.open',
      requestId: 'open',
      sessionId: 's',
      history: 'skip',
      config: {
        cwd: '/tmp',
        env: { PASEO_AGY_NATIVE_FULL_ACCESS: '1', RETAINED: 'yes' },
        settings: {},
        mcpServers: {},
        persist: true,
        mode,
      },
    });
    await new Promise(resolve => setImmediate(resolve));
  };
  const configure = mode =>
    connection.send({ type: 'session.configure', requestId: 'mode-' + mode, sessionId: 's', changes: { mode } });
  return { connection, exposed, opens, open, configure };
}

const persisted = [];
const normal = harness({
  onSessionPersistence(id, nativeId) {
    persisted.push([id, nativeId]);
  },
});
try {
  await normal.open('default');
  assert.deepEqual(persisted[0], ['s', 'native-session']);
  assert.equal(normal.opens[0].config.env.PASEO_AGY_NATIVE_FULL_ACCESS, '0');
  assert.equal(normal.opens[0].config.env.RETAINED, 'yes');
  await normal.configure('full-access');
  assert.equal(normal.opens.at(-1).config.env.PASEO_AGY_NATIVE_FULL_ACCESS, '1');
  assert.equal(normal.opens.at(-1).history, 'skip');
  assert.equal(normal.opens.at(-1).persistence.data.sessionId, 'native-session');
  assert.equal(normal.exposed.filter(e => e.type === 'session.closed').length, 0);
  assert.equal(normal.exposed.filter(e => e.type === 'session.opened').length, 1);
  assert.equal(normal.exposed.filter(e => e.type === 'session.config').at(-1).config.mode, 'full-access');
  await normal.connection.send({
    type: 'session.prompt',
    sessionId: 's',
    prompt: { clientMessageId: 'x', delivery: 'auto', input: { type: 'message', content: [] } },
  });
  const count = normal.opens.length;
  await normal.configure('default');
  assert.equal(normal.opens.length, count);
  assert.ok(normal.exposed.some(e => e.type === 'request.failed' && e.requestId === 'mode-default'));
  assert.equal(normal.exposed.filter(e => e.type === 'session.config').at(-1).config.mode, 'full-access');
  await normal.connection.send({ type: 'session.interrupt', requestId: 'stop', sessionId: 's' });
  await normal.configure('default');
  assert.equal(normal.opens.at(-1).config.env.PASEO_AGY_NATIVE_FULL_ACCESS, '0');
  await normal.configure('auto');
  assert.equal(normal.opens.at(-1).config.env.PASEO_AGY_NATIVE_FULL_ACCESS, '0');
} finally {
  await normal.connection.close();
}

const rollback = harness({ failFull: true });
try {
  await rollback.open('default');
  await rollback.configure('full-access');
  assert.equal(rollback.opens.at(-1).config.env.PASEO_AGY_NATIVE_FULL_ACCESS, '0');
  assert.equal(rollback.exposed.filter(e => e.type === 'session.config').at(-1).config.mode, 'default');
  assert.ok(rollback.exposed.some(e => e.type === 'request.failed' && e.requestId === 'mode-full-access'));
  assert.equal(rollback.exposed.filter(e => e.type === 'session.runtime_failed').length, 0);
} finally {
  await rollback.connection.close();
}

const initialFull = harness();
try {
  await initialFull.open('full-access');
  assert.equal(initialFull.opens[0].config.env.PASEO_AGY_NATIVE_FULL_ACCESS, '1');
  await initialFull.configure('auto');
  assert.equal(initialFull.opens.at(-1).config.env.PASEO_AGY_NATIVE_FULL_ACCESS, '0');
} finally {
  await initialFull.connection.close();
}

console.log(
  JSON.stringify({
    passed: true,
    coverage: [
      'native Full flag only when selected',
      'provider env cannot override safer mode',
      'idle entry/exit restarts same session',
      'history skipped during internal restart',
      'intermediate closes hidden',
      'busy downgrade rejected without false mode',
      'cancel then downgrade',
      'startup failure rolls back',
      'Auto never inherits skip flag',
      'persistence callback tracked',
    ],
  }),
);
