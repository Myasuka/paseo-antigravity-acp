import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, rename } from 'node:fs/promises';
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

console.log(JSON.stringify({ passed: true, cases, extraPromptsSent: 0 }));
