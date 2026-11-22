import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, rename, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundDrain } from '../server/background-drain.mjs';

const id = '11111111-2222-3333-4444-555555555555';
const command = 'sleep 6; printf DONE';
const tool = (step = 1, cmd = command) => ({
  step_index: step,
  type: 'PLANNER_RESPONSE',
  status: 'DONE',
  tool_calls: [{ name: 'run_command', args: { CommandLine: JSON.stringify(cmd), WaitMsBeforeAsync: '1' } }],
});
const launch = (step = 2, task = 'task-2') => ({
  step_index: step,
  type: 'GENERIC',
  status: 'RUNNING',
  content: `Created At: now\nTool is running as a background task with task id: ${id}/${task}\nTask Description: synthetic`,
});
const message = (step, content = 'Finished for real') => ({
  step_index: step,
  type: 'PLANNER_RESPONSE',
  status: 'DONE',
  content,
  input_tokens: 5,
  cache_read_tokens: 2,
  output_tokens: 3,
});
const finished = (step = 4, task = 'task-2', code = 0) => ({
  step_index: step,
  type: 'SYSTEM_MESSAGE',
  status: 'DONE',
  content: `<SYSTEM_MESSAGE>\n[Message] sender=${id}/${task} content=Task id "${id}/${task}" finished with result:\nCommand exited with code ${code}.\n\nCommand output:\nDONE\n</SYSTEM_MESSAGE>`,
});
const lines = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
const response = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    stopReason: 'end_turn',
    usage: { inputTokens: 100, outputTokens: 10, cachedReadTokens: 30, totalTokens: 140 },
  },
};

