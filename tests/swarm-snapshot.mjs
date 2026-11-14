import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwarmSnapshotOutputSchema, swarmSnapshotRpc } from '../shared/swarm.ts';
import { createSwarmSnapshotEngine, extractNativeConversationId } from '../server/swarm-snapshot.ts';
import contributeServer from '../index.server.ts';

const COORD_CONV = '11111111-2222-3333-4444-555555555555';
const IMPL1_CONV = 'aaaaaaaa-1111-2222-3333-444444444444';
const IMPL2_CONV = 'aaaaaaaa-2222-3333-4444-555555555555';
const REVIEW_CONV = 'bbbbbbbb-1111-2222-3333-444444444444';
const KILLED_CONV = 'cccccccc-1111-2222-3333-444444444444';
const NARRATOR_CONV = 'dddddddd-1111-2222-3333-444444444444';
const MONITOR_CONV = 'eeeeeeee-1111-2222-3333-444444444444';

function makeMockPaseo(agentsById) {
  return {
    agents: {
      ref(agentId) {
        const snap = agentsById.get(agentId) ?? null;
        return {
          current: () => snap,
          refresh: async () => (snap ? { agent: snap } : null),
        };
      },
    },
  };
}

async function writeTranscript(root, convId, rows) {
  const dir = join(root, 'brain', convId, '.system_generated', 'logs');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'transcript.jsonl'),
    rows.map(r => JSON.stringify(r) + '\n').join(''),
  );
}

// 1. Verify extractNativeConversationId across plugin-wrapped and native Antigravity snapshots.
{
  const wrapped = `plugin:${JSON.stringify({ version: 1, data: { sessionId: COORD_CONV.toUpperCase() } })}`;
  assert.equal(
    extractNativeConversationId({ runtimeInfo: { provider: 'antigravity-acp', sessionId: wrapped } }),
    COORD_CONV,
  );
  assert.equal(
    extractNativeConversationId({
      persistence: {
        provider: 'antigravity-acp',
        sessionId: 'opaque',
        metadata: { pluginProviderPersistence: { version: 1, data: { sessionId: IMPL1_CONV } } },
      },
    }),
    IMPL1_CONV,
  );
  assert.equal(
    extractNativeConversationId({ runtimeInfo: { provider: 'antigravity', sessionId: REVIEW_CONV } }),
    REVIEW_CONV,
  );
  assert.equal(extractNativeConversationId({ runtimeInfo: { sessionId: 'not-a-uuid' } }), null);
}

const root = await mkdtemp(join(tmpdir(), 'agy-swarm-snapshot-test-'));
let fakeNow = Date.parse('2026-06-01T12:20:00.000Z');

