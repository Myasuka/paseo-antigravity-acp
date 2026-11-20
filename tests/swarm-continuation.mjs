import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SWARM_WORKER_STALE_MS,
  inspectSwarmContinuation,
  summarizeMemberTranscript,
} from '../server/swarm-state.mjs';

const COORD_CONV = '11111111-2222-3333-4444-555555555555';
const WORKER_CONV = 'aaaaaaaa-1111-2222-3333-444444444444';

const lines = rows => rows.map(row => JSON.stringify(row) + '\n').join('');

async function writeSwarm(root, { members, posts = [], membersMtimeMs = null }) {
  const swarmDir = join(root, 'brain', COORD_CONV, '.system_generated', 'swarm');
  await mkdir(swarmDir, { recursive: true });
  const membersPath = join(swarmDir, 'members.json');
  await writeFile(membersPath, JSON.stringify({ title: 'Test Swarm', members }));
  if (membersMtimeMs !== null) {
    const dt = new Date(membersMtimeMs);
    await utimes(membersPath, dt, dt);
  }
  await writeFile(
    join(swarmDir, 'board.jsonl'),
    posts.map(post => JSON.stringify(post) + '\n').join(''),
  );
  return swarmDir;
}

async function writeTranscript(root, convId, rows, mtimeMs = null) {
  const dir = join(root, 'brain', convId, '.system_generated', 'logs');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'transcript.jsonl');
  await writeFile(path, lines(rows));
  if (mtimeMs !== null) {
    const dt = new Date(mtimeMs);
    await utimes(path, dt, dt);
  }
  return path;
}

const cases = [];
const nowMs = Date.parse('2026-06-01T12:00:00.000Z');