let cases = 0;
async function scenario(test) {
  const root = await mkdtemp(join(tmpdir(), 'agy-background-unit-'));
  const path = join(root, 'brain', id, '.system_generated/logs/transcript.jsonl');
  await mkdir(join(root, 'brain', id, '.system_generated/logs'), { recursive: true });
  await writeFile(path, '');
  const emitted = [];
  const bridge = new BackgroundDrain({
    dataDir: root,
    emit: event => emitted.push(event),
    pollMs: 5,
    settleMs: 10,
    timeoutMs: 1000,
    nativeFull: false,
  });
  const append = async rows => appendFile(path, lines(rows));
  const begin = async () =>
    bridge.fromClient({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: id, prompt: [{ type: 'text', text: 'synthetic' }] },
    });
  const observe = async (callId, cmd = command) =>
    bridge.fromAgent({
      method: 'session/update',
      params: {
        sessionId: id,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: callId,
          name: 'run_command',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { CommandLine: cmd, WaitMsBeforeAsync: 1 },
        },
      },
    });
  const foreground = async () => {
    await append([{ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'synthetic' }, tool(), launch(), message(3, 'STARTED')]);
    await observe('call-1');
    await bridge.fromAgent({
      method: 'session/update',
      params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STARTED' } } },
    });
  };
  try {
    await test({ root, bridge, emitted, path, append, begin, observe, foreground });
    cases++;
  } finally {
    bridge.close();
    await rm(root, { recursive: true, force: true });
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

await scenario(async ({ bridge, append, begin, foreground }) => {
  bridge.approvalStallMs = 20;
  await begin();
  await foreground();
  const done = bridge.fromAgent(response);
  await append([finished(), tool(5, 'requires-new-approval')]);
  assert.match((await done).error.message, /ACP approval request/);
});

await scenario(async ({ bridge, append, begin, foreground }) => {
  bridge.approvalStallMs = 15;
  await begin();
  await foreground();
  const done = bridge.fromAgent(response);
  await bridge.fromAgent({ id: 'new-approval', method: 'session/request_permission', params: { sessionId: id } });
  await append([finished(), tool(5, 'needs-approval')]);
  let completed = false;
  void done.then(() => {
    completed = true;
  });
  await delay(35);
  assert.equal(completed, false, 'A real user approval may remain pending');
  await bridge.fromClient({ id: 'new-approval', result: { outcome: { outcome: 'cancelled' } } });
  await append([{ step_index: 6, type: 'GENERIC', status: 'ERROR', error: 'User denied', content: 'Denied' }, message(7)]);
  assert.equal((await done).result.stopReason, 'end_turn');
});

await scenario(async ({ bridge, append, begin, observe }) => {
  await begin();
  await observe('call-1');
  await append([
    tool(),
    { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Command exited with code 0.\n\nCommand output:\n' + launch().content },
  ]);
  assert.deepEqual(await bridge.fromAgent(response), response, 'Command stdout cannot create a background task');
});

await scenario(async ({ bridge, append, begin, foreground }) => {
  await begin();
  await foreground();
  const done = bridge.fromAgent(response);
  await append([finished(), { step_index: 5, type: 'PLANNER_RESPONSE', status: 'ERROR', error: 'Native planner failed' }]);
  assert.match((await done).error.message, /Native planner failed/);
});

await scenario(async ({ bridge, path, begin, foreground }) => {
  await begin();
  await foreground();
  const done = bridge.fromAgent(response);
  await appendFile(path, 'not valid json\n');
  assert.match((await done).error.message, /Invalid AGY transcript JSONL/);
});

await scenario(async ({ bridge, append, begin, emitted }) => {
  await begin();
  await append([{ ...tool(), tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/readme"' } }] }, { ...launch(), status: 'DONE' }]);
  assert.deepEqual(await bridge.fromAgent(response), response);
  assert.equal(emitted.length, 0, 'File contents must not be interpreted as task-control records');
});

await scenario(async ({ bridge, append, begin, foreground, emitted }) => {
  await begin();
  await foreground();
  const done = bridge.fromAgent(response);
  await assert.rejects(bridge.fromClient({ id: 2, method: 'session/prompt', params: { sessionId: id } }), /already has an active/);
  await append([finished(), message(5)]);
  assert.equal((await done).result.stopReason, 'end_turn');
  assert.equal(emitted.filter(e => e.params.update.sessionUpdate === 'agent_message_chunk').length, 1);
});

await scenario(async ({ bridge, append, begin, foreground, emitted }) => {
  await begin();
  await foreground();
  const done = bridge.fromAgent(response);
  await append([{ step_index: 4, type: 'USER_INPUT', status: 'DONE', content: 'Another client' }, message(5)]);
  assert.equal((await done).result.stopReason, 'cancelled');
  assert.equal(emitted.length, 0);
});

await scenario(async ({ bridge, emitted, append, begin, foreground }) => {
  await begin();
  await foreground();
  let settled = false;
  const done = bridge.fromAgent(response).then(result => {
    settled = true;
    return result;
  });
  await delay(30);
  assert.equal(settled, false, 'Must not finish while the native task is running');
  await append([finished(), message(5)]);
  const result = await done;
  assert.equal(result.id, response.id);
  assert.equal(result.result.stopReason, 'end_turn');
  assert.equal(emitted.filter(e => e.params.update.sessionUpdate === 'agent_message_chunk').length, 1);
  assert.equal(emitted.find(e => e.params.update.sessionUpdate === 'agent_message_chunk').params.update.content.text, 'Finished for real');
  assert.equal(emitted.find(e => e.params.update.toolCallId === 'call-1').params.update.status, 'completed');
  assert.deepEqual(result.result.usage, { inputTokens: 105, outputTokens: 13, cachedReadTokens: 32, totalTokens: 150 });
});

await scenario(async ({ bridge, emitted, append, begin, foreground }) => {
  await begin();
  await foreground();
  await append([finished(), message(5)]);
  assert.equal((await bridge.fromAgent(response)).result.stopReason, 'end_turn');
  assert.equal(emitted.filter(e => e.params.update.sessionUpdate === 'agent_message_chunk').length, 1);
});

await scenario(async ({ bridge, emitted, append, begin }) => {
  await begin();
  await append([message(0, 'No tools')]);
  assert.deepEqual(await bridge.fromAgent(response), response);
  assert.equal(emitted.length, 0);
});

await scenario(async ({ bridge, emitted, append, begin }) => {
  await append([tool(), launch()]);
  await begin();
  await append([message(3, 'Different request')]);
  assert.deepEqual(await bridge.fromAgent(response), response);
  assert.equal(emitted.length, 0);
});

for (const method of ['session/cancel', 'session/close']) {
  await scenario(async ({ bridge, emitted, begin, foreground }) => {
    await begin();
    await foreground();
    const done = bridge.fromAgent(response);
    await delay(20);
    await bridge.fromClient({ method, params: { sessionId: id } });
    assert.equal((await done).result.stopReason, 'cancelled');
    assert.equal(emitted.length, 0);
  });
}

await scenario(async ({ bridge, emitted, begin, foreground }) => {
  await begin();
  await foreground();
  const done = bridge.fromAgent(response);
  await delay(20);
  bridge.close();
  assert.equal((await done).result.stopReason, 'cancelled');
  assert.equal(emitted.length, 0);
});

await scenario(async ({ bridge, append, begin, foreground, emitted }) => {
  await begin();
  await foreground();
  const done = bridge.fromAgent(response);
  await append([
    finished(),
    tool(5, 'false'),
    { step_index: 6, type: 'GENERIC', status: 'DONE', content: 'Command exited with code 1.\n\nCommand output:\nFAILED' },
    message(7, 'The next tool failed'),
  ]);
  assert.equal((await done).result.stopReason, 'end_turn');
  assert.ok(emitted.some(e => e.params.update.status === 'failed' && e.params.update.rawOutput.exit_code === 1));
});

await scenario(async ({ bridge, append, begin, foreground }) => {
  await begin();
  await foreground();
  const done = bridge.fromAgent(response);
  await append([finished(), { step_index: 5, type: 'ERROR_MESSAGE', status: 'ERROR', error: 'Provider rejected request' }]);
  assert.match((await done).error.message, /Provider rejected request/);
});

await scenario(async ({ bridge, begin, foreground, emitted }) => {
  bridge.timeoutMs = 30;
  await begin();
  await foreground();
  assert.match((await bridge.fromAgent(response)).error.message, /Timed out/);
  assert.equal(emitted.length, 0);
});

await scenario(async ({ bridge, append, begin, foreground, emitted, path }) => {
  await begin();
  await foreground();
  const done = bridge.fromAgent(response);
  const completeLine = JSON.stringify(finished()) + '\n';
  await appendFile(path, completeLine.slice(0, 30));
  await delay(20);
  assert.equal(emitted.length, 0);
  await appendFile(path, completeLine.slice(30));
  await append([message(5, 'UTF-8 完成')]);
  assert.equal((await done).result.stopReason, 'end_turn');
  assert.ok(emitted.some(e => e.params.update.content?.text === 'UTF-8 完成'));
});

await scenario(async ({ bridge, append, begin, observe, emitted }) => {
  await begin();
  await append([tool(1, 'one'), launch(2, 'task-2'), tool(3, 'two'), launch(4, 'task-4'), message(5, 'STARTED')]);
  await observe('one', 'one');
  await observe('two', 'two');
  let settled = false;
  const done = bridge.fromAgent(response).then(result => {
    settled = true;
    return result;
  });
  await append([finished(6, 'task-4'), message(7, 'Second completed')]);
  await delay(35);
  assert.equal(settled, false);
  await append([finished(8, 'task-2'), message(9, 'Both completed')]);
  assert.equal((await done).result.stopReason, 'end_turn');
  assert.deepEqual(
    new Set(emitted.filter(e => e.params.update.sessionUpdate === 'tool_call_update').map(e => e.params.update.toolCallId)),
    new Set(['one', 'two']),
  );
});

await scenario(async ({ bridge, append, begin, foreground, emitted, path }) => {
  await begin();
  await foreground();
  const done = bridge.fromAgent(response);
  const replacement = path + '.new';
  await writeFile(replacement, lines([tool(), launch(), message(3, 'STARTED'), finished(), message(5)]));
  await rename(replacement, path);
  assert.equal((await done).result.stopReason, 'end_turn');
  assert.equal(emitted.filter(e => e.params.update.sessionUpdate === 'agent_message_chunk').length, 1);
});

await scenario(async ({ bridge, begin, foreground, emitted }) => {
  await begin();
  await foreground();
  const permission = { jsonrpc: '2.0', id: 'permission', method: 'session/request_permission', params: { sessionId: id, options: [] } };
  assert.deepEqual(await bridge.fromAgent(permission), permission);
  const error = { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Original failure' } };
  assert.deepEqual(await bridge.fromAgent(error), error);
  assert.equal(emitted.length, 0);
});

const subA = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const subB = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const invokeSub = (step, role = 'Verifier', typeName = 'research') => ({
  step_index: step,
  type: 'PLANNER_RESPONSE',
  status: 'DONE',
  tool_calls: [{ name: 'invoke_subagent', args: { TypeName: JSON.stringify(typeName), Role: JSON.stringify(role), Prompt: JSON.stringify('check') } }],
});
const subCreated = (step, subId) => ({
  step_index: step,
  type: 'GENERIC',
  status: 'DONE',
  content: `Created At: now\nCompleted At: now\nCreated the following subagent:\n{\n  "conversationId":  "${subId}",\n  "logAbsoluteUri":  "file:///tmp/${subId}"\n}\nThe subagent will send you a message when it has completed its task.`,
});
const subIdle = (step, subId, text = 'SUB_REPORT_OK') => ({
  step_index: step,
  type: 'SYSTEM_MESSAGE',
  status: 'DONE',
  content: `The following is a <SYSTEM_MESSAGE>\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=now sender=system priority=MESSAGE_PRIORITY_HIGH content=Subagent ${subId} has gone idle. This was the subagent's most recent response: ${text}\n</SYSTEM_MESSAGE>`,
});
const subDirect = (step, subId, text = 'DIRECT_REPORT_OK') => ({
  step_index: step,
  type: 'SYSTEM_MESSAGE',
  status: 'DONE',
  content: `The following is a <SYSTEM_MESSAGE>\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=now sender=${subId} priority=MESSAGE_PRIORITY_HIGH content=${text}\n</SYSTEM_MESSAGE>`,
});

await scenario(async ({ bridge, emitted, append, begin }) => {
  await begin();
  await append([{ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'review' }, invokeSub(1), subCreated(2, subA), message(3, 'WAITING')]);
  await bridge.fromAgent({
    method: 'session/update',
    params: {
      sessionId: id,
      update: { sessionUpdate: 'tool_call', toolCallId: 'sub-call-1', name: 'invoke_subagent', kind: 'other', status: 'completed', rawInput: { TypeName: 'research', Role: 'Verifier', Prompt: 'check' } },
    },
  });
  await bridge.fromAgent({ method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WAITING' } } } });
  let settled = false;
  const done = bridge.fromAgent(response).then(r => {
    settled = true;
    return r;
  });
  await delay(25);
  assert.equal(settled, false, 'Must hold turn while subagent is running');
  assert.equal(emitted.find(e => e.params.update.toolCallId === 'sub-call-1')?.params.update.status, 'in_progress');
  await append([subIdle(4, subA, 'INVARIANT_PROVED'), message(5, 'FINAL_SYNTHESIS')]);
  const result = await done;
  assert.equal(result.result.stopReason, 'end_turn');
  const updates = emitted.filter(e => e.params.update.toolCallId === 'sub-call-1').map(e => e.params.update);
  assert.equal(updates.at(-1).status, 'completed');
  assert.equal(updates.at(-1).rawOutput.conversationId, subA);
  assert.equal(updates.at(-1).rawOutput.output, 'INVARIANT_PROVED');
  const msgs = emitted.filter(e => e.params.update.sessionUpdate === 'agent_message_chunk');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].params.update.content.text, 'FINAL_SYNTHESIZED' in msgs ? 'x' : 'FINAL_SYNTHESIS');
  assert.deepEqual(result.result.usage, { inputTokens: 105, outputTokens: 13, cachedReadTokens: 32, totalTokens: 150 });
});

await scenario(async ({ bridge, emitted, append, begin }) => {
  await begin();
  await append([
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'parallel' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [invokeSub(1, 'R1').tool_calls[0], invokeSub(1, 'R2').tool_calls[0]] },
    subCreated(2, subA),
    subCreated(3, subB),
    message(4, 'WAITING_BOTH'),
  ]);
  await bridge.fromAgent({ method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'tool_call', toolCallId: 's1', name: 'invoke_subagent', status: 'completed', rawInput: { TypeName: 'research', Role: 'R1', Prompt: 'check' } } } });
  await bridge.fromAgent({ method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'tool_call', toolCallId: 's2', name: 'invoke_subagent', status: 'completed', rawInput: { TypeName: 'research', Role: 'R2', Prompt: 'check' } } } });
  await bridge.fromAgent({ method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WAITING_BOTH' } } } });
  let settled = false;
  const done = bridge.fromAgent(response).then(r => {
    settled = true;
    return r;
  });
  await append([subDirect(5, subA, 'PART_1'), message(6, 'Got first, still waiting')]);
  await delay(25);
  assert.equal(settled, false, 'Must wait for second subagent too');
  await append([
    { step_index: 7, type: 'ERROR_MESSAGE', status: 'DONE', error: 'API error (attempt 1): stream idle timeout' },
    subIdle(8, subB, 'PART_2'),
    message(9, 'ALL_SYNTHESIZED'),
  ]);
  assert.equal((await done).result.stopReason, 'end_turn');
  const texts = emitted.filter(e => e.params.update.sessionUpdate === 'agent_message_chunk').map(e => e.params.update.content.text);
  assert.deepEqual(texts, ['Got first, still waiting', 'ALL_SYNTHESIZED']);
});

await scenario(async ({ bridge, emitted, append, begin }) => {
  await begin();
  await append([{ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'fast' }, invokeSub(1), subCreated(2, subA), message(3, 'WAITING'), subIdle(4, subA, 'FAST_OK'), message(5, 'PARENT_DONE')]);
  await bridge.fromAgent({ method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'tool_call', toolCallId: 'fast-1', name: 'invoke_subagent', status: 'completed', rawInput: { TypeName: 'research', Role: 'Verifier', Prompt: 'check' } } } });
  await bridge.fromAgent({ method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WAITING' } } } });
  await bridge.fromAgent({ method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PARENT_DONE' } } } });
  const result = await bridge.fromAgent(response);
  assert.equal(result.result.stopReason, 'end_turn');
  assert.equal(emitted.filter(e => e.params.update.sessionUpdate === 'agent_message_chunk').length, 0, 'Must not duplicate foreground messages');
  assert.deepEqual(result.result.usage, response.result.usage, 'Must not double count foreground tokens');
});

await scenario(async ({ bridge, append, begin }) => {
  await begin();
  await append([{ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'kill' }, invokeSub(1), subCreated(2, subA), message(3, 'WAITING')]);
  await bridge.fromAgent({ method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'tool_call', toolCallId: 'k1', name: 'invoke_subagent', status: 'completed', rawInput: { TypeName: 'research', Role: 'Verifier', Prompt: 'check' } } } });
  await bridge.fromAgent({ method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WAITING' } } } });
  const done = bridge.fromAgent(response);
  await append([
    { step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'manage_subagents', args: { Action: '"kill"', ConversationIds: JSON.stringify([subA]) } }] },
    { step_index: 5, type: 'GENERIC', status: 'DONE', content: 'Successfully killed 1 subagent(s) and their descendants.' },
    message(6, 'Killed and finished directly'),
  ]);
  assert.equal((await done).result.stopReason, 'end_turn');
});

await scenario(async ({ bridge, append, begin }) => {
  await begin();
  await append([{ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 're-message' }, invokeSub(1), subCreated(2, subA), message(3, 'WAITING')]);
  await bridge.fromAgent({ method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'tool_call', toolCallId: 'rm1', name: 'invoke_subagent', status: 'completed', rawInput: { TypeName: 'research', Role: 'Verifier', Prompt: 'check' } } } });
  await bridge.fromAgent({ method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WAITING' } } } });
  let settled = false;
  const done = bridge.fromAgent(response).then(r => {
    settled = true;
    return r;
  });
  await append([
    subIdle(4, subA, 'NEED_MORE'),
    { step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'send_message', args: { Recipient: JSON.stringify(subA), Message: '"continue"' } }] },
    { step_index: 6, type: 'GENERIC', status: 'DONE', content: `Message sent to "${subA}".` },
    message(7, 'WAITING_AGAIN'),
  ]);
  await delay(25);
  assert.equal(settled, false, 'Re-messaging known subagent must keep round open');
  await append([subDirect(8, subA, 'SECOND_OK'), message(9, 'COMPLETE_AFTER_FOLLOWUP')]);
  assert.equal((await done).result.stopReason, 'end_turn');
});

await scenario(async ({ bridge, append, begin, emitted }) => {
  await begin();
  await append([{ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/log"' } }] }, subCreated(2, subA)]);
  assert.deepEqual(await bridge.fromAgent(response), response);
  assert.equal(emitted.length, 0);
});

await scenario(async ({ root, bridge, append, begin }) => {
  bridge.subagentFailureGraceMs = 20;
  const subDir = join(root, 'brain', subA, '.system_generated/logs');
  await mkdir(subDir, { recursive: true });
  await writeFile(
    join(subDir, 'transcript.jsonl'),
    JSON.stringify({ step_index: 1, type: 'ERROR_MESSAGE', status: 'ERROR', error: 'Subagent quota exhausted' }) + '\n',
  );
  await begin();
  await append([{ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'crash' }, invokeSub(1), subCreated(2, subA), message(3, 'WAITING')]);
  await bridge.fromAgent({ method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'tool_call', toolCallId: 'c1', name: 'invoke_subagent', status: 'completed', rawInput: { TypeName: 'research', Role: 'Verifier', Prompt: 'check' } } } });
  await bridge.fromAgent({ method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WAITING' } } } });
  assert.match((await bridge.fromAgent(response)).error.message, /Subagent quota exhausted/);
});

const workerConv = 'cccccccc-dddd-eeee-ffff-111111111111';
const narratorConv = 'dddddddd-eeee-ffff-1111-222222222222';
const monitorConv = 'eeeeeeee-ffff-1111-2222-333333333333';

async function setupSwarm(root, { members, posts = [] }) {
  const swarmDir = join(root, 'brain', id, '.system_generated/swarm');
  await mkdir(swarmDir, { recursive: true });
  await writeFile(join(swarmDir, 'members.json'), JSON.stringify({ title: 'Test Swarm', members }));
  await writeFile(
    join(swarmDir, 'board.jsonl'),
    posts.map(p => JSON.stringify(p) + '\n').join(''),
  );
  return swarmDir;
}

async function writeMemberTranscript(root, convId, rows) {
  const dir = join(root, 'brain', convId, '.system_generated/logs');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'transcript.jsonl'), lines(rows));
}

// Swarm Case 1: Active Swarm task worker holds turn after swarm{action:"add"}, streams wakeup read_board + final synthesis, and settles.
await scenario(async ({ root, bridge, emitted, append, begin }) => {
  await setupSwarm(root, {
    members: {
      impl: { conversation_id: workerConv, model: 'gemini-2.5-pro', role: 'worker', wake_mode: 'mentions', last_read_seq: 1 },
    },
    posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@impl Implement parser', time: new Date().toISOString() }],
  });
  await writeMemberTranscript(root, workerConv, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: '@impl Implement parser' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/parser.ts"' } }] },
  ]);

  await begin();
  await append([
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'Run swarm' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'swarm', args: { action: '"add"', name: '"impl"', brief: '"Implement parser"' } }],
    },
    { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Spawned worker impl' },
    message(3, 'SWARM_STARTED'),
  ]);
  await bridge.fromAgent({
    method: 'session/update',
    params: {
      sessionId: id,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'swarm-add-1',
        name: 'swarm',
        status: 'completed',
        rawInput: { action: 'add', name: 'impl', brief: 'Implement parser' },
      },
    },
  });
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'SWARM_STARTED' } } },
  });

  let settled = false;
  const done = bridge.fromAgent(response).then(r => {
    settled = true;
    return r;
  });
  await delay(30);
  assert.equal(settled, false, 'Must hold turn while Swarm task worker is working');

  // Worker finishes and posts @coordinator [done]
  await writeMemberTranscript(root, workerConv, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: '@impl Implement parser' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Done implementing' },
  ]);
  await appendFile(
    join(root, 'brain', id, '.system_generated/swarm/board.jsonl'),
    JSON.stringify({ seq: 2, agent: 'impl', channel: 'main', text: '@coordinator [done] Parser green', time: new Date().toISOString() }) + '\n',
  );
  await delay(20);
  assert.equal(settled, false, 'Must wait for coordinator wakeup turn after @coordinator post');

  // Coordinator wakes up, calls read_board, and emits synthesis
  await append([
    { step_index: 4, type: 'SYSTEM_MESSAGE', status: 'DONE', content: '<SYSTEM_MESSAGE>Board wakeup #2 from @impl</SYSTEM_MESSAGE>' },
    { step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_board', args: { since: '1' } }] },
    { step_index: 6, type: 'GENERIC', status: 'DONE', content: '#2 @impl: @coordinator [done] Parser green' },
    message(7, 'SWARM_SYNTHESIS_COMPLETE'),
  ]);

  const result = await done;
  assert.equal(result.result.stopReason, 'end_turn');
  assert.ok(emitted.some(e => e.params.update.sessionUpdate === 'tool_call' && e.params.update.name === 'read_board'));
  assert.ok(emitted.some(e => e.params.update.sessionUpdate === 'agent_message_chunk' && e.params.update.content.text === 'SWARM_SYNTHESIS_COMPLETE'));
  assert.deepEqual(result.result.usage, { inputTokens: 105, outputTokens: 13, cachedReadTokens: 32, totalTokens: 150 });
});

