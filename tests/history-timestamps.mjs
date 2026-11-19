import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSideConnection } from '@agentclientprotocol/sdk';
import { AgentTimelineItemPayloadSchema } from '@getpaseo/protocol/messages';
import {
  buildHistoryTimestampEntries,
  HistoryTimestampMatcher,
  loadHistoryTimestampMatcher,
} from '../server/history-timestamps.mjs';
import { createDetailedAgyProvider } from '../server/tool-presentation.ts';
import { preserveToolContent } from '../server/tool-content.mjs';

const TEST_UUID = '11111111-2222-4333-8444-555555555555';

// 1. Unit tests for transcript row parsing, bounds, turn isolation, and chunk-id reuse.
{
  const finalCreatedMs = Date.parse('2026-11-18T10:02:10.000Z');
  const fileMtimeMs = finalCreatedMs + 18_500;
  const rows = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-18T10:00:00Z',
      content: '<USER_REQUEST>\nCheck server status\n</USER_REQUEST>\n<ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-18T10:00:02Z',
      thinking: 'Inspecting the workspace files first.',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'uptime' } }],
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-18T10:00:15Z',
      content: 'Created At: 2026-11-18T10:00:15Z\nCompleted At: 2026-11-18T10:00:22Z\nCommand exited with code 0.',
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-18T10:00:25Z',
      content: 'System is healthy.',
    },
    {
      step_index: 4,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: '2026-11-18T10:01:00Z',
      content: '<SYSTEM_MESSAGE>background notification</SYSTEM_MESSAGE>',
    },
    {
      step_index: 5,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-18T10:02:00Z',
      content: '<USER_REQUEST>\nSummarize findings cleanly for the team.\n</USER_REQUEST>',
    },
    {
      step_index: 6,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-18T10:02:10Z',
      thinking: 'Drafting final summary.',
      content: 'All checks passed.',
    },
  ];

  const entries = buildHistoryTimestampEntries(rows, { fileMtimeMs });
  const matcher = new HistoryTimestampMatcher(entries);

  assert.equal(
    matcher.match({ type: 'user_message', id: 'u1', text: 'Check server status' }),
    '2026-11-18T10:00:00.000Z',
  );
  assert.equal(
    matcher.match({ type: 'reasoning', id: 'r1', text: 'Inspecting the' }),
    '2026-11-18T10:00:02.000Z',
  );
  // Repeated updates for the same item.id reuse the cached timestamp without advancing cursor.
  assert.equal(
    matcher.match({ type: 'reasoning', id: 'r1', text: 'Inspecting the workspace files first.' }),
    '2026-11-18T10:00:02.000Z',
  );
  assert.equal(
    matcher.match({ type: 'tool_call', id: 't1', callId: 't1', name: 'run_command', status: 'completed', detail: { type: 'unknown' } }),
    '2026-11-18T10:00:22.000Z',
  );
  assert.equal(
    matcher.match({ type: 'assistant_message', id: 'a1', text: 'System is healthy.' }),
    '2026-11-18T10:00:25.000Z',
  );
  // Extra unmatched assistant item in Turn 1 must never steal Turn 2's timestamp.
  assert.equal(
    matcher.match({ type: 'assistant_message', id: 'a1-extra', text: 'Unexpected extra line' }),
    '2026-11-18T10:00:25.000Z',
  );
  assert.equal(
    matcher.match({ type: 'user_message', id: 'u2', text: 'Summarize findings cleanly' }),
    '2026-11-18T10:02:00.000Z',
  );
  assert.equal(
    matcher.match({ type: 'reasoning', id: 'r2', text: 'Drafting final summary.' }),
    '2026-11-18T10:02:10.000Z',
  );
  assert.equal(
    matcher.match({ type: 'assistant_message', id: 'a2', text: 'All checks passed.' }),
    new Date(fileMtimeMs).toISOString(),
  );
}

// 2. Out-of-range or pre-creation mtime is ignored safely in favor of last step created_at.
{
  const rows = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-18T12:00:00Z', content: 'Hi' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-18T12:00:05Z', content: 'Hello!' },
  ];
  const tooOld = buildHistoryTimestampEntries(rows, { fileMtimeMs: Date.parse('2026-11-18T11:59:00Z') });
  assert.equal(tooOld.at(-1)?.timestamp, '2026-11-18T12:00:05.000Z');

  const tooLate = buildHistoryTimestampEntries(rows, { fileMtimeMs: Date.parse('2026-11-18T15:00:00Z') });
  assert.equal(tooLate.at(-1)?.timestamp, '2026-11-18T12:00:05.000Z');
}

// 3. Missing, invalid, or corrupt transcripts degrade cleanly to null.
{
  const missingRoot = mkdtempSync(join(tmpdir(), 'agy-hist-missing-'));
  try {
    assert.equal(await loadHistoryTimestampMatcher({ nativeSessionId: 'not-a-uuid', dataDir: missingRoot }), null);
    assert.equal(await loadHistoryTimestampMatcher({ nativeSessionId: TEST_UUID, dataDir: missingRoot }), null);
    const logsDir = join(missingRoot, 'brain', TEST_UUID, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, 'transcript.jsonl'), '{bad json\n', 'utf8');
    writeFileSync(
      join(logsDir, 'transcript_full.jsonl'),
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-18T08:00:00Z', content: 'Fallback works' }) + '\n',
      'utf8',
    );
    const fallbackMatcher = await loadHistoryTimestampMatcher({ nativeSessionId: TEST_UUID, dataDir: missingRoot });
    assert.ok(fallbackMatcher);
    assert.equal(
      fallbackMatcher.match({ type: 'user_message', id: 'u', text: 'Fallback works' }),
      '2026-11-18T08:00:00.000Z',
    );
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
  }
}

