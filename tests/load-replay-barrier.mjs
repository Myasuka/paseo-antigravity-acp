import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSideConnection } from '@agentclientprotocol/sdk';
import { AgentTimelineItemPayloadSchema } from '@getpaseo/protocol/messages';
import { BackgroundDrain } from '../server/background-drain.mjs';
import { preserveToolContent } from '../server/tool-content.mjs';
import { createDetailedAgyProvider } from '../server/tool-presentation.ts';

const TEST_UUID = '11111111-2222-4333-8444-555555555555';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const tempDataDir = mkdtempSync(join(tmpdir(), 'agy-load-barrier-e2e-'));

try {
  const logsDir = join(tempDataDir, 'brain', TEST_UUID, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const transcriptPath = join(logsDir, 'transcript.jsonl');
  const transcriptRows = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-18T08:00:00Z',
      content: '<USER_REQUEST>\nFirst prompt\n</USER_REQUEST>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-18T08:00:05Z',
      thinking: 'Thinking about first prompt.',
      content: 'First answer.',
    },
    {
      step_index: 2,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-18T09:05:00Z',
      content: '<USER_REQUEST>\nRun diagnostics\n</USER_REQUEST>',
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-18T09:05:04Z',
      thinking: 'Inspecting workspace diagnostics.',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'uname -a' } }],
    },
    {
      step_index: 4,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-18T09:05:05Z',
      content: 'Created At: 2026-11-18T09:05:05Z\nCompleted At: 2026-11-18T09:05:12Z\nCommand exited with code 0.',
    },
    {
      step_index: 5,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-18T09:05:20Z',
      content: 'Diagnostics look clean.',
    },
  ];
  writeFileSync(transcriptPath, transcriptRows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  const finalReplyCompletedMs = Date.parse('2026-11-18T09:05:40.000Z');
  utimesSync(transcriptPath, new Date(finalReplyCompletedMs), new Date(finalReplyCompletedMs));

  const createBridgedLateReplayConnector = () => () => {
    let downstreamController = null;
    let streamClosed = false;
    let peer;
    let background;
    let agentQueue = Promise.resolve();

    const enqueueDownstream = msg => {
      if (streamClosed || !downstreamController) return;
      try {
        downstreamController.enqueue(msg);
      } catch {
        streamClosed = true;
      }
    };

    const deliver = msg => {
      if (!msg) return;
      enqueueDownstream(preserveToolContent(msg));
    };

    background = new BackgroundDrain({
      emit: deliver,
      dataDir: tempDataDir,
      pollMs: 10,
      settleMs: 15,
      timeoutMs: 2000,
      loadSettleMs: 60,
      loadMaxWaitMs: 600,
      loadMetaFlushDelayMs: 15,
    });

    const peerIncoming = new TransformStream();
    const peerInputWriter = peerIncoming.writable.getWriter();

    const peerOutputWritable = new WritableStream({
      write(message) {
        agentQueue = agentQueue.then(async () => {
          if (streamClosed) return;
          deliver(await background.fromAgent(message));
        });
        return agentQueue;
      },
      close() {
        streamClosed = true;
        background.close();
        try {
          downstreamController?.close();
        } catch {}
      },
    });

    const notify = update =>
      peer.sessionUpdate(
        preserveToolContent({ method: 'session/update', params: { sessionId: TEST_UUID, update } }).params,
      );

    peer = new AgentSideConnection(
      () => ({
        initialize: async () => ({
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
        }),
        newSession: async () => ({ sessionId: TEST_UUID }),
        async loadSession() {
          // Synchronous pre-response Turn 1 replay.
          await notify({
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'First prompt' },
          });
          await notify({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Thinking about first prompt.' },
          });
          await notify({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'First answer.' },
          });

          // Simulate agy acp bug: loadSession resolves BEFORE Turn 2 history replay arrives,
          // and metadata (available_commands_update / usage_update) appears in the middle of Turn 2.
          setTimeout(() => {
            void (async () => {
              if (streamClosed) return;
              await notify({
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'Run diagnostics' },
              });
              await notify({
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: 'Inspecting workspace diagnostics.' },
              });
              await notify({
                sessionUpdate: 'available_commands_update',
                availableCommands: [{ name: 'swarm', description: 'Run Swarm coordinator' }],
              });
              await notify({
                sessionUpdate: 'usage_update',
                used: 1200,
                size: 10000,
              });
              await delay(25);
              if (streamClosed) return;
              await notify({
                sessionUpdate: 'tool_call',
                toolCallId: 'late-cmd-1',
                name: 'run_command',
                title: 'uname -a',
                kind: 'execute',
                status: 'completed',
                rawInput: { CommandLine: 'uname -a', Cwd: '/tmp/example' },
                rawOutput: { output: 'Linux', exit_code: 0 },
              });
              await notify({
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Diagnostics look clean.' },
              });
              await notify({
                sessionUpdate: 'usage_update',
                used: 4200,
                size: 10000,
              });
            })().catch(() => undefined);
          }, 15);

          return { modes: null, configOptions: [] };
        },
        async prompt() {
          await notify({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Live follow-up works.' },
          });
          return { stopReason: 'end_turn' };
        },
        cancel: async () => {},
        unstable_closeSession: async () => ({}),
      }),
      { readable: peerIncoming.readable, writable: peerOutputWritable },
    );

    const readable = new ReadableStream({
      start(controller) {
        downstreamController = controller;
      },
      cancel() {
        streamClosed = true;
        background.close();
      },
    });

    const writable = new WritableStream({
      async write(message) {
        const forwarded = await background.fromClient(message);
        if (forwarded) await peerInputWriter.write(forwarded);
      },
      async close() {
        streamClosed = true;
        background.close();
        await peerInputWriter.close().catch(() => undefined);
      },
      async abort() {
        streamClosed = true;
        background.close();
        await peerInputWriter.abort().catch(() => undefined);
      },
    });

    return { readable, writable };
  };

  const registration = createDetailedAgyProvider({
    id: 'antigravity-acp-load-barrier-test',
    label: 'Antigravity Load Barrier Test',
    acpOptions: { waitForInitialCommands: true, initialCommandsTimeoutMs: 2000 },
    connector: createBridgedLateReplayConnector(),
  });

  const connection = await registration.connect({
    versions: [1],
    capabilities: ['prompt.message', 'permission', 'session.persistence'],
    launch: { env: { ANTIGRAVITY_EXECUTABLE_DATA_DIR: tempDataDir } },
  });

  const events = [];
  const unsubscribe = connection.onEvent(event => events.push(event));
  const wait = async predicate => {
    const deadline = Date.now() + 5000;
    while (!events.some(predicate)) {
      assert.ok(Date.now() < deadline, 'Event timeout');
      await delay(10);
    }
  };

  try {
    // 1. history: 'replay' keeps late post-LOAD_RES updates inside the replay window,
    // preserves all timestamps, and flushes commands/usage cleanly without timing out.
    const openStartedAt = Date.now();
    await connection.send({
      type: 'session.open',
      requestId: 'open-replay-late',
      sessionId: 'sess-replay-late',
      history: 'replay',
      persistence: { version: 1, provider: 'antigravity-acp-load-barrier-test', data: { sessionId: TEST_UUID } },
      config: {
        cwd: '/tmp/example',
        env: { ANTIGRAVITY_EXECUTABLE_DATA_DIR: tempDataDir },
        settings: {},
        mcpServers: {},
        persist: true,
      },
    });
    await wait(e => e.type === 'session.ready' && e.sessionId === 'sess-replay-late');
    const openElapsedMs = Date.now() - openStartedAt;
    assert.ok(
      openElapsedMs < 1500,
      `waitForInitialCommands should resolve early from deferred metadata flush (took ${openElapsedMs}ms)`,
    );

    const openedIdx = events.findIndex(e => e.type === 'session.opened' && e.sessionId === 'sess-replay-late');
    const readyIdx = events.findIndex(e => e.type === 'session.ready' && e.sessionId === 'sess-replay-late');
    assert.ok(openedIdx >= 0 && readyIdx > openedIdx);

    // Wait briefly beyond any lingering timers to confirm zero post-ready leakage.
    await delay(100);

    const timelineAfterReady = events.slice(readyIdx + 1).filter(e => e.type === 'timeline.item');
    assert.equal(timelineAfterReady.length, 0, 'Late replay updates must never leak after session.ready');

    const replayTimeline = events.slice(0, openedIdx).filter(e => e.type === 'timeline.item');
    assert.equal(replayTimeline.length, 7, 'Both Turn 1 and late Turn 2 items must arrive before session.opened');
    for (const e of replayTimeline) {
      assert.ok(AgentTimelineItemPayloadSchema.safeParse(e.item).success);
    }

    assert.equal(replayTimeline[0].item.type, 'user_message');
    assert.equal(replayTimeline[0].timestamp, '2026-11-18T08:00:00.000Z');
    assert.equal(replayTimeline[1].item.type, 'reasoning');
    assert.equal(replayTimeline[1].timestamp, '2026-11-18T08:00:05.000Z');
    assert.equal(replayTimeline[2].item.type, 'assistant_message');
    assert.equal(replayTimeline[2].timestamp, '2026-11-18T08:00:05.000Z');

    assert.equal(replayTimeline[3].item.type, 'user_message');
    assert.equal(replayTimeline[3].item.text, 'Run diagnostics');
    assert.equal(replayTimeline[3].timestamp, '2026-11-18T09:05:00.000Z');

    assert.equal(replayTimeline[4].item.type, 'reasoning');
    assert.equal(replayTimeline[4].timestamp, '2026-11-18T09:05:04.000Z');

    assert.equal(replayTimeline[5].item.type, 'tool_call');
    assert.equal(replayTimeline[5].item.detail.type, 'shell');
    assert.equal(replayTimeline[5].item.detail.command, 'uname -a');
    assert.equal(replayTimeline[5].timestamp, '2026-11-18T09:05:12.000Z');

    assert.equal(replayTimeline[6].item.type, 'assistant_message');
    assert.equal(replayTimeline[6].item.text, 'Diagnostics look clean.');
    assert.equal(replayTimeline[6].timestamp, '2026-11-18T09:05:40.000Z');

    const commandsEvent = events.find(e => e.type === 'session.commands' && e.sessionId === 'sess-replay-late');
    assert.equal(commandsEvent?.commands?.[0]?.name, 'swarm');
    const usageEvents = events.filter(e => e.type === 'session.usage' && e.sessionId === 'sess-replay-late');
    assert.equal(usageEvents.at(-1)?.usage?.contextWindowUsedTokens, 4200);

    // Live turn works normally afterward without historical timestamps.
    const countBeforeLive = events.length;
    await connection.send({
      type: 'session.prompt',
      sessionId: 'sess-replay-late',
      prompt: {
        clientMessageId: 'live-after-load',
        delivery: 'auto',
        input: { type: 'message', content: [{ type: 'text', text: 'continue' }] },
      },
    });
    await wait(e => e.type === 'session.turn' && e.sessionId === 'sess-replay-late' && e.state === 'completed');
    const liveTimeline = events.slice(countBeforeLive).filter(e => e.type === 'timeline.item');
    assert.ok(liveTimeline.some(e => e.item.type === 'assistant_message' && e.item.text === 'Live follow-up works.'));
    for (const e of liveTimeline) {
      assert.equal(e.timestamp, undefined);
    }

    // 2. history: 'skip' (Full Access reopen) suppresses ALL late replay items cleanly
    // while still delivering deferred commands & usage after AcpRuntime exits replayWindow.
    const skipStartIdx = events.length;
    await connection.send({
      type: 'session.open',
      requestId: 'open-skip-late',
      sessionId: 'sess-skip-late',
      history: 'skip',
      persistence: { version: 1, provider: 'antigravity-acp-load-barrier-test', data: { sessionId: TEST_UUID } },
      config: {
        cwd: '/tmp/example',
        env: { ANTIGRAVITY_EXECUTABLE_DATA_DIR: tempDataDir },
        settings: {},
        mcpServers: {},
        persist: true,
      },
    });
    await wait(e => e.type === 'session.ready' && e.sessionId === 'sess-skip-late');
    await delay(100);

    const skipEvents = events.slice(skipStartIdx);
    const leakedTimeline = skipEvents.filter(e => e.type === 'timeline.item');
    assert.equal(leakedTimeline.length, 0, 'history: skip must emit zero timeline items from late replay');
    const skipCommands = skipEvents.find(e => e.type === 'session.commands' && e.sessionId === 'sess-skip-late');
    assert.equal(skipCommands?.commands?.[0]?.name, 'swarm');
    const skipUsage = skipEvents.filter(e => e.type === 'session.usage' && e.sessionId === 'sess-skip-late');
    assert.equal(skipUsage.at(-1)?.usage?.contextWindowUsedTokens, 4200);
  } finally {
    unsubscribe();
    await connection.close();
  }
} finally {
  rmSync(tempDataDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ passed: true, suite: 'load-replay-barrier' }));