// Swarm Case 2: Observer roles (narrator, monitor) never hold end_turn open once task workers are waiting/killed.
await scenario(async ({ root, bridge, append, begin }) => {
  await setupSwarm(root, {
    members: {
      impl: { conversation_id: workerConv, role: 'worker', wake_mode: 'mentions', last_read_seq: 2 },
      narrator: { conversation_id: narratorConv, role: 'narrator', wake_mode: 'any', last_read_seq: 1 },
      'monitor-1': { conversation_id: monitorConv, role: 'worker', wake_mode: 'mentions', last_read_seq: 1 },
    },
    posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@impl Done check', time: '2026-01-01T00:00:00Z' }],
  });
  // Task worker is waiting, while narrator and monitor-1 are actively working
  await writeMemberTranscript(root, workerConv, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'task' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Finished' },
  ]);
  await writeMemberTranscript(root, narratorConv, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'narrate' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'write_file', args: { Path: '"/tmp/view.json"' } }] },
  ]);
  await writeMemberTranscript(root, monitorConv, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'monitor' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_board', args: {} }] },
  ]);

  await begin();
  await append([{ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'wrap up' }, message(1, 'ALL_DONE')]);
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ALL_DONE' } } },
  });
  const res = await bridge.fromAgent(response);
  assert.equal(res.result.stopReason, 'end_turn');
});

// Swarm Case 3: Coordinator parked on swarm_wait (DONE) holds turn while worker is active, then settles once worker finishes.
await scenario(async ({ root, bridge, append, begin }) => {
  await setupSwarm(root, {
    members: {
      impl: { conversation_id: workerConv, role: 'worker', wake_mode: 'mentions', last_read_seq: 1 },
    },
    posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@impl go', time: '2026-01-01T00:00:00Z' }],
  });
  await writeMemberTranscript(root, workerConv, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'go' },
  ]);

  await begin();
  await append([
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'wait on swarm' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', args: { since: '1' } }] },
    { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Parked waiting for mentions' },
  ]);
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'tool_call', toolCallId: 'sw-1', name: 'swarm_wait', status: 'completed', rawInput: { since: 1 } } },
  });

  let settled = false;
  const done = bridge.fromAgent(response).then(r => {
    settled = true;
    return r;
  });
  await delay(25);
  assert.equal(settled, false, 'Must stay open while task worker is active');

  await writeMemberTranscript(root, workerConv, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'go' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Completed silently' },
  ]);
  assert.equal((await done).result.stopReason, 'end_turn');
});

// Swarm Case 4: Non-Full access Swarm task worker blocked on run_command surfaces clear approval-stall error.
await scenario(async ({ root, bridge, append, begin }) => {
  bridge.approvalStallMs = 25;
  await setupSwarm(root, {
    members: {
      impl: { conversation_id: workerConv, role: 'worker', wake_mode: 'mentions', last_read_seq: 1 },
    },
    posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@impl build', time: '2026-01-01T00:00:00Z' }],
  });
  await writeMemberTranscript(root, workerConv, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'build' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"npm run build"' } }],
    },
  ]);

  await begin();
  await append([{ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'swarm build' }, message(1, 'SPAWNED')]);
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'SPAWNED' } } },
  });
  const res = await bridge.fromAgent(response);
  assert.match(res.error.message, /Swarm worker has not returned progress or an ACP approval request/);
});