// 1. Stale worker stuck on PLANNER_RESPONSE DONE with write_file/run_command and no GENERIC rows (2h old).
{
  const root = await mkdtemp(join(tmpdir(), 'agy-swarm-cont-1-'));
  try {
    const twoHoursAgoIso = new Date(nowMs - 2 * 60 * 60 * 1000).toISOString();
    await writeSwarm(root, {
      members: {
        'stg-ops': {
          conversation_id: WORKER_CONV,
          role: 'worker',
          phase: 'RUNNING',
          wake_mode: 'working',
          last_read_seq: 1,
          killed: false,
        },
      },
      posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@stg-ops verify stg', time: twoHoursAgoIso }],
    });
    await writeTranscript(root, COORD_CONV, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: twoHoursAgoIso, content: 'check' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: twoHoursAgoIso, content: 'ok' },
    ]);
    await writeTranscript(root, WORKER_CONV, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: twoHoursAgoIso, content: 'verify stg' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: twoHoursAgoIso,
        tool_calls: [
          { name: 'write_file', args: { Path: '"/tmp/probe.py"' } },
          { name: 'run_command', args: { CommandLine: '"python3 /tmp/probe.py"' } },
        ],
      },
    ]);

    const state = await inspectSwarmContinuation({ dataDir: root, sessionId: COORD_CONV, nowMs });
    assert.equal(state.exists, true);
    assert.equal(state.active, false);
    assert.deepEqual(state.activeWorkerConversations, []);
    assert.deepEqual(state.staleWorkerConversations, [WORKER_CONV]);
    assert.equal(state.hasWorkingTaskWorkers, false);
    assert.equal(state.awaitingApproval, false);
    assert.equal(state.workingWorkers?.length, 1);
    assert.equal(state.workingWorkers?.[0]?.stale, true);
    cases.push('stale-mid-tool-worker');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 2. Fresh worker in the same mid-tool state (30s old) remains active and awaitingApproval.
{
  const root = await mkdtemp(join(tmpdir(), 'agy-swarm-cont-2-'));
  try {
    const recentIso = new Date(nowMs - 30 * 1000).toISOString();
    await writeSwarm(root, {
      members: {
        'stg-ops': {
          conversation_id: WORKER_CONV,
          role: 'worker',
          phase: 'RUNNING',
          wake_mode: 'working',
          last_read_seq: 1,
          killed: false,
        },
      },
      posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@stg-ops verify stg', time: recentIso }],
    });
    await writeTranscript(root, COORD_CONV, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: recentIso, content: 'check' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: recentIso, content: 'ok' },
    ]);
    await writeTranscript(root, WORKER_CONV, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: recentIso, content: 'verify stg' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: recentIso,
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"npm test"' } }],
      },
    ]);

    const state = await inspectSwarmContinuation({ dataDir: root, sessionId: COORD_CONV, nowMs });
    assert.equal(state.exists, true);
    assert.equal(state.active, true);
    assert.deepEqual(state.activeWorkerConversations, [WORKER_CONV]);
    assert.deepEqual(state.staleWorkerConversations, []);
    assert.equal(state.awaitingApproval, true);
    assert.equal(state.workingWorkers?.[0]?.stale, false);
    cases.push('fresh-mid-tool-worker');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 3. GENERIC step with created_at 12m ago and Completed At 20s ago uses Completed At for lastProgressMs and stays active.
{
  const root = await mkdtemp(join(tmpdir(), 'agy-swarm-cont-3-'));
  try {
    const twelveMinAgoIso = new Date(nowMs - 12 * 60 * 1000).toISOString();
    const twentySecAgoMs = nowMs - 20 * 1000;
    const twentySecAgoIso = new Date(twentySecAgoMs).toISOString();
    await writeSwarm(root, {
      members: {
        worker: {
          conversation_id: WORKER_CONV,
          role: 'worker',
          phase: 'RUNNING',
          wake_mode: 'mentions',
          last_read_seq: 1,
          killed: false,
        },
      },
      posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@worker run', time: twelveMinAgoIso }],
    });
    const workerTranscriptPath = await writeTranscript(root, WORKER_CONV, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: twelveMinAgoIso, content: 'run' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: twelveMinAgoIso,
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"long-build"' } }],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'DONE',
        created_at: twelveMinAgoIso,
        content: `Created At: ${twelveMinAgoIso}\nCompleted At: ${twentySecAgoIso}\nCommand exited with code 0.\n`,
      },
    ]);

    const summary = await summarizeMemberTranscript(workerTranscriptPath, nowMs);
    assert.equal(summary.lastProgressMs, twentySecAgoMs);
    const state = await inspectSwarmContinuation({ dataDir: root, sessionId: COORD_CONV, nowMs });
    assert.equal(state.active, true);
    assert.deepEqual(state.activeWorkerConversations, [WORKER_CONV]);
    assert.deepEqual(state.staleWorkerConversations, []);
    cases.push('generic-completed-at-progress');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 4. Missing worker transcript (exists: false, wait_since: null, no wake_mode) falls back to members.json mtime.
{
  const root = await mkdtemp(join(tmpdir(), 'agy-swarm-cont-4-'));
  try {
    await writeSwarm(root, {
      members: {
        ghost: {
          conversation_id: WORKER_CONV,
          role: 'worker',
          wait_since: null,
          killed: false,
        },
      },
      posts: [],
      membersMtimeMs: nowMs - 20 * 60 * 1000,
    });
    const staleState = await inspectSwarmContinuation({ dataDir: root, sessionId: COORD_CONV, nowMs });
    assert.equal(staleState.active, false);
    assert.deepEqual(staleState.staleWorkerConversations, [WORKER_CONV]);

    await writeSwarm(root, {
      members: {
        ghost: {
          conversation_id: WORKER_CONV,
          role: 'worker',
          wait_since: null,
          killed: false,
        },
      },
      posts: [],
      membersMtimeMs: nowMs - 2000,
    });
    const freshState = await inspectSwarmContinuation({ dataDir: root, sessionId: COORD_CONV, nowMs });
    assert.equal(freshState.active, true);
    assert.deepEqual(freshState.activeWorkerConversations, [WORKER_CONV]);
    assert.deepEqual(freshState.staleWorkerConversations, []);
    cases.push('missing-transcript-members-mtime');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 5. Fresh board wakeup keeps a 2h-old worker active within wakeupGraceMs, then falls back to stale once grace passes.
{
  const root = await mkdtemp(join(tmpdir(), 'agy-swarm-cont-5-'));
  try {
    const twoHoursAgoIso = new Date(nowMs - 2 * 60 * 60 * 1000).toISOString();
    const wakeAtMs = nowMs - 5000;
    await writeSwarm(root, {
      members: {
        impl: {
          conversation_id: WORKER_CONV,
          role: 'worker',
          phase: 'RUNNING',
          wake_mode: 'working',
          last_read_seq: 1,
          killed: false,
        },
      },
      posts: [
        { seq: 1, agent: 'coordinator', channel: 'main', text: '@impl start', time: twoHoursAgoIso },
        { seq: 2, agent: 'coordinator', channel: 'main', text: '@impl resume', time: new Date(wakeAtMs).toISOString() },
      ],
    });
    await writeTranscript(root, WORKER_CONV, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: twoHoursAgoIso, content: 'start' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: twoHoursAgoIso,
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 1"' } }],
      },
    ]);

    const duringGrace = await inspectSwarmContinuation({
      dataDir: root,
      sessionId: COORD_CONV,
      nowMs,
      wakeupGraceMs: 15000,
    });
    assert.equal(duringGrace.active, true);
    assert.deepEqual(duringGrace.activeWorkerConversations, [WORKER_CONV]);
    assert.deepEqual(duringGrace.staleWorkerConversations, []);

    const afterGrace = await inspectSwarmContinuation({
      dataDir: root,
      sessionId: COORD_CONV,
      nowMs: wakeAtMs + 20000,
      wakeupGraceMs: 15000,
    });
    assert.equal(afterGrace.active, false);
    assert.deepEqual(afterGrace.activeWorkerConversations, []);
    assert.deepEqual(afterGrace.staleWorkerConversations, [WORKER_CONV]);
    cases.push('fresh-wakeup-grace-window');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 6. observedWorkers map refreshes observedAtMs when a worker writes a new step, then transitions to stale if idle for workerStaleMs.
{
  const root = await mkdtemp(join(tmpdir(), 'agy-swarm-cont-6-'));
  try {
    const startMs = nowMs;
    const oldRowIso = new Date(startMs - 5 * 60 * 1000).toISOString();
    await writeSwarm(root, {
      members: {
        impl: {
          conversation_id: WORKER_CONV,
          role: 'worker',
          phase: 'RUNNING',
          wake_mode: 'mentions',
          last_read_seq: 1,
          killed: false,
        },
      },
      posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@impl work', time: oldRowIso }],
    });
    const observedWorkers = new Map();
    const row1 = [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: oldRowIso, content: 'work' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: oldRowIso,
        tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/a"' } }],
      },
    ];
    await writeTranscript(root, WORKER_CONV, row1, startMs - 40);

    const first = await inspectSwarmContinuation({
      dataDir: root,
      sessionId: COORD_CONV,
      nowMs: startMs,
      workerStaleMs: 100,
      observedWorkers,
    });
    // Row has old created_at (5m ago), so without prior progress it is immediately stale against workerStaleMs=100.
    assert.equal(first.active, false);

    // Worker writes a new step -> progressKey changes -> observedWorkers refreshes observedAtMs to startMs + 20.
    const t1 = startMs + 20;
    await writeTranscript(
      root,
      WORKER_CONV,
      [
        ...row1,
        { step_index: 2, type: 'GENERIC', status: 'DONE', created_at: oldRowIso, content: 'file content' },
        {
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: oldRowIso,
          tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/b"' } }],
        },
      ],
      t1,
    );
    const second = await inspectSwarmContinuation({
      dataDir: root,
      sessionId: COORD_CONV,
      nowMs: t1,
      workerStaleMs: 100,
      observedWorkers,
    });
    assert.equal(second.active, true);
    assert.deepEqual(second.activeWorkerConversations, [WORKER_CONV]);
    assert.equal(observedWorkers.get(WORKER_CONV)?.observedAtMs, t1);

    // Still unchanged 60ms later (< 100ms): remains active.
    const third = await inspectSwarmContinuation({
      dataDir: root,
      sessionId: COORD_CONV,
      nowMs: t1 + 60,
      workerStaleMs: 100,
      observedWorkers,
    });
    assert.equal(third.active, true);

    // Unchanged past workerStaleMs (t1 + 110): becomes stale.
    const fourth = await inspectSwarmContinuation({
      dataDir: root,
      sessionId: COORD_CONV,
      nowMs: t1 + 110,
      workerStaleMs: 100,
      observedWorkers,
    });
    assert.equal(fourth.active, false);
    assert.deepEqual(fourth.staleWorkerConversations, [WORKER_CONV]);
    cases.push('observed-workers-refresh-and-stale');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 7. Worker waiting on an unfinished background run_command (GENERIC RUNNING + zero-tool PLANNER_RESPONSE DONE)
// must remain working and active until SYSTEM_MESSAGE task completion arrives.
{
  const root = await mkdtemp(join(tmpdir(), 'agy-swarm-cont-7-'));
  try {
    const recentIso = new Date(nowMs - 20 * 1000).toISOString();
    await writeSwarm(root, {
      members: {
        'core-slim': {
          conversation_id: WORKER_CONV,
          role: 'worker',
          phase: 'RUNNING',
          wake_mode: 'working',
          last_read_seq: 1,
          killed: false,
        },
      },
      posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@core-slim test', time: '2026-01-01T00:00:00.000Z' }],
    });
    const baseRows = [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: recentIso, content: 'test' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: recentIso,
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"go test -v -race ./..."', WaitMsBeforeAsync: '10000' } }],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: recentIso,
        content: `Created At: ${recentIso}\nTool is running as a background task with task id: ${WORKER_CONV}/task-156\nTask Description: go test -v -race ./...`,
      },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: recentIso,
        content: 'Running go test -race in background; waiting for completion.',
      },
    ];
    const tp = await writeTranscript(root, WORKER_CONV, baseRows);
    const summary = await summarizeMemberTranscript(tp, nowMs);
    assert.equal(summary.runState, 'working');
    assert.equal(summary.pendingBackgroundCount, 1);
    assert.equal(summary.activityKind, 'tool');
    assert.match(summary.activity ?? '', /task-156/);
    assert.equal(summary.awaitingApproval, false);

    const activeState = await inspectSwarmContinuation({ dataDir: root, sessionId: COORD_CONV, nowMs });
    assert.equal(activeState.active, true);
    assert.deepEqual(activeState.activeWorkerConversations, [WORKER_CONV]);
    assert.equal(activeState.awaitingApproval, false);

    // Once SYSTEM_MESSAGE finishes task-156 and worker emits final reply, transitions cleanly to waiting.
    await writeTranscript(root, WORKER_CONV, [
      ...baseRows,
      {
        step_index: 4,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: new Date(nowMs - 5 * 1000).toISOString(),
        content: `<SYSTEM_MESSAGE>\n[Message] sender=${WORKER_CONV}/task-156 content=Task id "${WORKER_CONV}/task-156" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>`,
      },
      {
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date(nowMs - 2 * 1000).toISOString(),
        content: 'All tests passed.',
      },
    ]);
    const doneSummary = await summarizeMemberTranscript(tp, nowMs);
    assert.equal(doneSummary.runState, 'waiting');
    assert.equal(doneSummary.pendingBackgroundCount, 0);
    const doneState = await inspectSwarmContinuation({ dataDir: root, sessionId: COORD_CONV, nowMs });
    assert.equal(doneState.active, false);
    assert.deepEqual(doneState.activeWorkerConversations, []);
    cases.push('background-task-working-until-finished');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 8. IsDaemon: true, read_file output containing launch text, and Command output stdout do NOT mark worker working.
{
  const root = await mkdtemp(join(tmpdir(), 'agy-swarm-cont-8-'));
  try {
    const fakeLaunch = `Tool is running as a background task with task id: ${WORKER_CONV}/task-999`;
    const tp = await writeTranscript(root, WORKER_CONV, [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'checks' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"dev-server"', IsDaemon: 'true' } }],
      },
      { step_index: 2, type: 'GENERIC', status: 'RUNNING', content: `Created At: now\n${fakeLaunch}\n` },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/log"' } }],
      },
      { step_index: 4, type: 'GENERIC', status: 'DONE', content: fakeLaunch },
      {
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"cat log"' } }],
      },
      {
        step_index: 6,
        type: 'GENERIC',
        status: 'DONE',
        content: `Created At: now\nCommand exited with code 0.\n\nCommand output:\n${fakeLaunch}\n`,
      },
      { step_index: 7, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Inspected logs.' },
    ]);
    const summary = await summarizeMemberTranscript(tp, nowMs);
    assert.equal(summary.runState, 'waiting');
    assert.equal(summary.pendingBackgroundCount, 0);
    cases.push('daemon-and-stdout-not-tracked-as-bg');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 9. manage_task kill, server restart notice, and stream-interrupted ERROR_MESSAGE clear pending background tasks.
{
  const root = await mkdtemp(join(tmpdir(), 'agy-swarm-cont-9-'));
  try {
    const baseLaunch = [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'run' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 60"' } }],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        content: `Created At: now\nTool is running as a background task with task id: ${WORKER_CONV}/task-10`,
      },
    ];
    // manage_task kill (short ID form)
    const tpKill = await writeTranscript(root, WORKER_CONV, [
      ...baseLaunch,
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'manage_task', args: { Action: '"kill"', TaskId: '"task-10"' } }],
      },
      { step_index: 4, type: 'GENERIC', status: 'DONE', content: 'Killed task-10' },
      { step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Stopped task.' },
    ]);
    assert.equal((await summarizeMemberTranscript(tpKill, nowMs)).runState, 'waiting');

    // server restart notice
    const tpRestart = await writeTranscript(root, WORKER_CONV, [
      ...baseLaunch,
      {
        step_index: 3,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content:
          '<SYSTEM_MESSAGE>\n[Message] sender=system content=[Notice] All your subagents and background tasks have been stopped due to server restart.\n</SYSTEM_MESSAGE>',
      },
      { step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Paused after restart.' },
    ]);
    assert.equal((await summarizeMemberTranscript(tpRestart, nowMs)).runState, 'waiting');

    // stream interrupted ERROR_MESSAGE (even with status DONE, as emitted by AGY)
    const tpInterrupted = await writeTranscript(root, WORKER_CONV, [
      ...baseLaunch,
      {
        step_index: 3,
        type: 'ERROR_MESSAGE',
        status: 'DONE',
        content: 'Error: The stream was interrupted. Please continue the task you were working on.',
      },
    ]);
    const interruptedSummary = await summarizeMemberTranscript(tpInterrupted, nowMs);
    assert.equal(interruptedSummary.runState, 'waiting');
    assert.equal(interruptedSummary.failure, null);
    cases.push('kill-restart-and-interruption-clear-bg');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 10. Parallel background tasks: finishing one keeps pendingBackgroundCount === 1 (working) until both finish.
{
  const root = await mkdtemp(join(tmpdir(), 'agy-swarm-cont-10-'));
  try {
    const partialRows = [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'parallel' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: '"test-a"' } },
          { name: 'run_command', args: { CommandLine: '"test-b"' } },
        ],
      },
      { step_index: 2, type: 'GENERIC', status: 'RUNNING', content: `Tool is running as a background task with task id: ${WORKER_CONV}/task-1` },
      { step_index: 3, type: 'GENERIC', status: 'RUNNING', content: `Tool is running as a background task with task id: ${WORKER_CONV}/task-2` },
      {
        step_index: 4,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: `<SYSTEM_MESSAGE>\ncontent=Task id "${WORKER_CONV}/task-1" finished with result:\nOK\n</SYSTEM_MESSAGE>`,
      },
      { step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Task 1 done, waiting on task 2.' },
    ];
    const tp = await writeTranscript(root, WORKER_CONV, partialRows);
    const mid = await summarizeMemberTranscript(tp, nowMs);
    assert.equal(mid.runState, 'working');
    assert.equal(mid.pendingBackgroundCount, 1);
    assert.match(mid.activity ?? '', /task-2/);

    await writeTranscript(root, WORKER_CONV, [
      ...partialRows,
      {
        step_index: 6,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: `<SYSTEM_MESSAGE>\ncontent=Task id "${WORKER_CONV}/task-2" finished with result:\nOK\n</SYSTEM_MESSAGE>`,
      },
      { step_index: 7, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Both done.' },
    ]);
    const done = await summarizeMemberTranscript(tp, nowMs);
    assert.equal(done.runState, 'waiting');
    assert.equal(done.pendingBackgroundCount, 0);
    cases.push('parallel-background-tasks');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 11. Worker waiting on active invoke_subagent stays working until subagent goes idle.
{
  const root = await mkdtemp(join(tmpdir(), 'agy-swarm-cont-11-'));
  const subConv = 'bbbbbbbb-1111-2222-3333-444444444444';
  try {
    const recentIso = new Date(nowMs - 15 * 1000).toISOString();
    await writeSwarm(root, {
      members: {
        impl: { conversation_id: WORKER_CONV, role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', last_read_seq: 1, killed: false },
      },
      posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@impl check', time: '2026-01-01T00:00:00.000Z' }],
    });
    const launchRows = [
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: recentIso, content: 'check' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: recentIso,
        tool_calls: [{ name: 'invoke_subagent', args: { TypeName: '"research"', Role: '"Auditor"', Prompt: '"audit"' } }],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'DONE',
        created_at: recentIso,
        content: `Created the following subagent:\n{\n  "conversationId": "${subConv}"\n}\n`,
      },
      { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: recentIso, content: 'Waiting on Auditor.' },
    ];
    const tp = await writeTranscript(root, WORKER_CONV, launchRows);
    const active = await summarizeMemberTranscript(tp, nowMs);
    assert.equal(active.runState, 'working');
    assert.equal(active.pendingBackgroundCount, 1);
    assert.equal(active.activity, 'Waiting on subagent');
    assert.equal((await inspectSwarmContinuation({ dataDir: root, sessionId: COORD_CONV, nowMs })).active, true);

    await writeTranscript(root, WORKER_CONV, [
      ...launchRows,
      {
        step_index: 4,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: new Date(nowMs - 5 * 1000).toISOString(),
        content: `<SYSTEM_MESSAGE>\n[Message] sender=system content=Subagent ${subConv} has gone idle. This was the subagent's most recent response: Audit OK\n</SYSTEM_MESSAGE>`,
      },
      { step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date(nowMs - 1000).toISOString(), content: 'Audit complete.' },
    ]);
    const done = await summarizeMemberTranscript(tp, nowMs);
    assert.equal(done.runState, 'waiting');
    assert.equal(done.pendingBackgroundCount, 0);
    assert.equal((await inspectSwarmContinuation({ dataDir: root, sessionId: COORD_CONV, nowMs })).active, false);
    cases.push('worker-active-subagent');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 12. Live .system_generated/tasks/task-146.log mtime keeps worker active past transcript age > workerStaleMs,
// and becomes stale once the task log also stops updating past workerStaleMs.
{
  const root = await mkdtemp(join(tmpdir(), 'agy-swarm-cont-12-'));
  try {
    const twelveMinAgoMs = nowMs - 12 * 60 * 1000;
    const twelveMinAgoIso = new Date(twelveMinAgoMs).toISOString();
    await writeSwarm(root, {
      members: {
        'mw-e2e-slim': {
          conversation_id: WORKER_CONV,
          role: 'worker',
          phase: 'RUNNING',
          wake_mode: 'working',
          last_read_seq: 1,
          killed: false,
        },
      },
      posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@mw-e2e-slim test', time: '2026-01-01T00:00:00.000Z' }],
    });
    const tp = await writeTranscript(
      root,
      WORKER_CONV,
      [
        { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: twelveMinAgoIso, content: 'test' },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: twelveMinAgoIso,
          tool_calls: [{ name: 'run_command', args: { CommandLine: '"go test -race ./..."' } }],
        },
        {
          step_index: 2,
          type: 'GENERIC',
          status: 'RUNNING',
          created_at: twelveMinAgoIso,
          content: `Tool is running as a background task with task id: ${WORKER_CONV}/task-146`,
        },
        { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: twelveMinAgoIso, content: 'Waiting on task-146.' },
      ],
      twelveMinAgoMs,
    );
    const taskLogDir = join(root, 'brain', WORKER_CONV, '.system_generated', 'tasks');
    await mkdir(taskLogDir, { recursive: true });
    const taskLogPath = join(taskLogDir, 'task-146.log');
    const recentTaskMs = nowMs - 5 * 1000;
    await writeFile(taskLogPath, '=== RUN TestMiddleware\n');
    await utimes(taskLogPath, new Date(recentTaskMs), new Date(recentTaskMs));

    const summary = await summarizeMemberTranscript(tp, nowMs);
    assert.equal(summary.runState, 'working');
    assert.equal(summary.lastProgressMs, recentTaskMs);
    assert.match(summary.backgroundProgressKey, /^t:task-146:/);

    const activeState = await inspectSwarmContinuation({ dataDir: root, sessionId: COORD_CONV, nowMs });
    assert.equal(activeState.active, true);
    assert.deepEqual(activeState.activeWorkerConversations, [WORKER_CONV]);

    // If task-146.log also stopped advancing 12m ago, worker is correctly classified as stale.
    await utimes(taskLogPath, new Date(twelveMinAgoMs), new Date(twelveMinAgoMs));
    const staleState = await inspectSwarmContinuation({ dataDir: root, sessionId: COORD_CONV, nowMs });
    assert.equal(staleState.active, false);
    assert.deepEqual(staleState.staleWorkerConversations, [WORKER_CONV]);
    cases.push('live-task-log-prevents-false-staleness');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

assert.equal(DEFAULT_SWARM_WORKER_STALE_MS, 10 * 60 * 1000);
console.log(JSON.stringify({ passed: true, suite: 'swarm-continuation', cases }));
