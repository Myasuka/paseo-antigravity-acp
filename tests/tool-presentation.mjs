import assert from 'node:assert/strict';
import { AgentSideConnection } from '@agentclientprotocol/sdk';
import { runAcpProvider } from '@getpaseo/plugin/server/acp';
import { AgentTimelineItemPayloadSchema } from '@getpaseo/protocol/messages';
import { buildToolCallDisplayModel } from '@getpaseo/protocol/tool-call-display';
import { createDetailedAgyProvider } from '../server/tool-presentation.ts';
import { failedToolErrors } from '../server/failed-tools.ts';
import { preserveToolContent } from '../server/tool-content.mjs';

const fixtures = [
  { id: 'shell', name: 'run_command', kind: 'execute', input: { CommandLine: 'printf HELLO', Cwd: '/tmp/example' }, output: { output: 'HELLO', exit_code: 0 } },
  { id: 'read', name: 'read_file', kind: 'read', input: { Path: '/tmp/example/src/app.ts', StartLine: 10, EndLine: 12 }, content: [{ type: 'content', content: { type: 'text', text: 'line10\nline11\nline12' } }] },
  { id: 'edit', name: 'edit_file', kind: 'edit', input: { Path: '/tmp/example/src/app.ts', Target: 'before', Replacement: '' } },
  { id: 'search', name: 'grep_search', kind: 'search', input: { Query: 'TODO', SearchPath: '/tmp/example' }, output: 'src/app.ts:10: TODO' },
  { id: 'write', name: 'write_to_file', kind: 'edit', input: { TargetFile: '/tmp/example/new.ts', CodeContent: 'hello' } },
  { id: 'diff', name: 'edit_file', kind: 'edit', input: {}, content: [{ type: 'diff', path: '/tmp/example/diff.ts', oldText: 'old', newText: 'new' }] },
  { id: 'fallback', name: 'read_file', kind: 'read', input: {}, locations: [{ path: '/tmp/example/fallback.ts', line: 1 }] },
  { id: 'unknown', name: 'custom_mcp', kind: 'other', input: { CommandLine: 'Not a shell tool' }, output: { retained: true } },
  { id: 'failure', name: 'run_command', kind: 'execute', input: { CommandLine: 'false' }, output: null, status: 'failed' },
  { id: 'subagent', name: 'invoke_subagent', kind: 'other', input: { TypeName: 'research', Role: 'Limiter Verifier', Prompt: 'Inspect files' }, output: { conversationId: '9b1088e8-df03-457d-ba12-e7b695f254c1', output: 'All invariants hold' } },
  { id: 'manage-sub', name: 'manage_subagents', kind: 'other', input: { Action: 'list' }, output: { output: 'You have 1 active subagent(s)' } },
  { id: 'swarm-add', name: 'swarm', kind: 'other', input: { action: 'add', name: 'impl', brief: 'Implement parser and add unit tests\nReport back when green.' }, output: { output: 'Spawned worker impl' } },
  { id: 'swarm-title', name: 'swarm', kind: 'other', input: { action: 'title', title: 'Parser Refactor Swarm' }, output: { output: 'Title updated' } },
  { id: 'swarm-kill', name: 'swarm', kind: 'other', input: { action: 'kill', name: 'impl' }, output: { output: 'Killed impl' } },
  { id: 'swarm-model', name: 'swarm', kind: 'other', input: { action: 'model', name: 'impl', model: 'gemini-2.5-pro' }, output: { output: 'Switched model' } },
  { id: 'swarm-channel', name: 'swarm', kind: 'other', input: { action: 'channel', op: 'join', channel: 'review' }, output: { output: 'Joined #review' } },
  { id: 'post-main', name: 'post_message', kind: 'other', input: { text: '@coordinator [done] Parser verified\nAll 42 tests passed.' }, output: { output: 'Posted #7' } },
  { id: 'post-ch', name: 'post_message', kind: 'other', input: { channel: 'review', text: '@reviewer Ready for inspection' }, output: { output: 'Posted #8' } },
  { id: 'read-board', name: 'read_board', kind: 'other', input: { since: 4, channel: 'review' }, output: { output: '#5 @impl: progress' } },
  { id: 'swarm-wait', name: 'swarm_wait', kind: 'other', input: { since: 8, mentions_only: false }, output: { output: 'Woken by #9' } },
];