// Regression 1: Prefer untruncated transcript_full.jsonl over truncated transcript.jsonl for long commands and >2KB replies.
await scenario(async ({ root, bridge, emitted, begin }) => {
  const longCmd = 'python3 -c "' + 'x'.repeat(2400) + '"';
  const longReply = 'FULL_REPLY_START_' + 'Y'.repeat(4052) + '_FULL_REPLY_END';
  const compactPath = join(root, 'brain', id, '.system_generated/logs/transcript.jsonl');
  const fullPath = join(root, 'brain', id, '.system_generated/logs/transcript_full.jsonl');

  await writeFile(compactPath, '');
  await writeFile(fullPath, '');
  await begin();

  await appendFile(
    compactPath,
    lines([
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'long check' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        truncated_fields: ['tool_calls'],
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"python3 -c \\"' + 'x'.repeat(1800) + '\n<truncated 1987 bytes>', WaitMsBeforeAsync: '1' } }],
      },
      launch(2, 'task-2'),
    ]),
  );
  await appendFile(
    fullPath,
    lines([
      { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'long check' },
      tool(1, longCmd),
      launch(2, 'task-2'),
    ]),
  );

  await bridge.fromAgent({
    method: 'session/update',
    params: {
      sessionId: id,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-trunc-1',
        name: 'run_command',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: longCmd, WaitMsBeforeAsync: 1 },
      },
    },
  });

  const done = bridge.fromAgent(response);
  await appendFile(
    compactPath,
    lines([
      finished(3, 'task-2'),
      { step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', truncated_fields: ['content'], content: longReply.slice(0, 2982) },
    ]),
  );
  await appendFile(fullPath, lines([finished(3, 'task-2'), message(4, longReply)]));

  const res = await done;
  assert.equal(res.result.stopReason, 'end_turn');
  const toolUpdates = emitted.filter(e => e.params?.update?.sessionUpdate === 'tool_call_update');
  assert.equal(toolUpdates.length, 1);
  assert.equal(toolUpdates[0].params.update.toolCallId, 'call-trunc-1');
  assert.equal(toolUpdates[0].params.update.status, 'completed');
  assert.equal(
    emitted.filter(e => e.params?.update?.sessionUpdate === 'tool_call').length,
    0,
    'Must match original call-trunc-1 rather than emitting synthetic agy:... duplicate',
  );
  const msgUpdates = emitted.filter(e => e.params?.update?.sessionUpdate === 'agent_message_chunk');
  assert.equal(msgUpdates.length, 1);
  assert.equal(msgUpdates[0].params.update.content.text, longReply);
  assert.ok(msgUpdates[0].params.update.content.text.endsWith('_FULL_REPLY_END'));
});

// Regression 2: Foreground backgrounded tool finished before foreground final reply must close BEFORE final message (no spanning checkpoint).
await scenario(async ({ bridge, emitted, append, begin, observe }) => {
  await begin();
  await append([
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'fg bg check' },
    tool(1, command),
    launch(2, 'task-2'),
    { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Refreshing status' },
    finished(4, 'task-2'),
    message(5, 'FG_FINAL_CONCLUSION'),
  ]);

  const callMsg = await bridge.fromAgent({
    method: 'session/update',
    params: {
      sessionId: id,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-fg-bg',
        title: command,
        name: 'run_command',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: command, WaitMsBeforeAsync: 1 },
      },
    },
  });
  assert.ok(callMsg);

  const emittedBeforeInterim = emitted.length;
  const interim = await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Refreshing status' } } },
  });
  assert.ok(interim);

  const finalChunk = await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FG_FINAL_CONCLUSION' } } },
  });
  assert.ok(finalChunk);

  const closeEvents = emitted.slice(emittedBeforeInterim).filter(e => e.params?.update?.toolCallId === 'call-fg-bg');
  assert.equal(closeEvents.length, 1, 'call-fg-bg must close BEFORE final foreground reply is returned to ACP');
  assert.equal(closeEvents[0].params.update.status, 'completed');

  const countAtPromptEnd = emitted.length;
  const res = await bridge.fromAgent(response);
  assert.equal(res.result.stopReason, 'end_turn');
  assert.equal(emitted.length, countAtPromptEnd, 'Must not emit any updates after foreground final reply');

  // Re-sending stale update for already-closed foreground tool on Turn 2 must be suppressed.
  await begin();
  const staleClose = await bridge.fromAgent({
    method: 'session/update',
    params: {
      sessionId: id,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-fg-bg', title: command, status: 'completed' },
    },
  });
  assert.equal(staleClose, null, 'Already-closed foreground tool update must be suppressed');
  assert.equal((await bridge.fromAgent({ ...response, id: 2 })).result.stopReason, 'end_turn');
});

// Regression 3: Turn 2 delayed flush from agy acp of Turn 1 post-foreground thought/tool/message is deduplicated, while Turn 2 real updates pass.
await scenario(async ({ bridge, emitted, append, begin, observe }) => {
  await begin();
  await append([
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'turn 1' },
    tool(1, command),
    launch(2, 'task-2'),
    { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'STARTED' },
  ]);
  await observe('call-turn1-bg', command);
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STARTED' } } },
  });

  const done1 = bridge.fromAgent(response);
  await append([
    finished(4, 'task-2'),
    {
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      thinking: 'Inspecting log details now',
      tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/report.txt"' } }],
    },
    { step_index: 6, type: 'GENERIC', status: 'DONE', content: 'REPORT_BODY' },
    { step_index: 7, type: 'PLANNER_RESPONSE', status: 'DONE', thinking: 'Ready to answer', content: 'TURN1_FINAL_ANSWER' },
  ]);
  const res1 = await done1;
  assert.equal(res1.result.stopReason, 'end_turn');
  assert.ok(emitted.some(e => e.params.update.sessionUpdate === 'agent_thought_chunk' && e.params.update.content.text === 'Inspecting log details now'));
  assert.ok(emitted.some(e => e.params.update.sessionUpdate === 'agent_message_chunk' && e.params.update.content.text === 'TURN1_FINAL_ANSWER'));

  // Begin Turn 2
  const req2 = {
    jsonrpc: '2.0',
    id: 2,
    method: 'session/prompt',
    params: { sessionId: id, prompt: [{ type: 'text', text: 'turn 2' }] },
  };
  await bridge.fromClient(req2);

  // Simulate agy acp flushing Turn 1's buffered steps before answering Turn 2
  const delayed = [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspecting ' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'log details now' } },
    { sessionUpdate: 'tool_call', toolCallId: 'replayed-read-1', name: 'read_file', kind: 'read', status: 'in_progress', rawInput: { Path: '/tmp/report.txt' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'replayed-read-1', status: 'completed', rawOutput: { output: 'REPORT_BODY' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Ready to answer' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'TURN1_FINAL_' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ANSWER' } },
  ];
  for (const update of delayed) {
    const out = await bridge.fromAgent({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: id, update } });
    assert.equal(out, null, `Stale Turn 1 replay update must be suppressed: ${update.sessionUpdate}`);
  }

  // Turn 2's real output passes through untouched
  const t2Msg = await bridge.fromAgent({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'TURN2_REAL_REPLY' } } },
  });
  assert.equal(t2Msg?.params?.update?.content?.text, 'TURN2_REAL_REPLY');
  await append([
    { step_index: 8, type: 'USER_INPUT', status: 'DONE', content: 'turn 2' },
    { step_index: 9, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'TURN2_REAL_REPLY' },
  ]);
  const res2 = await bridge.fromAgent({ ...response, id: 2 });
  assert.equal(res2.result.stopReason, 'end_turn');
});

// Regression 4: Partial-prefix match that diverges mid-stream must flush buffered prefix losslessly before forwarding the new update.
await scenario(async ({ bridge, emitted, append, begin, observe }) => {
  await begin();
  await append([
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'prefix check' },
    tool(1, command),
    launch(2, 'task-2'),
    { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'WAIT' },
  ]);
  await observe('call-prefix', command);
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WAIT' } } },
  });
  const done1 = bridge.fromAgent(response);
  await append([finished(4, 'task-2'), message(5, '整体表现完全符合预期：A')]);
  assert.equal((await done1).result.stopReason, 'end_turn');

  await bridge.fromClient({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/prompt',
    params: { sessionId: id, prompt: [{ type: 'text', text: 'turn 2' }] },
  });

  const beforeDivergence = emitted.length;
  const held = await bridge.fromAgent({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '整体表现' } } },
  });
  assert.equal(held, null, 'Matching prefix chunk is buffered provisionally');
  assert.equal(emitted.length, beforeDivergence);

  const diverged = await bridge.fromAgent({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '出现新波动：B' } } },
  });
  assert.equal(diverged?.params?.update?.content?.text, '出现新波动：B');
  const recovered = emitted.slice(beforeDivergence).filter(e => e.params?.update?.sessionUpdate === 'agent_message_chunk');
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].params.update.content.text, '整体表现', 'Buffered prefix must be emitted before diverging chunk');
  await append([
    { step_index: 6, type: 'USER_INPUT', status: 'DONE', content: 'turn 2' },
    message(7, '整体表现出现新波动：B'),
  ]);
  assert.equal((await bridge.fromAgent({ ...response, id: 2 })).result.stopReason, 'end_turn');
});

// Regression 5: session/load clears staleReplay and suppressedToolIds so history replay is never suppressed.
await scenario(async ({ bridge, append, begin, observe }) => {
  await begin();
  await append([
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'turn 1' },
    tool(1, command),
    launch(2, 'task-2'),
    { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'WAIT' },
  ]);
  await observe('call-load-check', command);
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WAIT' } } },
  });
  const done1 = bridge.fromAgent(response);
  await append([finished(4, 'task-2'), message(5, 'HIST_MSG_1')]);
  assert.equal((await done1).result.stopReason, 'end_turn');

  await bridge.fromClient({ jsonrpc: '2.0', id: 9, method: 'session/load', params: { sessionId: id, cwd: '/tmp' } });
  const histUpdate = await bridge.fromAgent({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'HIST_MSG_1' } } },
  });
  assert.equal(histUpdate?.params?.update?.content?.text, 'HIST_MSG_1', 'session/load must reset stale replay filter');
});

// Regression 6: session/load barrier holds LOAD_RES until late replay updates go quiescent.
await scenario(async ({ bridge, emitted }) => {
  bridge.loadSettleMs = 35;
  bridge.loadMetaFlushDelayMs = 5;
  bridge.loadMaxWaitMs = 400;

  await bridge.fromClient({ jsonrpc: '2.0', id: 101, method: 'session/load', params: { sessionId: id, cwd: '/tmp' } });
  const loadRes = { jsonrpc: '2.0', id: 101, result: { sessionId: id, modes: null, configOptions: [] } };
  const held = await bridge.fromAgent(loadRes);
  assert.equal(held, null, 'session/load response must be held until replay quiesces');
  assert.equal(emitted.length, 0);

  const replayUpdates = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'late user' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'late thought' } },
    { sessionUpdate: 'tool_call', toolCallId: 'late-tool-1', name: 'read_file', kind: 'read', status: 'completed' },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late reply' } },
  ];
  for (const update of replayUpdates) {
    await delay(12);
    const forwarded = await bridge.fromAgent({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: id, update } });
    assert.ok(forwarded, `Late replay ${update.sessionUpdate} must pass through immediately before LOAD_RES`);
    assert.equal(emitted.length, 0, 'LOAD_RES must remain held while replay chunks are arriving');
  }

  await delay(60);
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], loadRes);
});