try {
  const sessionMap = new Map([['agent-via-map', COORD_CONV]]);
  const agentsById = new Map([
    [
      'agent-coord',
      {
        id: 'agent-coord',
        provider: 'antigravity-acp',
        currentModeId: 'default',
        runtimeInfo: {
          provider: 'antigravity-acp',
          sessionId: `plugin:${JSON.stringify({ version: 1, data: { sessionId: COORD_CONV } })}`,
        },
      },
    ],
    [
      'agent-worker-1',
      {
        id: 'agent-worker-1',
        provider: 'antigravity',
        currentModeId: 'full-access',
        runtimeInfo: {
          provider: 'antigravity',
          sessionId: IMPL1_CONV,
        },
      },
    ],
    [
      'agent-no-swarm',
      {
        id: 'agent-no-swarm',
        provider: 'antigravity-acp',
        currentModeId: 'default',
        runtimeInfo: {
          provider: 'antigravity-acp',
          sessionId: `plugin:${JSON.stringify({ version: 1, data: { sessionId: '99999999-8888-7777-6666-555555555555' } })}`,
        },
      },
    ],
  ]);
  const mockPaseo = makeMockPaseo(agentsById);
  const engine = createSwarmSnapshotEngine({
    dataDir: root,
    sessionMap,
    now: () => fakeNow,
  });

  // 2. Empty state when no swarm exists on disk.
  const emptySnap = await engine.getSnapshot({ agentId: 'agent-no-swarm' }, mockPaseo);
  assert.ok(SwarmSnapshotOutputSchema.safeParse(emptySnap).success);
  assert.equal(emptySnap.status, 'empty');
  assert.equal(emptySnap.provider, 'antigravity-acp');
  assert.equal(emptySnap.modeId, 'default');
  assert.equal(emptySnap.conversationId, '99999999-8888-7777-6666-555555555555');

  // 3. Build a rich Swarm fixture on disk and advance mock clock past 500ms negative-lookup debounce.
  fakeNow += 1000;
  const swarmDir = join(root, 'brain', COORD_CONV, '.system_generated', 'swarm');
  await mkdir(swarmDir, { recursive: true });
  await writeFile(
    join(swarmDir, 'members.json'),
    JSON.stringify({
      title: 'Compiler Pipeline Swarm',
      members: {
        'impl-1': {
          conversation_id: IMPL1_CONV,
          model: 'gemini-2.5-pro',
          role: 'worker',
          wake_mode: 'mentions',
          last_read_seq: 1,
          channels: ['lexer'],
        },
        'impl-2': {
          conversation_id: IMPL2_CONV,
          model: 'gemini-2.5-flash',
          role: 'worker',
          wake_mode: 'mentions',
          last_read_seq: 2,
          channels: ['lexer'],
        },
        reviewer: {
          conversation_id: REVIEW_CONV,
          model: 'gemini-2.5-pro',
          role: 'worker',
          wake_mode: 'mentions',
          last_read_seq: 4,
          channels: ['review'],
        },
        legacy: {
          conversation_id: KILLED_CONV,
          model: 'gemini-2.5-flash',
          role: 'worker',
          killed: true,
          last_read_seq: 1,
        },
        narrator: {
          conversation_id: NARRATOR_CONV,
          model: 'gemini-2.5-flash',
          role: 'narrator',
          wake_mode: 'any',
          last_read_seq: 2,
        },
        monitor: {
          conversation_id: MONITOR_CONV,
          model: 'gemini-2.5-flash',
          role: 'worker',
          wake_mode: 'mentions',
          last_read_seq: 4,
        },
      },
    }),
  );

  // Coordinator transcript: waiting after spawning workers
  await writeTranscript(root, COORD_CONV, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-06-01T12:00:00.000Z', content: 'Run compiler swarm' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-06-01T12:01:00.000Z', content: 'Spawned team' },
  ]);

  // impl-1 transcript: actively working AND idle >10m (12:05 -> fakeNow 12:20 = 15m -> stuck alert!)
  await writeTranscript(root, IMPL1_CONV, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-06-01T12:01:00.000Z', content: 'implement lexer' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-06-01T12:05:00.000Z',
      tool_calls: [{ name: 'run_command', args: { toolSummary: '"Run lexer benchmark"', CommandLine: '"npm run bench"' } }],
    },
  ]);

  // impl-2 transcript: hit 429 RESOURCE_EXHAUSTED quota error
  await writeTranscript(root, IMPL2_CONV, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-06-01T12:02:00.000Z', content: 'implement ast' },
    {
      step_index: 1,
      type: 'ERROR_MESSAGE',
      status: 'ERROR',
      created_at: '2026-06-01T12:18:00.000Z',
      error: '429 RESOURCE_EXHAUSTED: Model quota exceeded for gemini-2.5-flash',
    },
  ]);

  // reviewer transcript: parked cleanly on swarm_wait (DONE) -> status should be 'waiting'
  await writeTranscript(root, REVIEW_CONV, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-06-01T12:02:00.000Z', content: 'stand by for review' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-06-01T12:15:00.000Z',
      tool_calls: [{ name: 'swarm_wait', args: { since: '4' } }],
    },
    { step_index: 2, type: 'GENERIC', status: 'DONE', created_at: '2026-06-01T12:15:01.000Z', content: 'Waiting on mentions' },
  ]);

  // narrator transcript: stopped/waiting (so stale view calculation applies when headSeq - progressSeq >= 10)
  await writeTranscript(root, NARRATOR_CONV, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-06-01T12:03:00.000Z', content: 'narrate' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-06-01T12:04:00.000Z', content: 'Wrote initial view' },
  ]);

  // monitor transcript: actively running observer (must NOT increment counts.active or appear in graph edges)
  await writeTranscript(root, MONITOR_CONV, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-06-01T12:19:00.000Z', content: 'check health' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-06-01T12:19:30.000Z',
      tool_calls: [{ name: 'read_board', args: {} }],
    },
  ]);

  // Board messages: 12 posts so headSeq (12) - narrator progressSeq (2) == 10 -> view.stale === true!
  const boardPosts = [
    { seq: 1, agent: 'coordinator', channel: 'main', text: '@impl Kick off lexer & AST shards', time: '2026-06-01T12:01:00.000Z' },
    { seq: 2, agent: 'impl-1', channel: 'lexer', text: 'Ref #1 starting tokenizer', time: '2026-06-01T12:03:00.000Z' },
    { seq: 3, agent: 'impl-2', channel: 'review', text: '@#review Ready to check AST schema from #1 and #2', time: '2026-06-01T12:06:00.000Z' },
    { seq: 4, agent: 'coordinator', channel: 'main', text: '@all Sync checkpoint before benchmark', time: '2026-06-01T12:08:00.000Z' },
    ...Array.from({ length: 8 }, (_, idx) => ({
      seq: 5 + idx,
      agent: 'reviewer',
      channel: 'review',
      text: `Note ${idx + 1} referencing #3`,
      time: `2026-06-01T12:1${idx}:00.000Z`,
    })),
  ];
  await writeFile(
    join(swarmDir, 'board.jsonl'),
    boardPosts.map(p => JSON.stringify(p) + '\n').join(''),
  );

  // Plan + Narrator fallback view in brain/<narratorConv>/swarm_view/view.json
  await writeFile(
    join(swarmDir, 'plan.json'),
    JSON.stringify({
      goal: { title: 'Ship zero-copy lexer and AST', line: 'All unit tests pass with zero hot-path allocations' },
      tasks: { 'impl-1': 'Tokenizer', 'impl-2': 'AST nodes', reviewer: 'Audit invariants' },
      threads: [{ id: 't1', title: 'Implementation', goal: 'Complete shards', tasks: ['impl-1', 'impl-2'] }],
    }),
  );
  await mkdir(join(root, 'brain', NARRATOR_CONV, 'swarm_view'), { recursive: true });
  await writeFile(
    join(root, 'brain', NARRATOR_CONV, 'swarm_view', 'view.json'),
    JSON.stringify({
      updated_at: '2026-06-01T12:04:00.000Z',
      as_of_seq: 2,
      headline: 'Lexer underway, AST awaiting review',
      phase: { label: 'Implementation', index: 1, total: 2 },
      attention: [
        { id: 'a1', kind: 'fyi', severity: 'low', title: 'Channel #review created', why: 'Dedicated review stream' },
        {
          id: 'a2',
          kind: 'blocker',
          severity: 'high',
          title: 'Benchmark fixture large',
          why: 'Needs streaming reader',
          refs: [{ seq: 2, member: 'impl-1' }],
        },
      ],
      workstreams: [
        { id: 'ws-1', title: 'Lexer', state: 'active', owners: ['impl-1'], note: 'Tokenizing' },
      ],
      milestones: [{ id: 'm1', text: 'Kickoff completed' }],
      risks: [{ id: 'r1', text: 'Quota headroom on flash' }],
    }),
  );

  // 4. Query coordinator snapshot and verify schema, counts, ordering, edges, plan, view, and systemAttention.
  const coordSnap = await engine.getSnapshot({ agentId: 'agent-coord' }, mockPaseo);
  assert.ok(SwarmSnapshotOutputSchema.safeParse(coordSnap).success);
  assert.equal(coordSnap.status, 'ready');
  assert.equal(coordSnap.title, 'Compiler Pipeline Swarm');
  assert.equal(coordSnap.viewerMember, 'coordinator');
  assert.equal(coordSnap.live, true);
  assert.equal(coordSnap.headSeq, 12);

  // Task workers: impl-1 (active), impl-2 (waiting w/ quota failure), reviewer (waiting on swarm_wait), legacy (killed).
  // Observers (narrator, monitor) must be excluded from task counts!
  assert.equal(coordSnap.counts.active, 1);
  assert.equal(coordSnap.counts.waiting, 2);
  assert.equal(coordSnap.counts.killed, 1);
  assert.equal(coordSnap.counts.messages, 12);

  const byName = new Map(coordSnap.members.map(m => [m.name, m]));
  assert.equal(byName.get('coordinator').isSelf, true);
  assert.equal(byName.get('impl-1').status, 'active');
  assert.equal(byName.get('impl-1').activity, 'Run lexer benchmark');
  assert.equal(byName.get('impl-2').status, 'waiting');
  assert.equal(byName.get('impl-2').failure?.kind, 'quota');
  assert.equal(byName.get('reviewer').status, 'waiting');
  assert.equal(byName.get('legacy').status, 'killed');
  assert.equal(byName.get('narrator').isObserver, true);
  assert.equal(byName.get('monitor').isObserver, true);
  assert.equal(byName.get('monitor').status, 'active');

  // Ordering: active members precede waiting members, which precede killed members.
  const statuses = coordSnap.members.map(m => m.status);
  const firstWaiting = statuses.indexOf('waiting');
  const firstKilled = statuses.indexOf('killed');
  assert.ok(firstWaiting > 0 && firstKilled > firstWaiting);

  // Verify @impl group expansion (impl-1 & impl-2), @#review channel edge (reviewer), @all broadcast, and observer exclusion from edges.
  const edgeKeys = new Set(coordSnap.edges.map(e => `${e.from}->${e.to}:d${e.direct}:c${e.viaChannel}:a${e.viaAll}`));
  assert.ok(edgeKeys.has('coordinator->impl-1:d1:c0:a1'), '@impl + @all should link coordinator -> impl-1');
  assert.ok(edgeKeys.has('coordinator->impl-2:d1:c0:a1'), '@impl + @all should link coordinator -> impl-2');
  assert.ok(edgeKeys.has('impl-2->reviewer:d0:c1:a0'), '@#review should link impl-2 -> reviewer');
  assert.ok(!coordSnap.edges.some(e => e.from === 'monitor' || e.to === 'monitor'), 'Observer must not appear in graph edges');

  // Verify #seq references extraction on message #3
  const msg3 = coordSnap.messages.find(m => m.seq === 3);
  assert.deepEqual(msg3.seqRefs, [1, 2]);
  assert.deepEqual(msg3.channelMentions, ['review']);

  // Verify plan & narrator view (stale === true, blocker sorted before fyi)
  assert.equal(coordSnap.plan?.goal?.title, 'Ship zero-copy lexer and AST');
  assert.equal(coordSnap.view?.stale, true);
  assert.equal(coordSnap.view?.attention[0]?.kind, 'blocker');
  assert.equal(coordSnap.view?.attention[1]?.kind, 'fyi');

  // Verify systemAttention: quota on impl-2 + stuck (>10m idle) on impl-1
  const sysKinds = new Set(coordSnap.systemAttention.map(a => `${a.kind}:${a.member}`));
  assert.ok(sysKinds.has('quota:impl-2'));
  assert.ok(sysKinds.has('stuck:impl-1'));

  // 5. Etag cache hit returns status: 'unchanged'
  const cachedSnap = await engine.getSnapshot({ agentId: 'agent-coord', etag: coordSnap.etag }, mockPaseo);
  assert.ok(SwarmSnapshotOutputSchema.safeParse(cachedSnap).success);
  assert.equal(cachedSnap.status, 'unchanged');
  assert.equal(cachedSnap.etag, coordSnap.etag);

  // 6. Worker lookup resolves same swarm with personalized viewerMember ('impl-1') and distinct etag.
  const workerSnap = await engine.getSnapshot({ agentId: 'agent-worker-1', etag: coordSnap.etag }, mockPaseo);
  assert.ok(SwarmSnapshotOutputSchema.safeParse(workerSnap).success);
  assert.equal(workerSnap.status, 'ready');
  assert.equal(workerSnap.swarmId, COORD_CONV);
  assert.equal(workerSnap.viewerMember, 'impl-1');
  assert.notEqual(workerSnap.etag, coordSnap.etag);
  assert.equal(workerSnap.members.find(m => m.name === 'impl-1')?.isSelf, true);
  assert.equal(workerSnap.members.find(m => m.name === 'coordinator')?.isSelf, false);

  // SessionMap fallback lookup without Paseo agents table entry
  const mapSnap = await engine.getSnapshot({ agentId: 'agent-via-map' }, mockPaseo);
  assert.equal(mapSnap.status, 'ready');
  assert.equal(mapSnap.swarmId, COORD_CONV);

  // 7. Appending to board.jsonl invalidates etag and returns updated snapshot.
  await appendFile(
    join(swarmDir, 'board.jsonl'),
    JSON.stringify({ seq: 13, agent: 'impl-1', channel: 'main', text: '@coordinator [done] Lexer finished', time: '2026-06-01T12:20:00.000Z' }) + '\n',
  );
  const updatedSnap = await engine.getSnapshot({ agentId: 'agent-coord', etag: coordSnap.etag }, mockPaseo);
  assert.equal(updatedSnap.status, 'ready');
  assert.equal(updatedSnap.headSeq, 13);
  assert.notEqual(updatedSnap.etag, coordSnap.etag);

  // 8. Server plugin contribute() wiring smoke test.
  const prevDataDirEnv = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = root;
  try {
    let registeredSettings = null;
    let registeredRpcDef = null;
    let registeredRpcHandler = null;
    let registeredProvider = null;
    const cleanup = contributeServer({
      pluginId: 'antigravity-approval',
      dataDir: root,
      paseo: mockPaseo,
      registerSettings(def) {
        registeredSettings = def;
        return {
          read: async () => ({
            status: 'ready',
            values: { agyPath: '', readOnlyRoots: ['/tmp/skills'], progressUpdates: true, backgroundTimeoutMinutes: 45 },
          }),
        };
      },
      handle(def, handler) {
        registeredRpcDef = def;
        registeredRpcHandler = handler;
      },
      registerProvider(provider) {
        registeredProvider = provider;
      },
    });
    assert.ok(registeredSettings, 'Server must register antigravitySettings');
    assert.equal(registeredRpcDef, swarmSnapshotRpc, 'Server must register swarmSnapshotRpc');
    assert.equal(registeredProvider?.id, 'antigravity-acp', 'Server must register antigravity-acp provider');
    const rpcResult = await registeredRpcHandler(
      { agentId: 'agent-coord' },
      { paseo: mockPaseo, signal: new AbortController().signal },
    );
    assert.equal(rpcResult.status, 'ready');
    assert.equal(rpcResult.headSeq, 13);
    cleanup?.();
  } finally {
    if (prevDataDirEnv === undefined) delete process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    else process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = prevDataDirEnv;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ passed: true, suite: 'swarm-snapshot' }));