async function exercise(factory, extra = {}) {
  const registration = factory(
    {
      id: 'presentation-test',
      label: 'presentation-test',
      transformers: [failedToolErrors],
      connector() {
        const incoming = new TransformStream();
        const outgoing = new TransformStream();
        let peer;
        const notify = update =>
          peer.sessionUpdate(preserveToolContent({ method: 'session/update', params: { sessionId: 'native-conv-id', update } }).params);
        peer = new AgentSideConnection(
          () => ({
            initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
            newSession: async () => ({ sessionId: 'native-conv-id' }),
            async prompt() {
              for (const fixture of fixtures) {
                await notify({
                  sessionUpdate: 'tool_call',
                  toolCallId: fixture.id,
                  name: fixture.name,
                  title: 'Run ' + fixture.name,
                  kind: fixture.kind,
                  status: 'in_progress',
                  rawInput: fixture.input,
                  locations: fixture.locations,
                });
                await notify({
                  sessionUpdate: 'tool_call_update',
                  toolCallId: fixture.id,
                  status: fixture.status ?? 'completed',
                  rawInput: null,
                  rawOutput: fixture.output,
                  content: fixture.content,
                });
              }
              return { stopReason: 'end_turn' };
            },
            cancel: async () => {},
            unstable_closeSession: async () => ({}),
          }),
          { readable: incoming.readable, writable: outgoing.writable },
        );
        return { readable: outgoing.readable, writable: incoming.writable };
      },
    },
    extra,
  );
  const connection = await registration.connect({ versions: [1], capabilities: ['prompt.message', 'permission'] });
  const events = [];
  const secondary = [];
  connection.onEvent(event => events.push(event));
  const unsubscribe = connection.onEvent(event => secondary.push(event));
  const wait = async predicate => {
    const deadline = Date.now() + 5000;
    while (!events.some(predicate)) {
      assert.ok(Date.now() < deadline, 'Event timeout');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    await connection.send({
      type: 'session.open',
      requestId: 'open',
      sessionId: 'test',
      history: 'skip',
      config: { cwd: '/tmp/example', env: {}, settings: {}, mcpServers: {}, persist: false },
    });
    await wait(e => e.type === 'session.ready');
    await connection.send({
      type: 'session.prompt',
      sessionId: 'test',
      prompt: { clientMessageId: 'prompt', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'synthetic' }] } },
    });
    await wait(e => e.type === 'session.turn' && e.state === 'completed');
    assert.deepEqual(secondary, events, 'All subscribers must get identical enriched events');
    const rows = events.filter(e => e.type === 'timeline.item' && e.item.type === 'tool_call').map(e => e.item);
    assert.ok(rows.every(item => AgentTimelineItemPayloadSchema.safeParse(item).success));
    return { rows, last: id => rows.filter(row => row.id === id).at(-1) };
  } finally {
    unsubscribe();
    await connection.close();
  }
}

const persisted = new Map();
const original = await exercise(runAcpProvider);
assert.equal(original.last('shell').detail.type, 'unknown');
assert.equal(buildToolCallDisplayModel(original.last('shell')).summary, undefined);