// Regression 7: Interleaved metadata resets settle timer, keeps subsequent replay chunks before LOAD_RES, and coalesces metadata after LOAD_RES.
await scenario(async ({ bridge, emitted }) => {
  bridge.loadSettleMs = 35;
  bridge.loadMetaFlushDelayMs = 10;
  bridge.loadMaxWaitMs = 500;

  await bridge.fromClient({ jsonrpc: '2.0', id: 102, method: 'session/load', params: { sessionId: id, cwd: '/tmp' } });
  const loadRes = { jsonrpc: '2.0', id: 102, result: { sessionId: id, modes: null, configOptions: [] } };
  assert.equal(await bridge.fromAgent(loadRes), null);

  await delay(20);
  const cmdMsg = {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'plan', description: 'Plan' }] } },
  };
  const usage1 = {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'usage_update', used: 100, size: 1000 } },
  };
  const infoMsg = {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'session_info_update', title: 'Restored' } },
  };
  assert.equal(await bridge.fromAgent(cmdMsg), null);
  assert.equal(await bridge.fromAgent(usage1), null);
  assert.equal(await bridge.fromAgent(infoMsg), null);

  await delay(20);
  assert.equal(emitted.length, 0, 'Metadata updates must reset settle timer and keep LOAD_RES held');

  const afterMetaTool = await bridge.fromAgent({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'tool_call', toolCallId: 'after-meta-tool', name: 'read_file', kind: 'read', status: 'completed' } },
  });
  const afterMetaMsg = await bridge.fromAgent({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still part of replay' } } },
  });
  assert.ok(afterMetaTool, 'Tool call after available_commands_update must still arrive before LOAD_RES');
  assert.ok(afterMetaMsg, 'Assistant message after available_commands_update must still arrive before LOAD_RES');

  const usage2 = {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'usage_update', used: 500, size: 1000 } },
  };
  assert.equal(await bridge.fromAgent(usage2), null);
  assert.equal(emitted.length, 0);

  await delay(45);
  assert.equal(emitted.length, 1, 'LOAD_RES emits once quiet, before deferred metadata delay elapses');
  assert.deepEqual(emitted[0], loadRes);

  await delay(25);
  assert.equal(emitted.length, 4, 'Coalesced deferred metadata flushes after loadMetaFlushDelayMs');
  assert.deepEqual(
    emitted.slice(1).map(m => m.params.update.sessionUpdate),
    ['available_commands_update', 'session_info_update', 'usage_update'],
  );
  assert.equal(emitted[3].params.update.used, 500, 'Latest usage_update snapshot wins');
});

// Regression 8: current_mode_update and config_option_update are never deferred past LOAD_RES so they cannot race applyInitialConfig.
await scenario(async ({ bridge, emitted }) => {
  bridge.loadSettleMs = 30;
  bridge.loadMetaFlushDelayMs = 5;
  bridge.loadMaxWaitMs = 300;

  await bridge.fromClient({ jsonrpc: '2.0', id: 103, method: 'session/load', params: { sessionId: id, cwd: '/tmp' } });
  assert.equal(await bridge.fromAgent({ jsonrpc: '2.0', id: 103, result: { sessionId: id } }), null);

  await delay(15);
  const modeOut = await bridge.fromAgent({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' } },
  });
  const cfgOut = await bridge.fromAgent({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'config_option_update', configOptions: [] } },
  });
  assert.equal(modeOut?.params?.update?.sessionUpdate, 'current_mode_update');
  assert.equal(cfgOut?.params?.update?.sessionUpdate, 'config_option_update');
  assert.equal(emitted.length, 0, 'Mode/config updates pass immediately while LOAD_RES stays held');

  await delay(50);
  assert.equal(emitted.length, 1, 'LOAD_RES releases cleanly with zero extra deferred metadata');
  assert.equal(emitted[0].id, 103);
});

// Regression 9: Error session/load responses bypass the barrier immediately.
await scenario(async ({ bridge, emitted }) => {
  bridge.loadSettleMs = 500;
  await bridge.fromClient({ jsonrpc: '2.0', id: 104, method: 'session/load', params: { sessionId: id, cwd: '/tmp' } });
  const errRes = { jsonrpc: '2.0', id: 104, error: { code: -32001, message: 'Session not found' } };
  const out = await bridge.fromAgent(errRes);
  assert.deepEqual(out, errRes);
  assert.equal(emitted.length, 0);
});

// Regression 10: Continuous replay updates without a long gap are bounded by loadMaxWaitMs.
await scenario(async ({ bridge, emitted }) => {
  bridge.loadSettleMs = 45;
  bridge.loadMaxWaitMs = 95;
  bridge.loadMetaFlushDelayMs = 5;

  await bridge.fromClient({ jsonrpc: '2.0', id: 105, method: 'session/load', params: { sessionId: id, cwd: '/tmp' } });
  assert.equal(await bridge.fromAgent({ jsonrpc: '2.0', id: 105, result: { sessionId: id } }), null);

  let releasedAt = null;
  for (let i = 0; i < 12; i++) {
    await delay(15);
    await bridge.fromAgent({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: id, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `chunk-${i}` } } },
    });
    if (releasedAt === null && emitted.some(m => m.id === 105)) {
      releasedAt = i;
    }
  }
  assert.notEqual(releasedAt, null, 'loadMaxWaitMs must release LOAD_RES even if updates arrive continuously');
  assert.ok(releasedAt < 11, `Expected release near loadMaxWaitMs (~6 ticks), got tick ${releasedAt}`);
});

// Regression 11: session/close and bridge.close cancel pending load and deferred metadata timers cleanly.
await scenario(async ({ bridge, emitted }) => {
  bridge.loadSettleMs = 25;
  bridge.loadMetaFlushDelayMs = 10;
  bridge.loadMaxWaitMs = 200;

  await bridge.fromClient({ jsonrpc: '2.0', id: 106, method: 'session/load', params: { sessionId: id, cwd: '/tmp' } });
  assert.equal(await bridge.fromAgent({ jsonrpc: '2.0', id: 106, result: { sessionId: id } }), null);
  assert.equal(
    await bridge.fromAgent({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: id, update: { sessionUpdate: 'usage_update', used: 10, size: 100 } },
    }),
    null,
  );
  await bridge.fromClient({ jsonrpc: '2.0', id: 107, method: 'session/close', params: { sessionId: id } });
  await delay(60);
  assert.equal(emitted.length, 0, 'session/close must cancel held LOAD_RES and deferred metadata');

  await bridge.fromClient({ jsonrpc: '2.0', id: 108, method: 'session/load', params: { sessionId: id, cwd: '/tmp' } });
  assert.equal(await bridge.fromAgent({ jsonrpc: '2.0', id: 108, result: { sessionId: id } }), null);
  bridge.close();
  await delay(60);
  assert.equal(emitted.length, 0, 'bridge.close() must cancel held LOAD_RES');
});

// Swarm Case 5: Exact production repro (nativeFull: true, pre-existing 2h-stale worker mid-write_file/run_command) releases unrelated end_turn immediately.
await scenario(async ({ root, bridge, emitted, append, begin }) => {
  bridge.nativeFull = true;
  bridge.timeoutMs = 1000;
  const twoHoursAgoMs = Date.now() - 2 * 60 * 60 * 1000;
  const twoHoursAgoIso = new Date(twoHoursAgoMs).toISOString();
  const swarmDir = await setupSwarm(root, {
    members: {
      'stg-ops': {
        conversation_id: workerConv,
        role: 'worker',
        phase: 'RUNNING',
        wake_mode: 'working',
        last_read_seq: 1,
        killed: false,
      },
    },
    posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@stg-ops verify stg', time: twoHoursAgoIso }],
  });
  await utimes(join(swarmDir, 'members.json'), new Date(twoHoursAgoMs), new Date(twoHoursAgoMs));
  await writeMemberTranscript(root, workerConv, [
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
  const workerTranscriptPath = join(root, 'brain', workerConv, '.system_generated/logs/transcript.jsonl');
  await utimes(workerTranscriptPath, new Date(twoHoursAgoMs), new Date(twoHoursAgoMs));

  await begin();
  await append([
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'Can we start testing now?' },
    message(1, 'QUICK_REPLY'),
  ]);
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'QUICK_REPLY' } } },
  });
  const res = await bridge.fromAgent(response);
  assert.equal(res.result.stopReason, 'end_turn');
  assert.equal(emitted.length, 0);
});

// Swarm Case 6: Same 2h-stale worker repro in default mode (nativeFull: false) releases cleanly without false ACP approval error.
await scenario(async ({ root, bridge, emitted, append, begin }) => {
  bridge.nativeFull = false;
  bridge.approvalStallMs = 20;
  const twoHoursAgoMs = Date.now() - 2 * 60 * 60 * 1000;
  const twoHoursAgoIso = new Date(twoHoursAgoMs).toISOString();
  await setupSwarm(root, {
    members: {
      'stg-ops': {
        conversation_id: workerConv,
        role: 'worker',
        phase: 'RUNNING',
        wake_mode: 'working',
        last_read_seq: 1,
        killed: false,
      },
    },
    posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@stg-ops verify stg', time: twoHoursAgoIso }],
  });
  await writeMemberTranscript(root, workerConv, [
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

  await begin();
  await append([
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'unrelated question' },
    message(1, 'NO_FALSE_APPROVAL_ERROR'),
  ]);
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'NO_FALSE_APPROVAL_ERROR' } } },
  });
  const res = await bridge.fromAgent(response);
  assert.equal(res.result.stopReason, 'end_turn');
  assert.equal(emitted.length, 0);
});