// 4. End-to-end provider integration test: loadSession replay injects transcript timestamps & retains tool detail, then clears for live turns.
{
  const tempDataDir = mkdtempSync(join(tmpdir(), 'agy-hist-e2e-'));
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
        created_at: '2026-11-18T09:10:00Z',
        content: '<USER_REQUEST>\nRun a quick check\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-18T09:10:04Z',
        thinking: 'Checking environment via run_command.',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'printf OK' } }],
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-18T09:10:05Z',
        content: 'Created At: 2026-11-18T09:10:05Z\nCompleted At: 2026-11-18T09:10:12Z\nCommand exited with code 0.',
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-18T09:10:15Z',
        content: 'Check passed cleanly.',
      },
    ];
    writeFileSync(transcriptPath, transcriptRows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const finalReplyCompletedMs = Date.parse('2026-11-18T09:10:40.000Z');
    utimesSync(transcriptPath, new Date(finalReplyCompletedMs), new Date(finalReplyCompletedMs));

    const registration = createDetailedAgyProvider({
      id: 'antigravity-acp-history-test',
      label: 'Antigravity History Test',
      connector() {
        const incoming = new TransformStream();
        const outgoing = new TransformStream();
        let peer;
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
              await notify({
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'Run a quick check' },
              });
              await notify({
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: 'Checking environment via run_command.' },
              });
              await notify({
                sessionUpdate: 'tool_call',
                toolCallId: 'tool-check-1',
                name: 'run_command',
                title: 'printf OK',
                kind: 'execute',
                status: 'completed',
                rawInput: { CommandLine: 'printf OK', Cwd: '/tmp/example' },
                rawOutput: { output: 'OK', exit_code: 0 },
              });
              await notify({
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Check ' },
              });
              await notify({
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'passed cleanly.' },
              });
              return { modes: null, configOptions: [] };
            },
            async prompt() {
              await notify({
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Live follow-up reply.' },
              });
              return { stopReason: 'end_turn' };
            },
            cancel: async () => {},
            unstable_closeSession: async () => ({}),
          }),
          { readable: incoming.readable, writable: outgoing.writable },
        );
        return { readable: outgoing.readable, writable: incoming.writable };
      },
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
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };

    try {
      await connection.send({
        type: 'session.open',
        requestId: 'open-replay',
        sessionId: 'sess-replay',
        history: 'replay',
        persistence: { version: 1, provider: 'antigravity-acp-history-test', data: { sessionId: TEST_UUID } },
        config: {
          cwd: '/tmp/example',
          env: { ANTIGRAVITY_EXECUTABLE_DATA_DIR: tempDataDir },
          settings: {},
          mcpServers: {},
          persist: true,
        },
      });
      await wait(e => e.type === 'session.ready' && e.sessionId === 'sess-replay');

      const replayTimeline = events.filter(e => e.type === 'timeline.item');
      assert.equal(replayTimeline.length, 5);
      for (const e of replayTimeline) {
        assert.ok(AgentTimelineItemPayloadSchema.safeParse(e.item).success);
      }

      assert.equal(replayTimeline[0].item.type, 'user_message');
      assert.equal(replayTimeline[0].timestamp, '2026-11-18T09:10:00.000Z');

      assert.equal(replayTimeline[1].item.type, 'reasoning');
      assert.equal(replayTimeline[1].timestamp, '2026-11-18T09:10:04.000Z');

      assert.equal(replayTimeline[2].item.type, 'tool_call');
      assert.equal(replayTimeline[2].item.detail.type, 'shell');
      assert.equal(replayTimeline[2].item.detail.command, 'printf OK');
      assert.equal(replayTimeline[2].timestamp, '2026-11-18T09:10:12.000Z');

      assert.equal(replayTimeline[3].item.type, 'assistant_message');
      assert.equal(replayTimeline[3].timestamp, '2026-11-18T09:10:40.000Z');
      assert.equal(replayTimeline[4].item.type, 'assistant_message');
      assert.equal(replayTimeline[4].timestamp, '2026-11-18T09:10:40.000Z');

      const countBeforeLive = events.length;
      await connection.send({
        type: 'session.prompt',
        sessionId: 'sess-replay',
        prompt: {
          clientMessageId: 'live-p1',
          delivery: 'auto',
          input: { type: 'message', content: [{ type: 'text', text: 'live follow-up' }] },
        },
      });
      await wait(e => e.type === 'session.turn' && e.state === 'completed');

      const liveTimeline = events.slice(countBeforeLive).filter(e => e.type === 'timeline.item');
      assert.ok(liveTimeline.some(e => e.item.type === 'assistant_message'));
      for (const e of liveTimeline) {
        assert.equal(e.timestamp, undefined, 'Live turn events must not inherit replay timestamps');
      }

      // history: 'skip' must not inject replay timestamps either.
      const countBeforeSkip = events.length;
      await connection.send({
        type: 'session.open',
        requestId: 'open-skip',
        sessionId: 'sess-skip',
        history: 'skip',
        persistence: { version: 1, provider: 'antigravity-acp-history-test', data: { sessionId: TEST_UUID } },
        config: {
          cwd: '/tmp/example',
          env: { ANTIGRAVITY_EXECUTABLE_DATA_DIR: tempDataDir },
          settings: {},
          mcpServers: {},
          persist: true,
        },
      });
      await wait(e => e.type === 'session.ready' && e.sessionId === 'sess-skip');
      assert.equal(events.slice(countBeforeSkip).filter(e => e.type === 'timeline.item').length, 0);
    } finally {
      unsubscribe();
      await connection.close();
    }
  } finally {
    rmSync(tempDataDir, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ passed: true, suite: 'history-timestamps' }));