const enhanced = await exercise(createDetailedAgyProvider, {
  onSessionPersistence(sessionId, nativeId) {
    persisted.set(sessionId, nativeId);
  },
});
assert.equal(persisted.get('test'), 'native-conv-id');
assert.equal(enhanced.last('shell').detail.command, 'printf HELLO');
assert.equal(enhanced.last('shell').detail.output, 'HELLO');
assert.equal(enhanced.last('shell').detail.exitCode, 0);
assert.deepEqual(buildToolCallDisplayModel(enhanced.last('shell')), { displayName: 'Shell', summary: 'printf HELLO' });
assert.equal(buildToolCallDisplayModel({ ...enhanced.last('read'), cwd: '/tmp/example' }).summary, 'src/app.ts');
assert.deepEqual(enhanced.last('read').detail, {
  type: 'read',
  filePath: '/tmp/example/src/app.ts',
  content: 'line10\nline11\nline12',
  offset: 10,
  limit: 3,
});
assert.equal(enhanced.last('edit').detail.oldString, 'before');
assert.equal(enhanced.last('edit').detail.newString, '');
assert.equal(enhanced.last('search').detail.query, 'TODO');
assert.equal(enhanced.last('write').detail.content, 'hello');
assert.equal(enhanced.last('diff').detail.filePath, '/tmp/example/diff.ts');
assert.equal(enhanced.last('diff').detail.oldString, 'old');
assert.equal(enhanced.last('diff').detail.newString, 'new');
assert.equal(enhanced.last('fallback').detail.filePath, '/tmp/example/fallback.ts');
assert.deepEqual(enhanced.last('unknown'), original.last('unknown'));
assert.equal(enhanced.last('failure').status, 'failed');
assert.notEqual(enhanced.last('failure').error, null);
assert.deepEqual(enhanced.last('subagent').detail, {
  type: 'sub_agent',
  subAgentType: 'research',
  description: 'Limiter Verifier',
  childSessionId: '9b1088e8-df03-457d-ba12-e7b695f254c1',
  log: 'All invariants hold',
});
assert.deepEqual(buildToolCallDisplayModel(enhanced.last('subagent')), { displayName: 'research', summary: 'Limiter Verifier' });
assert.equal(enhanced.last('manage-sub').detail.label, 'list');
assert.deepEqual(enhanced.last('swarm-add').detail, {
  type: 'sub_agent',
  subAgentType: 'swarm:impl',
  description: 'Implement parser and add unit tests',
  log: 'Implement parser and add unit tests\nReport back when green.\n\nSpawned worker impl',
});
assert.deepEqual(buildToolCallDisplayModel(enhanced.last('swarm-add')), {
  displayName: 'swarm:impl',
  summary: 'Implement parser and add unit tests',
});
assert.equal(enhanced.last('swarm-title').detail.label, 'swarm title: Parser Refactor Swarm');
assert.equal(enhanced.last('swarm-title').detail.icon, 'bot');
assert.equal(enhanced.last('swarm-kill').detail.label, 'swarm kill @impl');
assert.equal(enhanced.last('swarm-model').detail.label, 'swarm model @impl -> gemini-2.5-pro');
assert.equal(enhanced.last('swarm-channel').detail.label, 'swarm channel join #review');
assert.equal(enhanced.last('post-main').detail.label, '@coordinator [done] Parser verified');
assert.equal(enhanced.last('post-main').detail.icon, 'bot');
assert.equal(enhanced.last('post-ch').detail.label, '#review: @reviewer Ready for inspection');
assert.equal(enhanced.last('read-board').detail.label, 'read_board #review (since #4)');
assert.equal(enhanced.last('read-board').detail.icon, 'eye');
assert.equal(enhanced.last('swarm-wait').detail.label, 'swarm_wait (since #8) [any post]');
assert.equal(enhanced.last('swarm-wait').detail.icon, 'sparkles');
assert.equal(enhanced.rows.filter(row => row.id === 'shell')[0].detail.command, 'printf HELLO');

const explicit = {
  method: 'session/update',
  params: {
    update: {
      sessionUpdate: 'tool_call_update',
      rawOutput: { output: 'original' },
      content: [{ type: 'content', content: { type: 'text', text: 'other' } }],
    },
  },
};
assert.deepEqual(preserveToolContent(explicit).params.update.rawOutput, explicit.params.update.rawOutput);

console.log(
  JSON.stringify({
    passed: true,
    originalMissingSummaryReproduced: true,
    tools: fixtures.length,
    inferenceRequestsSent: 0,
  }),
);