// Swarm Case 7: Coordinator invoking swarm{action:"status"} (seenSwarm: true) still releases immediately when the only working worker is 2h stale.
await scenario(async ({ root, bridge, append, begin }) => {
  bridge.nativeFull = true;
  bridge.timeoutMs = 1000;
  const twoHoursAgoIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await setupSwarm(root, {
    members: {
      'stg-ops': {
        conversation_id: workerConv,
        role: 'worker',
        phase: 'RUNNING',
        wake_mode: 'working',
        last_read_seq: 1,
        killed: false,
      },
    },
    posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@stg-ops verify', time: twoHoursAgoIso }],
  });
  await writeMemberTranscript(root, workerConv, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: twoHoursAgoIso, content: 'verify' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: twoHoursAgoIso,
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"python3 probe.py"' } }],
    },
  ]);

  await begin();
  await append([
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'check swarm status' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'swarm', args: { action: '"status"' } }],
    },
    { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'stg-ops: working' },
    message(3, 'STATUS_CHECKED'),
  ]);
  await bridge.fromAgent({
    method: 'session/update',
    params: {
      sessionId: id,
      update: { sessionUpdate: 'tool_call', toolCallId: 'sw-status-1', name: 'swarm', status: 'completed', rawInput: { action: 'status' } },
    },
  });
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STATUS_CHECKED' } } },
  });
  const res = await bridge.fromAgent(response);
  assert.equal(res.result.stopReason, 'end_turn');
});

// Swarm Case 8: Pre-existing unchanged worker aged between preExistingSwarmWorkerStaleMs (2m) and swarmWorkerStaleMs (10m)
// releases unrelated turns immediately, whereas if it progresses during the turn it holds until settled.
await scenario(async ({ root, bridge, append, begin }) => {
  bridge.nativeFull = true;
  bridge.timeoutMs = 1000;
  const threeMinAgoMs = Date.now() - 3 * 60 * 1000;
  const threeMinAgoIso = new Date(threeMinAgoMs).toISOString();
  await setupSwarm(root, {
    members: {
      impl: {
        conversation_id: workerConv,
        role: 'worker',
        phase: 'RUNNING',
        wake_mode: 'mentions',
        last_read_seq: 1,
        killed: false,
      },
    },
    posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@impl work', time: threeMinAgoIso }],
  });
  await writeMemberTranscript(root, workerConv, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: threeMinAgoIso, content: 'work' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: threeMinAgoIso,
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 10"' } }],
    },
  ]);

  await begin();
  await append([
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'unrelated question' },
    message(1, 'UNRELATED_OK'),
  ]);
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'UNRELATED_OK' } } },
  });
  assert.equal((await bridge.fromAgent(response)).result.stopReason, 'end_turn');
});

await scenario(async ({ root, bridge, append, begin }) => {
  bridge.nativeFull = true;
  bridge.timeoutMs = 1000;
  const threeMinAgoMs = Date.now() - 3 * 60 * 1000;
  const threeMinAgoIso = new Date(threeMinAgoMs).toISOString();
  await setupSwarm(root, {
    members: {
      impl: {
        conversation_id: workerConv,
        role: 'worker',
        phase: 'RUNNING',
        wake_mode: 'mentions',
        last_read_seq: 1,
        killed: false,
      },
    },
    posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@impl work', time: threeMinAgoIso }],
  });
  const initialRows = [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: threeMinAgoIso, content: 'work' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: threeMinAgoIso,
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 10"' } }],
    },
  ];
  await writeMemberTranscript(root, workerConv, initialRows);

  await begin();
  // Worker emits new progress during this turn -> signature & progressKey change -> must hold until settled!
  await writeMemberTranscript(root, workerConv, [
    ...initialRows,
    { step_index: 2, type: 'GENERIC', status: 'DONE', created_at: new Date().toISOString(), content: 'step finished' },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date().toISOString(),
      tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/next"' } }],
    },
  ]);
  await append([
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'unrelated question' },
    message(1, 'QUICK_MSG'),
  ]);
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'QUICK_MSG' } } },
  });
  let settled = false;
  const done = bridge.fromAgent(response).then(r => {
    settled = true;
    return r;
  });
  await delay(25);
  assert.equal(settled, false, 'Must hold turn once pre-existing worker resumes making progress');

  await writeMemberTranscript(root, workerConv, [
    ...initialRows,
    { step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date().toISOString(), content: 'Worker done' },
  ]);
  assert.equal((await done).result.stopReason, 'end_turn');
});

// Swarm Case 9: Active Swarm worker stalling mid-turn in full-access mode stays held initially and releases after swarmWorkerStaleMs + settleMs.
await scenario(async ({ root, bridge, append, begin }) => {
  bridge.nativeFull = true;
  bridge.swarmWorkerStaleMs = 50;
  bridge.timeoutMs = 2000;
  bridge.settleMs = 10;

  await begin();
  await setupSwarm(root, {
    members: {
      impl: { conversation_id: workerConv, role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', last_read_seq: 1, killed: false },
    },
    posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@impl start', time: '2026-01-01T00:00:00.000Z' }],
  });
  await writeMemberTranscript(root, workerConv, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: new Date().toISOString(), content: 'start' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date().toISOString(),
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"hang-forever"' } }],
    },
  ]);

  await append([
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'run swarm' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm', args: { action: '"add"', name: '"impl"' } }] },
    { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Spawned' },
    message(3, 'STARTED'),
  ]);
  await bridge.fromAgent({
    method: 'session/update',
    params: {
      sessionId: id,
      update: { sessionUpdate: 'tool_call', toolCallId: 'sw-stall-1', name: 'swarm', status: 'completed', rawInput: { action: 'add', name: 'impl' } },
    },
  });
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STARTED' } } },
  });

  let settled = false;
  const done = bridge.fromAgent(response).then(r => {
    settled = true;
    return r;
  });
  await delay(20);
  assert.equal(settled, false, 'Must remain held before swarmWorkerStaleMs elapses');
  const res = await done;
  assert.equal(res.result.stopReason, 'end_turn');
});

// Swarm Case 10: Active Swarm worker advancing every 25ms past swarmWorkerStaleMs (80ms) stays held until finished.
await scenario(async ({ root, bridge, emitted, append, begin }) => {
  bridge.nativeFull = true;
  bridge.swarmWorkerStaleMs = 80;
  bridge.timeoutMs = 2000;
  bridge.settleMs = 10;

  await begin();
  await setupSwarm(root, {
    members: {
      impl: { conversation_id: workerConv, role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', last_read_seq: 1, killed: false },
    },
    posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@impl build', time: '2026-01-01T00:00:00.000Z' }],
  });
  const rows = [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: new Date().toISOString(), content: 'build' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date().toISOString(),
      tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/0"' } }],
    },
  ];
  await writeMemberTranscript(root, workerConv, rows);

  await append([
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'run long active swarm' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm', args: { action: '"add"', name: '"impl"' } }] },
    { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Spawned' },
    message(3, 'STARTED'),
  ]);
  await bridge.fromAgent({
    method: 'session/update',
    params: {
      sessionId: id,
      update: { sessionUpdate: 'tool_call', toolCallId: 'sw-active-1', name: 'swarm', status: 'completed', rawInput: { action: 'add', name: 'impl' } },
    },
  });
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STARTED' } } },
  });

  let settled = false;
  const done = bridge.fromAgent(response).then(r => {
    settled = true;
    return r;
  });

  for (let i = 1; i <= 4; i++) {
    await delay(25);
    assert.equal(settled, false, `Must stay held while worker advances (tick ${i})`);
    rows.push(
      { step_index: i * 2, type: 'GENERIC', status: 'DONE', created_at: new Date().toISOString(), content: `ok-${i}` },
      {
        step_index: i * 2 + 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date().toISOString(),
        tool_calls: [{ name: 'read_file', args: { Path: `"/tmp/${i}"` } }],
      },
    );
    await writeMemberTranscript(root, workerConv, rows);
  }
  assert.equal(settled, false, 'Still held past swarmWorkerStaleMs because progressKey kept advancing');

  rows.push(
    { step_index: 10, type: 'GENERIC', status: 'DONE', created_at: new Date().toISOString(), content: 'ok-final' },
    { step_index: 11, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date().toISOString(), content: 'Worker complete' },
  );
  await writeMemberTranscript(root, workerConv, rows);
  await appendFile(
    join(root, 'brain', id, '.system_generated/swarm/board.jsonl'),
    JSON.stringify({ seq: 2, agent: 'impl', channel: 'main', text: '@coordinator [done] Complete', time: new Date().toISOString() }) + '\n',
  );
  await append([
    { step_index: 4, type: 'SYSTEM_MESSAGE', status: 'DONE', content: '<SYSTEM_MESSAGE>Board wakeup #2 from @impl</SYSTEM_MESSAGE>' },
    message(5, 'ACTIVE_PROGRESS_SYNTHESIS'),
  ]);

  const res = await done;
  assert.equal(res.result.stopReason, 'end_turn');
  assert.ok(
    emitted.some(e => e.params?.update?.sessionUpdate === 'agent_message_chunk' && e.params.update.content?.text === 'ACTIVE_PROGRESS_SYNTHESIS'),
  );
});

