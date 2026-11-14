import assert from 'node:assert/strict';
import { AgentSideConnection } from '@agentclientprotocol/sdk';
import { runAcpProvider } from '@getpaseo/plugin/server/acp';
import { createDetailedAgyProvider } from '../server/tool-presentation.ts';
import {
  createModelThinkingTransformer,
  extractThinkingFromConfigOptions,
  probeAgyModelThinking,
} from '../server/model-thinking.ts';

const MODELS = [
  { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
  { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
  { value: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
  { value: 'gemini-pro-orchestrator-argon', name: 'Orchestrator (Argon)' },
  { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
];

function configOptionsFor(model, thoughtLevel = 'medium') {
  const base = [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: MODELS },
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }] },
  ];
  if (model === 'gemini-pro-orchestrator' || model === 'gemini-pro-orchestrator-argon' || model === 'gpt-oss-120b-medium') {
    return base;
  }
  const options = [
    { value: 'low', name: 'Low' },
    { value: 'medium', name: 'Medium' },
    { value: 'high', name: 'High' },
    ...(model === 'gemini-4-hydrogen' ? [{ value: 'xhigh', name: 'Extra' }] : []),
  ];
  const validCurrent = options.some(o => o.value === thoughtLevel) ? thoughtLevel : 'medium';
  return [
    base[0],
    { id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: validCurrent, options },
    base[1],
  ];
}

function makeConnector() {
  return () => {
    const incoming = new TransformStream();
    const outgoing = new TransformStream();
    let currentModel = 'gemini-4-carbon';
    let currentThought = 'medium';
    new AgentSideConnection(
      () => ({
        initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
        newSession: async () => ({
          sessionId: 'native',
          modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
          configOptions: configOptionsFor(currentModel, currentThought),
        }),
        async setSessionConfigOption(params) {
          if (params.configId === 'model') {
            currentModel = params.value;
            if (currentModel !== 'gemini-4-hydrogen' && currentThought === 'xhigh') currentThought = 'high';
          } else if (params.configId === 'thought_level') {
            currentThought = params.value;
          }
          return { configOptions: configOptionsFor(currentModel, currentThought) };
        },
        prompt: async () => ({ stopReason: 'end_turn' }),
        cancel: async () => {},
        unstable_closeSession: async () => ({}),
      }),
      { readable: incoming.readable, writable: outgoing.writable },
    );
    return { readable: outgoing.readable, writable: incoming.writable };
  };
}

async function waitFor(events, predicate, label = 'event') {
  const deadline = Date.now() + 5000;
  while (!events.some(predicate)) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return events.find(predicate);
}

const mockScript = `
import { createInterface } from 'node:readline';
const MODELS = ${JSON.stringify(MODELS)};
let model = 'gemini-4-carbon';
function opts(m) {
  const base = [{ id: 'model', category: 'model', type: 'select', currentValue: m, options: MODELS }];
  if (m.startsWith('gemini-pro-orchestrator') || m === 'gpt-oss-120b-medium') return base;
  const levels = [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }];
  if (m === 'gemini-4-hydrogen') levels.push({ value: 'xhigh', name: 'Extra' });
  return [...base, { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'medium', options: levels }];
}
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + '\\n');
  } else if (msg.method === 'session/new') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1', configOptions: opts(model) } }) + '\\n');
  } else if (msg.method === 'session/set_config_option') {
    model = msg.params.value;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { configOptions: opts(model) } }) + '\\n');
  }
});
`;

const probed = await probeAgyModelThinking(MODELS.map(m => m.value), {
  command: process.execPath,
  args: ['--input-type=module', '-e', mockScript],
  timeoutMs: 5000,
});
assert.deepEqual(probed.get('gemini-4-hydrogen'), {
  defaultThinkingOptionId: 'medium',
  thinkingOptions: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium', isDefault: true },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra' },
  ],
});
assert.deepEqual(probed.get('gemini-pro-orchestrator'), {});
assert.deepEqual(probed.get('gpt-oss-120b-medium'), {});

{
  const baseline = runAcpProvider({ id: 'baseline', label: 'baseline', connector: makeConnector() });
  const conn = await baseline.connect({ versions: [1], capabilities: ['prompt.message', 'session.configure'] });
  const events = [];
  conn.onEvent(e => events.push(e));
  try {
    await conn.send({ type: 'catalog', requestId: 'cat-0' });
    const catEvent = await waitFor(events, e => e.type === 'catalog', 'baseline catalog');
    const hydrogen = catEvent.catalog.models.find(m => m.id === 'gemini-4-hydrogen');
    assert.equal(hydrogen.thinkingOptions, undefined, 'Baseline lacks per-model thinkingOptions');
    await conn.send({
      type: 'session.open',
      requestId: 'open-fail',
      sessionId: 's-fail',
      history: 'skip',
      config: { cwd: '/tmp', env: {}, settings: {}, mcpServers: {}, persist: false, model: 'gemini-pro-orchestrator', thinkingOption: 'medium' },
    });
    const failEvent = await waitFor(events, e => e.type === 'request.failed' && e.requestId === 'open-fail', 'baseline failure');
    assert.match(failEvent.error.message, /does not expose thinking configuration/);
  } finally {
    await conn.close();
  }
}

