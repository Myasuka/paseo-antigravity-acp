import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSideConnection } from '@agentclientprotocol/sdk';
import { AgentTimelineItemPayloadSchema } from '@getpaseo/protocol/messages';
import { BackgroundDrain } from '../server/background-drain.mjs';
import { createDetailedAgyProvider } from '../server/tool-presentation.ts';
import { preserveToolContent } from '../server/tool-content.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const lines = rows => rows.map(row => JSON.stringify(row) + '\n').join('');

const NATIVE_SESSION_ID = '22222222-3333-4444-5555-666666666666';
const WORKER_CONV = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';

async function setupHarness({ offeredCapabilities = ['prompt.message', 'prompt.steer', 'session.configure', 'permission'] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agy-swarm-steer-'));
  const transcriptPath = join(root, 'brain', NATIVE_SESSION_ID, '.system_generated/logs/transcript.jsonl');
  const swarmDir = join(root, 'brain', NATIVE_SESSION_ID, '.system_generated/swarm');
  await mkdir(join(root, 'brain', NATIVE_SESSION_ID, '.system_generated/logs'), { recursive: true });
  await mkdir(swarmDir, { recursive: true });
  await mkdir(join(root, 'brain', WORKER_CONV, '.system_generated/logs'), { recursive: true });
  await writeFile(transcriptPath, '');

  const promptCalls = [];
  const cancelCalls = [];
  let promptHandler = async () => ({ stopReason: 'end_turn' });
  let messageSeq = 0;

  const connector = () => {
    let downstreamController = null;
    let closed = false;
    let peer;
    let agentQueue = Promise.resolve();

    const peerIncoming = new TransformStream();
    const peerInputWriter = peerIncoming.writable.getWriter();

    const writeAgent = msg => {
      if (!closed) void peerInputWriter.write(msg);
    };
    const emitAcp = msg => {
      if (!msg || closed || !downstreamController) return;
      try {
        downstreamController.enqueue(preserveToolContent(msg));
      } catch {
        closed = true;
      }
    };

    const background = new BackgroundDrain({
      emit: emitAcp,
      writeUpstream: writeAgent,
      dataDir: root,
      pollMs: 10,
      settleMs: 15,
      timeoutMs: 4000,
      swarmProgressThrottleMs: 30,
      nativeFull: true,
    });

    const peerOutputWritable = new WritableStream({
      write(message) {
        if (background.isDeferredPromptResponse(message)) {
          void agentQueue.then(async () => {
            if (closed) return;
            emitAcp(await background.fromAgent(message));
          });
          return;
        }
        agentQueue = agentQueue.then(async () => {
          if (closed) return;
          emitAcp(await background.fromAgent(message));
        });
        return agentQueue;
      },
      close() {
        closed = true;
        background.close();
        try {
          downstreamController?.close();
        } catch {}
      },
    });

    const notify = update =>
      peer.sessionUpdate(
        preserveToolContent({ method: 'session/update', params: { sessionId: NATIVE_SESSION_ID, update } }).params,
      );

    peer = new AgentSideConnection(
      () => ({
        initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
        newSession: async () => ({
          sessionId: NATIVE_SESSION_ID,
          modes: {
            currentModeId: 'default',
            availableModes: [
              { id: 'default', name: 'Ask' },
              { id: 'full-access', name: 'Full access' },
            ],
          },
        }),
        setSessionMode: async () => ({}),
        async prompt(params) {
          const text = (params.prompt ?? []).map(p => p.text ?? '').join('\n');
          promptCalls.push({ sessionId: params.sessionId, text });
          return promptHandler({ params, text, notify, msgId: () => `m-${++messageSeq}` });
        },
        async cancel(params) {
          cancelCalls.push(params);
        },
        unstable_closeSession: async () => ({}),
      }),
      { readable: peerIncoming.readable, writable: peerOutputWritable },
    );

    return {
      readable: new ReadableStream({
        start(controller) {
          downstreamController = controller;
        },
        cancel() {
          closed = true;
          background.close();
        },
      }),
      writable: new WritableStream({
        async write(message) {
          const forwarded = await background.fromClient(message);
          writeAgent(forwarded);
        },
        close() {
          closed = true;
          background.close();
          try {
            downstreamController?.close();
          } catch {}
        },
        abort() {
          closed = true;
          background.close();
        },
      }),
      canSteer: sid => background.canSteer(sid),
      steer: (sid, prompt) => background.steer(sid, prompt),
    };
  };

  const registration = createDetailedAgyProvider({
    id: 'antigravity-acp',
    label: 'Antigravity ACP',
    connector,
  });

  const connection = await registration.connect({
    versions: [1],
    capabilities: offeredCapabilities,
  });

  const events = [];
  connection.onEvent(event => events.push(event));

  const waitFor = async (predicate, desc = 'event timeout') => {
    const deadline = Date.now() + 4000;
    while (!predicate(events)) {
      assert.ok(Date.now() < deadline, desc);
      await delay(10);
    }
  };

  return {
    root,
    transcriptPath,
    swarmDir,
    connection,
    events,
    promptCalls,
    cancelCalls,
    setPromptHandler(fn) {
      promptHandler = fn;
    },
    waitFor,
    async cleanup() {
      await connection.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

// 1. Without prompt.steer offered by host, connection & session do not claim prompt.steer.
{
  const h = await setupHarness({ offeredCapabilities: ['prompt.message', 'permission'] });
  try {
    assert.equal(h.connection.capabilities.includes('prompt.steer'), false);
    await h.connection.send({
      type: 'session.open',
      requestId: 'open-no-steer',
      sessionId: 's1',
      history: 'skip',
      config: { cwd: h.root, env: {}, settings: {}, mcpServers: {}, persist: true },
    });
    await h.waitFor(ev => ev.some(e => e.type === 'session.ready' && e.sessionId === 's1'));
    const opened = h.events.find(e => e.type === 'session.opened');
    assert.equal(opened.capabilities.includes('prompt.steer'), false);
  } finally {
    await h.cleanup();
  }
}

// 2. With prompt.steer offered: active foreground falls back cleanly ({ type: 'completed' }),
// whereas Swarm drain accepts steer without session/cancel, streams guidance + progress card, and settles same turn.
{
  const h = await setupHarness();
  try {
    assert.equal(h.connection.capabilities.includes('prompt.steer'), true);
    await h.connection.send({
      type: 'session.open',
      requestId: 'open-1',
      sessionId: 's1',
      history: 'skip',
      config: { cwd: h.root, env: {}, settings: {}, mcpServers: {}, persist: true },
    });
    await h.waitFor(ev => ev.some(e => e.type === 'session.ready' && e.sessionId === 's1'));
    const opened = h.events.find(e => e.type === 'session.opened');
    assert.equal(opened.capabilities.includes('prompt.steer'), true);

    // Prepare active Swarm + foreground P1 (gated so we can test active foreground fallback first!)
    let releaseP1;
    const p1Gate = new Promise(resolve => {
      releaseP1 = resolve;
    });

    const writeWorker = async rows =>
      writeFile(join(h.root, 'brain', WORKER_CONV, '.system_generated/logs/transcript.jsonl'), lines(rows));

    await writeFile(
      join(h.swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Integration Swarm',
        members: {
          worker: { conversation_id: WORKER_CONV, role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', last_read_seq: 1, killed: false },
        },
      }),
    );
    await writeFile(
      join(h.swarmDir, 'board.jsonl'),
      JSON.stringify({ seq: 1, agent: 'coordinator', channel: 'main', text: '@worker build it', time: new Date().toISOString() }) + '\n',
    );
    await writeWorker([
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: new Date().toISOString(), content: 'build it' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date().toISOString(), tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/f"' } }] },
    ]);

    h.setPromptHandler(async ({ text, notify, msgId }) => {
      if (text.includes('Start swarm')) {
        await appendFile(
          h.transcriptPath,
          lines([
            { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: text },
            { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm', args: { action: '"add"', name: '"worker"' } }] },
            { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Spawned' },
            { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'STARTED_SWARM' },
          ]),
        );
        await notify({
          sessionUpdate: 'tool_call',
          toolCallId: 'fg-swarm-add',
          name: 'swarm',
          title: 'Run swarm',
          kind: 'other',
          status: 'completed',
          rawInput: { action: 'add', name: 'worker' },
        });
        await p1Gate;
        await notify({
          sessionUpdate: 'agent_message_chunk',
          messageId: msgId(),
          content: { type: 'text', text: 'STARTED_SWARM' },
        });
        return { stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 10 } };
      }

      if (text.includes('Focus on edge tests')) {
        await notify({
          sessionUpdate: 'tool_call',
          toolCallId: 'steer-swarm-status',
          name: 'swarm',
          title: 'Run swarm',
          kind: 'other',
          status: 'in_progress',
          rawInput: { action: 'status' },
        });
        await notify({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'steer-swarm-status',
          status: 'completed',
          rawOutput: { output: 'worker active' },
        });
        await notify({
          sessionUpdate: 'agent_message_chunk',
          messageId: msgId(),
          content: { type: 'text', text: 'ON_IT_PRIORITIZING' },
        });
        await appendFile(
          h.transcriptPath,
          lines([
            { step_index: 4, type: 'USER_INPUT', status: 'DONE', content: text },
            { step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm', args: { action: '"status"' } }], input_tokens: 15, output_tokens: 5 },
            { step_index: 6, type: 'GENERIC', status: 'DONE', content: 'worker active' },
            { step_index: 7, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'ON_IT_PRIORITIZING', input_tokens: 10, output_tokens: 4 },
          ]),
        );
        return { stopReason: 'end_turn' };
      }
      return { stopReason: 'end_turn' };
    });

    await h.connection.send({
      type: 'session.prompt',
      sessionId: 's1',
      prompt: { clientMessageId: 'p1', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'Start swarm' }] } },
    });
    await h.waitFor(ev => ev.some(e => e.type === 'session.turn' && e.state === 'started'));
    await h.waitFor(ev => ev.some(e => e.type === 'timeline.item' && e.item.type === 'tool_call' && e.item.id === 'fg-swarm-add'));
    const turnId = h.events.find(e => e.type === 'session.turn' && e.state === 'started').turnId;

    // 2a. Steer during active foreground -> returns { type: 'completed' } so host knows steer is unavailable now
    await h.connection.send({
      type: 'session.prompt',
      sessionId: 's1',
      prompt: { clientMessageId: 'steer-early', delivery: 'steer', input: { type: 'message', content: [{ type: 'text', text: 'Too early' }] } },
    });
    await h.waitFor(ev => ev.some(e => e.type === 'session.prompt_result' && e.clientMessageId === 'steer-early'));
    const earlyRes = h.events.find(e => e.type === 'session.prompt_result' && e.clientMessageId === 'steer-early');
    assert.deepEqual(earlyRes.result, { type: 'completed' });
    assert.equal(h.promptCalls.length, 1, 'Early foreground steer must not launch concurrent acp prompt');

    // Release P1 so BackgroundDrain enters Swarm drain mode and emits swarm_progress
    releaseP1();
    await h.waitFor(ev =>
      ev.some(e => e.type === 'timeline.item' && e.item.type === 'tool_call' && e.item.name === 'swarm_progress'),
    );
    const liveCard = h.events.find(e => e.type === 'timeline.item' && e.item.type === 'tool_call' && e.item.name === 'swarm_progress').item;
    assert.equal(liveCard.detail.type, 'plain_text');
    assert.equal(liveCard.detail.icon, 'bot');
    assert.match(liveCard.detail.label, /1 active · #1/);

    // 2b. Steer while draining Swarm -> accepted on same turnId, ZERO session/cancel!
    const userMsgCountBeforeSteer = h.events.filter(e => e.type === 'timeline.item' && e.item.type === 'user_message').length;
    await h.connection.send({
      type: 'session.prompt',
      sessionId: 's1',
      prompt: { clientMessageId: 'steer-ok', delivery: 'steer', input: { type: 'message', content: [{ type: 'text', text: 'Focus on edge tests' }] } },
    });
    await h.waitFor(ev => ev.some(e => e.type === 'session.prompt_result' && e.clientMessageId === 'steer-ok'));
    const steerRes = h.events.find(e => e.type === 'session.prompt_result' && e.clientMessageId === 'steer-ok');
    assert.deepEqual(steerRes.result, { type: 'steer', turnId });
    assert.equal(h.cancelCalls.length, 0, 'Mid-Swarm steer must NOT send session/cancel');
    assert.equal(
      h.events.filter(e => e.type === 'timeline.item' && e.item.type === 'user_message').length,
      userMsgCountBeforeSteer,
      'Accepted steer must NOT emit duplicate user_message item (host records it)',
    );

    // Wait forCoordinator's steered reply AND resumed swarm_progress card #2
    await h.waitFor(ev =>
      ev.some(e => e.type === 'timeline.item' && e.item.type === 'assistant_message' && e.item.text === 'ON_IT_PRIORITIZING'),
    );
    await h.waitFor(ev =>
      ev.some(e => e.type === 'timeline.item' && e.item.type === 'tool_call' && e.item.name === 'swarm_progress' && e.item.id.endsWith(':2')),
    );

    const assistantMsgs = h.events.filter(e => e.type === 'timeline.item' && e.item.type === 'assistant_message');
    const startedItem = assistantMsgs.find(e => e.item.text === 'STARTED_SWARM').item;
    const steerItem = assistantMsgs.find(e => e.item.text === 'ON_IT_PRIORITIZING').item;
    assert.notEqual(startedItem.id, steerItem.id, 'Steered assistant message must not merge into pre-steer message');
    assert.ok(h.events.some(e => e.type === 'timeline.item' && e.item.type === 'tool_call' && e.item.id === 'steer-swarm-status' && e.item.status === 'completed'));

    // Complete Swarm worker + board post + Coordinator final synthesis
    await writeWorker([
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: new Date().toISOString(), content: 'build it' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date().toISOString(), content: 'Done.' },
    ]);
    await appendFile(
      join(h.swarmDir, 'board.jsonl'),
      JSON.stringify({ seq: 2, agent: 'worker', channel: 'main', text: '@coordinator [done] Edge tests green', time: new Date().toISOString() }) + '\n',
    );
    await appendFile(
      h.transcriptPath,
      lines([
        { step_index: 8, type: 'SYSTEM_MESSAGE', status: 'DONE', content: '<SYSTEM_MESSAGE>Board wakeup #2</SYSTEM_MESSAGE>' },
        { step_index: 9, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'FINAL_SWARM_REPORT', input_tokens: 12, output_tokens: 5 },
      ]),
    );

    await h.waitFor(ev => ev.some(e => e.type === 'session.turn' && e.turnId === turnId && e.state === 'completed'));
    const allToolItems = h.events
      .filter(e => e.type === 'timeline.item' && e.item.type === 'tool_call')
      .map(e => e.item);
    assert.ok(allToolItems.every(item => AgentTimelineItemPayloadSchema.safeParse(item).success));
    const settledCard = allToolItems.filter(item => item.name === 'swarm_progress').at(-1);
    assert.equal(settledCard.status, 'completed');
    assert.match(settledCard.detail.label, /^Settled · .*#2/);
    assert.equal(
      h.events.filter(e => e.type === 'timeline.item' && e.item.type === 'assistant_message' && e.item.text === 'ON_IT_PRIORITIZING').length,
      1,
      'Must never replay steered reply twice',
    );
    assert.equal(h.cancelCalls.length, 0);

    // 3. Explicit Stop button (session.interrupt) DOES forward session/cancel and cancels the turn.
    await writeWorker([
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: new Date().toISOString(), content: 'next phase' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date().toISOString(), tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/g"' } }] },
    ]);
    h.setPromptHandler(async ({ text, notify, msgId }) => {
      await appendFile(
        h.transcriptPath,
        lines([
          { step_index: 10, type: 'USER_INPUT', status: 'DONE', content: text },
          { step_index: 11, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', args: { since: '2' } }] },
          { step_index: 12, type: 'GENERIC', status: 'DONE', content: 'Waiting' },
        ]),
      );
      await notify({ sessionUpdate: 'tool_call', toolCallId: 'sw-wait-2', name: 'swarm_wait', title: 'Run swarm_wait', status: 'completed', rawInput: { since: 2 } });
      await notify({ sessionUpdate: 'agent_message_chunk', messageId: msgId(), content: { type: 'text', text: 'WAITING_P2' } });
      return { stopReason: 'end_turn' };
    });

    await h.connection.send({
      type: 'session.prompt',
      sessionId: 's1',
      prompt: { clientMessageId: 'p2', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'Continue phase 2' }] } },
    });
    await h.waitFor(ev =>
      ev.some(e => e.type === 'timeline.item' && e.item.type === 'tool_call' && e.item.id.endsWith(':2:1')),
    );
    await h.connection.send({ type: 'session.interrupt', requestId: 'int-1', sessionId: 's1' });
    await h.waitFor(ev => ev.some(e => e.type === 'session.turn' && e.turnId === 'acp:p2' && e.state === 'canceled'));
    await h.waitFor(() => h.cancelCalls.length === 1, 'session/cancel timeout');
    assert.equal(h.cancelCalls.length, 1, 'Explicit session.interrupt must forward session/cancel');

    // 4. E2E protocol hardening checks through createDetailedAgyProvider + AcpRuntime:
    await writeWorker([
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: new Date().toISOString(), content: 'next phase' },
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date().toISOString(), content: 'Phase 2 stopped.' },
    ]);
    // 4a. Abnormal stopReason (refusal) fails turn instead of falsely completing
    h.setPromptHandler(async () => ({ stopReason: 'refusal' }));
    await h.connection.send({
      type: 'session.prompt',
      sessionId: 's1',
      prompt: { clientMessageId: 'p3-refusal', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'Quota test' }] } },
    });
    await h.waitFor(ev => ev.some(e => e.type === 'session.turn' && e.turnId === 'acp:p3-refusal' && e.state === 'failed'));
    const p3Fail = h.events.find(e => e.type === 'session.turn' && e.turnId === 'acp:p3-refusal' && e.state === 'failed');
    assert.match(p3Fail.error.message, /refused|quota/i);

    // 4b. Blank end_turn (thought-only with no visible reply or tool call) fails turn loudly
    h.setPromptHandler(async ({ notify }) => {
      await notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'internal only' } });
      return { stopReason: 'end_turn' };
    });
    await h.connection.send({
      type: 'session.prompt',
      sessionId: 's1',
      prompt: { clientMessageId: 'p4-blank', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'Blank test' }] } },
    });
    await h.waitFor(ev => ev.some(e => e.type === 'session.turn' && e.turnId === 'acp:p4-blank' && e.state === 'failed'));
    const p4Fail = h.events.find(e => e.type === 'session.turn' && e.turnId === 'acp:p4-blank' && e.state === 'failed');
    assert.match(p4Fail.error.message, /no visible response/i);

    // 4c. Local session.interrupt while agent acknowledges with end_turn coerces turn state to canceled
    let releaseP5;
    const p5Gate = new Promise(resolve => {
      releaseP5 = resolve;
    });
    const promptCountBeforeP5 = h.promptCalls.length;
    h.setPromptHandler(async () => {
      await p5Gate;
      return { stopReason: 'end_turn' };
    });
    await h.connection.send({
      type: 'session.prompt',
      sessionId: 's1',
      prompt: { clientMessageId: 'p5-race', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'Cancel race' }] } },
    });
    await h.waitFor(() => h.promptCalls.length === promptCountBeforeP5 + 1, 'p5 prompt call');
    await h.connection.send({ type: 'session.interrupt', requestId: 'int-race', sessionId: 's1' });
    await h.waitFor(() => h.cancelCalls.length === 2, 'p5 cancel call');
    releaseP5();
    await h.waitFor(ev => ev.some(e => e.type === 'session.turn' && e.turnId === 'acp:p5-race' && e.state === 'canceled'));
  } finally {
    await h.cleanup();
  }
}

console.log(JSON.stringify({ passed: true, suite: 'swarm-steer', promptCallsCounted: 6 }));