// Swarm Case 11: Exact production repro where verifier is on swarm_wait AND all task workers are waiting on
// long-running background run_command tasks (zero-tool PLANNER_RESPONSE DONE) whose task log streams progress.
await scenario(async ({ root, bridge, emitted, append, begin }) => {
  const workerConv2 = 'ffffffff-1111-2222-3333-444444444444';
  bridge.nativeFull = true;
  bridge.swarmWorkerStaleMs = 70;
  bridge.settleMs = 10;
  bridge.timeoutMs = 3000;

  await setupSwarm(root, {
    members: {
      'core-slim': { conversation_id: workerConv, role: 'worker', phase: 'RUNNING', wake_mode: 'working', last_read_seq: 1, killed: false },
      'mw-e2e-slim': { conversation_id: workerConv2, role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', last_read_seq: 1, killed: false },
      verifier: { conversation_id: subA, role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', last_read_seq: 1, killed: false },
      monitor: { conversation_id: monitorConv, role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', last_read_seq: 1, killed: false },
    },
    posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@core-slim @mw-e2e-slim resume', time: '2026-01-01T00:00:00.000Z' }],
  });

  await writeMemberTranscript(root, subA, [
    { step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'standby' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', args: { since: '1' } }] },
    { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Waiting' },
  ]);
  await writeMemberTranscript(root, monitorConv, [
    { step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'monitor' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_board', args: {} }] },
  ]);

  const coreRows = [
    { step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'resume' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"go test -race ./pkg/prefixroute"' } }] },
    { step_index: 2, type: 'GENERIC', status: 'RUNNING', content: `Tool is running as a background task with task id: ${workerConv}/task-1` },
    { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Running pkg/prefixroute -race in background; waiting.' },
  ];
  const mwRows = [
    { step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'resume' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"go test -race ./client/middleware/..."' } }] },
    { step_index: 2, type: 'GENERIC', status: 'RUNNING', content: `Tool is running as a background task with task id: ${workerConv2}/task-1` },
    { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Running client/middleware -race in background; waiting.' },
  ];
  await writeMemberTranscript(root, workerConv, coreRows);
  await writeMemberTranscript(root, workerConv2, mwRows);
  const mwTaskDir = join(root, 'brain', workerConv2, '.system_generated/tasks');
  await mkdir(mwTaskDir, { recursive: true });
  const mwTaskLog = join(mwTaskDir, 'task-1.log');
  await writeFile(mwTaskLog, '=== RUN TestInit\n');

  await begin();
  await append([
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'resume swarm' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'swarm_wait', args: { since: '1' } }],
    },
    { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Waiting for board post' },
  ]);
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'tool_call', toolCallId: 'sw-bg-1', name: 'swarm_wait', status: 'completed', rawInput: { since: 1 } } },
  });

  let settled = false;
  const done = bridge.fromAgent(response).then(r => {
    settled = true;
    return r;
  });

  // Even after settleMs (10ms) and past swarmWorkerStaleMs (70ms), streaming task-1.log keeps the turn open!
  for (let i = 1; i <= 4; i++) {
    await delay(25);
    assert.equal(settled, false, `Must hold end_turn while worker streams background task log (tick ${i})`);
    await appendFile(mwTaskLog, `PASS pkg/subpkg-${i}\n`);
  }

  // Both workers finish their background tasks and report @coordinator [done]
  coreRows.push(
    { step_index: 4, type: 'SYSTEM_MESSAGE', status: 'DONE', content: `<SYSTEM_MESSAGE>\ncontent=Task id "${workerConv}/task-1" finished with result:\nOK\n</SYSTEM_MESSAGE>` },
    { step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Core checks done.' },
  );
  mwRows.push(
    { step_index: 4, type: 'SYSTEM_MESSAGE', status: 'DONE', content: `<SYSTEM_MESSAGE>\ncontent=Task id "${workerConv2}/task-1" finished with result:\nOK\n</SYSTEM_MESSAGE>` },
    { step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'MW checks done.' },
  );
  await writeMemberTranscript(root, workerConv, coreRows);
  await writeMemberTranscript(root, workerConv2, mwRows);
  await appendFile(
    join(root, 'brain', id, '.system_generated/swarm/board.jsonl'),
    JSON.stringify({ seq: 2, agent: 'mw-e2e-slim', channel: 'main', text: '@coordinator [done] All verified', time: new Date().toISOString() }) + '\n',
  );
  await append([
    { step_index: 3, type: 'SYSTEM_MESSAGE', status: 'DONE', content: '<SYSTEM_MESSAGE>Board wakeup #2</SYSTEM_MESSAGE>' },
    message(4, 'SWARM_BG_TASKS_SYNTHESIZED'),
  ]);

  const res = await done;
  assert.equal(res.result.stopReason, 'end_turn');
  assert.ok(
    emitted.some(e => e.params?.update?.sessionUpdate === 'agent_message_chunk' && e.params.update.content?.text === 'SWARM_BG_TASKS_SYNTHESIZED'),
  );
});

// Swarm Case 12: Live swarm_progress card lifecycle, throttling, structural updates, and clean settlement,
// while non-Swarm background commands emit zero swarm_progress cards.
await scenario(async ({ bridge, emitted, append, begin, foreground }) => {
  await begin();
  await foreground();
  const done = bridge.fromAgent(response);
  await append([finished(), message(5, 'NO_SWARM_DONE')]);
  assert.equal((await done).result.stopReason, 'end_turn');
  assert.equal(
    emitted.filter(e => e.params?.update?.name === 'swarm_progress').length,
    0,
    'Plain background run_command without Swarm must not emit swarm_progress',
  );
});

await scenario(async ({ root, bridge, emitted, append, begin }) => {
  bridge.nativeFull = true;
  bridge.pollMs = 10;
  bridge.settleMs = 15;
  bridge.swarmProgressThrottleMs = 60;
  bridge.timeoutMs = 3000;

  const waitingConv = 'ffffffff-aaaa-bbbb-cccc-111111111111';
  await setupSwarm(root, {
    members: {
      impl: { conversation_id: workerConv, role: 'worker', phase: 'RUNNING', wake_mode: 'working', last_read_seq: 1, killed: false },
      reviewer: { conversation_id: waitingConv, role: 'worker', phase: 'WAITING', wake_mode: 'mentions', last_read_seq: 1, killed: false },
    },
    posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@impl implement parser', time: new Date().toISOString() }],
  });
  const implRows = [
    { step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'start' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"go test ./..."' } }] },
    { step_index: 2, type: 'GENERIC', status: 'RUNNING', content: `Tool is running as a background task with task id: ${workerConv}/task-1` },
    { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Testing.' },
  ];
  await writeMemberTranscript(root, workerConv, implRows);
  await writeMemberTranscript(root, waitingConv, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'standby' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Standing by.' },
  ]);
  const taskDir = join(root, 'brain', workerConv, '.system_generated/tasks');
  await mkdir(taskDir, { recursive: true });
  const taskLog = join(taskDir, 'task-1.log');
  await writeFile(taskLog, 'start\n');

  await begin();
  await append([
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'run swarm' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', args: { since: '1' } }] },
    { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Waiting' },
  ]);
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'tool_call', toolCallId: 'sw-card-wait', name: 'swarm_wait', status: 'completed', rawInput: { since: 1 } } },
  });

  const done = bridge.fromAgent(response);
  await delay(25);
  const progressCalls = () =>
    emitted.filter(
      e => e.params?.update?.toolCallId?.includes(':swarm-progress:') && e.params.update.sessionUpdate === 'tool_call',
    );
  assert.equal(progressCalls().length, 1, 'Expected one swarm_progress tool_call');
  const progressId = progressCalls()[0].params.update.toolCallId;
  assert.equal(progressCalls()[0].params.update.status, 'in_progress');
  assert.match(progressCalls()[0].params.update.rawInput.label, /1 active · 1 waiting · #1/);

  // Immediate large byte append before throttleMs must wait until throttle window elapses
  await appendFile(taskLog, 'a'.repeat(2048));
  await delay(15);
  const updatesBeforeThrottle = emitted.filter(
    e => e.params?.update?.toolCallId === progressId && e.params.update.sessionUpdate === 'tool_call_update',
  );
  assert.equal(updatesBeforeThrottle.length, 0, 'Byte-only update within throttle window should be throttled');

  await delay(65);
  const updatesAfterThrottle = emitted.filter(
    e => e.params?.update?.toolCallId === progressId && e.params.update.sessionUpdate === 'tool_call_update',
  );
  assert.ok(updatesAfterThrottle.length >= 1, 'Byte growth emits update after throttle window');
  assert.match(updatesAfterThrottle.at(-1).params.update.rawInput.label, /2KB/);

  // Structural board update emits immediately
  await appendFile(
    join(root, 'brain', id, '.system_generated/swarm/board.jsonl'),
    JSON.stringify({ seq: 2, agent: 'impl', channel: 'main', text: '@coordinator [done] All tests passed', time: new Date().toISOString() }) + '\n',
  );
  implRows.push(
    { step_index: 4, type: 'SYSTEM_MESSAGE', status: 'DONE', content: `<SYSTEM_MESSAGE>\ncontent=Task id "${workerConv}/task-1" finished with result:\nOK\n</SYSTEM_MESSAGE>` },
    { step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Finished.' },
  );
  await writeMemberTranscript(root, workerConv, implRows);
  await append([
    { step_index: 3, type: 'SYSTEM_MESSAGE', status: 'DONE', content: '<SYSTEM_MESSAGE>Board wakeup #2</SYSTEM_MESSAGE>' },
    message(4, 'SWARM_DONE'),
  ]);

  const res = await done;
  assert.equal(res.result.stopReason, 'end_turn');
  const cardEvents = emitted.filter(e => e.params?.update?.toolCallId === progressId).map(e => e.params.update);
  assert.equal(cardEvents.at(-1).status, 'completed');
  assert.match(cardEvents.at(-1).rawInput.label, /^Settled · .*#2/);
});

// Swarm Case 13: Error during Swarm drain finalizes swarm_progress card with status: 'failed'.
await scenario(async ({ root, bridge, emitted, append, begin }) => {
  bridge.nativeFull = true;
  bridge.pollMs = 10;
  bridge.timeoutMs = 2000;
  await setupSwarm(root, {
    members: { impl: { conversation_id: workerConv, role: 'worker', phase: 'RUNNING', wake_mode: 'working', last_read_seq: 1, killed: false } },
    posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@impl go', time: new Date().toISOString() }],
  });
  await writeMemberTranscript(root, workerConv, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'go' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/x"' } }] },
  ]);
  await begin();
  await append([
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'go' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm', args: { action: '"add"', name: '"impl"' } }] },
    { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Spawned' },
    message(3, 'STARTED'),
  ]);
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'tool_call', toolCallId: 'sw-fail-add', name: 'swarm', status: 'completed', rawInput: { action: 'add', name: 'impl' } } },
  });
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STARTED' } } },
  });
  const done = bridge.fromAgent(response);
  await delay(25);
  await append([{ step_index: 4, type: 'ERROR_MESSAGE', status: 'ERROR', error: 'Rate limit exhausted' }]);
  const errRes = await done;
  assert.match(errRes.error.message, /Rate limit exhausted/);
  const failedCard = emitted.findLast(e => e.params?.update?.toolCallId?.includes(':swarm-progress:'));
  assert.equal(failedCard?.params?.update?.status, 'failed');
  assert.match(failedCard?.params?.update?.rawInput?.label ?? '', /^Failed · /);
});