{
  const transformer = createModelThinkingTransformer(async () => probed);
  const provider = createDetailedAgyProvider({
    id: 'enhanced',
    label: 'enhanced',
    connector: makeConnector(),
    transformers: [transformer],
  });
  const conn = await provider.connect({ versions: [1], capabilities: ['prompt.message', 'session.configure'] });
  const events = [];
  conn.onEvent(e => events.push(e));
  try {
    await conn.send({ type: 'catalog', requestId: 'cat-1' });
    const { catalog } = await waitFor(events, e => e.type === 'catalog' && e.requestId === 'cat-1', 'enhanced catalog');
    assert.equal(catalog.thinkingOptions, undefined);
    assert.equal(catalog.defaultThinkingOption, undefined);

    const hydrogen = catalog.models.find(m => m.id === 'gemini-4-hydrogen');
    assert.deepEqual(hydrogen.thinkingOptions.map(o => o.id), ['low', 'medium', 'high', 'xhigh']);
    assert.equal(hydrogen.thinkingOptions.find(o => o.id === 'xhigh').label, 'Extra');
    assert.equal(hydrogen.defaultThinkingOptionId, 'medium');

    const carbon = catalog.models.find(m => m.id === 'gemini-4-carbon');
    assert.deepEqual(carbon.thinkingOptions.map(o => o.id), ['low', 'medium', 'high']);
    assert.equal(carbon.defaultThinkingOptionId, 'medium');

    for (const noThinkingId of ['gemini-pro-orchestrator', 'gemini-pro-orchestrator-argon', 'gpt-oss-120b-medium']) {
      const m = catalog.models.find(item => item.id === noThinkingId);
      assert.equal(m.thinkingOptions, undefined);
      assert.equal(m.defaultThinkingOptionId, undefined);
    }

    await conn.send({
      type: 'session.open',
      requestId: 'open-h2',
      sessionId: 's-h2',
      history: 'skip',
      config: { cwd: '/tmp', env: {}, settings: {}, mcpServers: {}, persist: false, model: 'gemini-4-hydrogen', thinkingOption: 'xhigh' },
    });
    await waitFor(events, e => e.type === 'session.ready' && e.requestId === 'open-h2', 'hydrogen ready');
    const h2Config = events.filter(e => e.type === 'session.config' && e.sessionId === 's-h2').at(-1);
    assert.equal(h2Config.config.model, 'gemini-4-hydrogen');
    assert.equal(h2Config.config.thinkingOption, 'xhigh');

    await conn.send({ type: 'session.configure', requestId: 'clear-h2', sessionId: 's-h2', changes: { thinkingOption: null } });
    await waitFor(events, e => e.type === 'request.completed' && e.requestId === 'clear-h2', 'clear hydrogen thinking');
    const h2Cleared = events.filter(e => e.type === 'session.config' && e.sessionId === 's-h2').at(-1);
    assert.equal(h2Cleared.config.thinkingOption, 'medium');

    await conn.send({
      type: 'session.open',
      requestId: 'open-orch',
      sessionId: 's-orch',
      history: 'skip',
      config: { cwd: '/tmp', env: {}, settings: {}, mcpServers: {}, persist: false, model: 'gemini-pro-orchestrator', thinkingOption: 'medium' },
    });
    await waitFor(events, e => e.type === 'session.ready' && e.requestId === 'open-orch', 'orchestrator ready');
    const orchConfig = events.filter(e => e.type === 'session.config' && e.sessionId === 's-orch').at(-1);
    assert.equal(orchConfig.config.model, 'gemini-pro-orchestrator');
    assert.equal(orchConfig.config.thinkingOption, undefined);
    assert.deepEqual(orchConfig.config.thinkingOptions, []);
  } finally {
    await conn.close();
  }
}

{
  const fallback = createModelThinkingTransformer(async () => {
    throw new Error('probe failed');
  });
  const untouched = await fallback.discover(
    {
      models: [{ id: 'gemini-4-carbon', label: 'Gemini 4 Carbon' }],
      modes: [],
      thinkingOptions: [{ id: 'medium', label: 'Medium' }],
      defaultThinkingOption: 'medium',
    },
    { sessionId: 'catalog', config: { read: async () => ({}), set: async () => {} } },
  );
  assert.equal(untouched.defaultThinkingOption, 'medium');
}

{
  const grouped = extractThinkingFromConfigOptions([
    {
      id: 'thought_level',
      category: 'thought_level',
      type: 'select',
      currentValue: 'xhigh',
      options: [{ group: 'Extended', options: [{ value: 'high', name: 'High' }, { value: 'xhigh', name: 'Extra' }] }],
    },
  ]);
  assert.equal(grouped.defaultThinkingOptionId, 'xhigh');
  assert.equal(grouped.thinkingOptions.find(o => o.id === 'xhigh').isDefault, true);
}

console.log(
  JSON.stringify({
    passed: true,
    cases: ['stdio-probe', 'baseline-repro', 'per-model-catalog', 'hydrogen-xhigh', 'orchestrator-no-thinking', 'null-reset', 'probe-fallback', 'grouped-options'],
  }),
);