// Swarm Case 14: BackgroundDrain.canSteer & steer() send guidance without session/cancel, avoid duplicate replay & foreignInput false-cancel,
// re-open swarm_progress after paused guidance, accumulate usage, and keep stop button cancellation working.
await scenario(async ({ root, bridge, emitted, append, begin }) => {
  const upstream = [];
  bridge.writeUpstream = msg => upstream.push(msg);
  bridge.nativeFull = false;
  bridge.pollMs = 10;
  bridge.settleMs = 15;
  bridge.timeoutMs = 3000;

  await setupSwarm(root, {
    members: { impl: { conversation_id: workerConv, role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', last_read_seq: 1, killed: false } },
    posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '@impl build', time: new Date().toISOString() }],
  });
  await writeMemberTranscript(root, workerConv, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'build' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/a"' } }] },
  ]);

  await begin();
  assert.equal(bridge.canSteer(id), false, 'Cannot steer before P1 finishes foreground');
  await append([
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'start swarm' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm', args: { action: '"add"', name: '"impl"' } }] },
    { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Spawned' },
    message(3, 'SWARM_STARTED'),
  ]);
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'tool_call', toolCallId: 'sw-steer-add', name: 'swarm', status: 'completed', rawInput: { action: 'add', name: 'impl' } } },
  });
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'SWARM_STARTED' } } },
  });

  let settled = false;
  const done = bridge.fromAgent(response).then(r => {
    settled = true;
    return r;
  });
  await delay(30);
  assert.equal(settled, false);
  assert.equal(bridge.canSteer(id), true, 'Must allow steer while draining Swarm');

  // Pending permission blocks steer until resolved
  await bridge.fromAgent({ id: 'perm-1', method: 'session/request_permission', params: { sessionId: id } });
  assert.equal(bridge.canSteer(id), false, 'Pending permission must block steer');
  bridge.permissionResolved('perm-1');
  assert.equal(bridge.canSteer(id), true);

  // Send mid-Swarm guidance
  const steerAccepted = await bridge.steer(id, [{ type: 'text', text: 'Focus on edge tests first' }]);
  assert.equal(steerAccepted, true);
  assert.equal(bridge.canSteer(id), false, 'Cannot start second concurrent steer while one is in flight');
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0].id, 'agy-steer:1');
  assert.equal(upstream[0].method, 'session/prompt');
  assert.ok(!upstream.some(m => m.method === 'session/cancel'), 'Steer must never emit session/cancel');
  assert.ok(
    emitted.some(e => e.params?.update?.sessionUpdate === 'user_message_chunk' && e.params.update.content?.text === ''),
    'Expected fallback chunk reset on steer',
  );
  const pausedCard = emitted.findLast(
    e => e.params?.update?.toolCallId?.includes(':swarm-progress:') && e.params.update.toolCallId.endsWith(':1'),
  );
  assert.equal(pausedCard?.params?.update?.status, 'completed');
  assert.match(pausedCard?.params?.update?.rawInput?.label ?? '', /^Guidance sent · /);

  // Simulate agy acp streaming steered tool + reply and writing transcript
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'tool_call', toolCallId: 'steer-tool-1', name: 'swarm', status: 'in_progress', rawInput: { action: 'status' } } },
  });
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'tool_call_update', toolCallId: 'steer-tool-1', status: 'completed', rawOutput: { output: 'impl active' } } },
  });
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACK_GUIDANCE' } } },
  });
  await append([
    { step_index: 4, type: 'USER_INPUT', status: 'DONE', content: 'Focus on edge tests first' },
    {
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'swarm', args: { action: '"status"' } }],
      input_tokens: 20,
      cache_read_tokens: 5,
      output_tokens: 4,
    },
    { step_index: 6, type: 'GENERIC', status: 'DONE', content: 'impl active' },
    { step_index: 7, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'ACK_GUIDANCE', input_tokens: 10, cache_read_tokens: 2, output_tokens: 3 },
  ]);

  const steerResOut = await bridge.fromAgent({ jsonrpc: '2.0', id: 'agy-steer:1', result: { stopReason: 'end_turn' } });
  assert.equal(steerResOut, null, 'Internal agy-steer response must never forward downstream');
  await delay(30);
  assert.equal(settled, false, 'Outer turn must stay held while worker is still running');
  assert.equal(bridge.canSteer(id), true, 'canSteer re-enabled after steer completes');
  assert.equal(
    emitted.filter(e => e.params?.update?.content?.text === 'ACK_GUIDANCE').length,
    0,
    'Live-streamed steer reply must NOT be duplicated by BackgroundProjection',
  );
  const resumedProgressCalls = emitted.filter(
    e =>
      e.params?.update?.toolCallId?.includes(':swarm-progress:') &&
      e.params.update.toolCallId.endsWith(':2') &&
      e.params.update.sessionUpdate === 'tool_call',
  );
  assert.equal(resumedProgressCalls.length, 1, 'Expected a fresh swarm_progress card after steer reply');

  // Worker completes andCoordinator emits final summary
  await writeMemberTranscript(root, workerConv, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'build' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Worker done.' },
  ]);
  await appendFile(
    join(root, 'brain', id, '.system_generated/swarm/board.jsonl'),
    JSON.stringify({ seq: 2, agent: 'impl', channel: 'main', text: '@coordinator [done] Verified', time: new Date().toISOString() }) + '\n',
  );
  await append([
    { step_index: 8, type: 'SYSTEM_MESSAGE', status: 'DONE', content: '<SYSTEM_MESSAGE>Board wakeup #2</SYSTEM_MESSAGE>' },
    { step_index: 9, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'ALL_DONE_AFTER_STEER', input_tokens: 15, cache_read_tokens: 3, output_tokens: 6 },
  ]);

  const finalRes = await done;
  assert.equal(finalRes.result.stopReason, 'end_turn');
  assert.deepEqual(finalRes.result.usage, {
    inputTokens: 145,
    outputTokens: 23,
    cachedReadTokens: 40,
    totalTokens: 208,
  });
  assert.ok(emitted.some(e => e.params?.update?.content?.text === 'ALL_DONE_AFTER_STEER'));

  // Round 2: session/cancel with steerInFlight cancels cleanly and drops late steer response.
  await writeMemberTranscript(root, workerConv, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: new Date().toISOString(), content: 'build' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date().toISOString(), tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/b"' } }] },
  ]);
  await bridge.fromClient({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/prompt',
    params: { sessionId: id, prompt: [{ type: 'text', text: 'round 2' }] },
  });
  await append([
    { step_index: 10, type: 'USER_INPUT', status: 'DONE', content: 'round 2' },
    { step_index: 11, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', args: { since: '2' } }] },
    { step_index: 12, type: 'GENERIC', status: 'DONE', content: 'Waiting' },
  ]);
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'tool_call', toolCallId: 'sw-r2', name: 'swarm_wait', status: 'completed', rawInput: { since: 2 } } },
  });
  const done2 = bridge.fromAgent({ ...response, id: 2 });
  await delay(25);
  assert.equal(await bridge.steer(id, [{ type: 'text', text: 'nudge 2' }]), true);
  await bridge.fromClient({ method: 'session/cancel', params: { sessionId: id } });
  assert.equal((await done2).result.stopReason, 'cancelled');
  assert.equal(
    await bridge.fromAgent({ jsonrpc: '2.0', id: 'agy-steer:2', result: { stopReason: 'cancelled' } }),
    null,
    'Late cancelled steer response after session/cancel must still be swallowed',
  );

  // Round 3: Genuinely foreign extra USER_INPUT beyond an accepted steer still triggers foreignInput cancellation.
  await writeMemberTranscript(root, workerConv, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: new Date().toISOString(), content: 'build' },
    { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date().toISOString(), tool_calls: [{ name: 'read_file', args: { Path: '"/tmp/c"' } }] },
  ]);
  await bridge.fromClient({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: { sessionId: id, prompt: [{ type: 'text', text: 'round 3' }] },
  });
  await append([
    { step_index: 13, type: 'USER_INPUT', status: 'DONE', content: 'round 3' },
    { step_index: 14, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', args: { since: '2' } }] },
    { step_index: 15, type: 'GENERIC', status: 'DONE', content: 'Waiting' },
  ]);
  await bridge.fromAgent({
    method: 'session/update',
    params: { sessionId: id, update: { sessionUpdate: 'tool_call', toolCallId: 'sw-r3', name: 'swarm_wait', status: 'completed', rawInput: { since: 2 } } },
  });
  const done3 = bridge.fromAgent({ ...response, id: 3 });
  await delay(25);
  assert.equal(await bridge.steer(id, [{ type: 'text', text: 'valid steer' }]), true);
  await append([
    { step_index: 16, type: 'USER_INPUT', status: 'DONE', content: 'valid steer' },
    { step_index: 17, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Steer ack' },
  ]);
  await bridge.fromAgent({ jsonrpc: '2.0', id: 'agy-steer:3', result: { stopReason: 'end_turn' } });
  await delay(25);
  await append([
    { step_index: 18, type: 'USER_INPUT', status: 'DONE', content: 'unexpected external client input' },
    { step_index: 19, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Foreign reply' },
  ]);
  assert.equal((await done3).result.stopReason, 'cancelled', 'Foreign USER_INPUT beyond expected steers must still cancel');
});

console.log(JSON.stringify({ passed: true, cases, extraPromptsSent: 0 }));
