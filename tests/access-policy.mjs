import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessPolicy, FULL_ACCESS, isAllowedRead } from '../server/access-policy.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'agy-policy-unit-'));
const allowed = join(tmp, 'skills');
const outside = join(tmp, 'private');
mkdirSync(allowed);
mkdirSync(outside);
writeFileSync(join(allowed, 'GUIDE.md'), 'test');
writeFileSync(join(outside, 'secret'), 'test');
symlinkSync(join(outside, 'secret'), join(allowed, 'escape'));
symlinkSync(join(allowed, 'GUIDE.md'), join(allowed, 'inside'));

const request = (name, path, kind = 'read') => ({
  sessionId: 's',
  toolCall: { name, kind, rawInput: { Path: path } },
  options: [
    { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
    { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
  ],
});

let assertions = 0;
function check(value, expected) {
  assert.equal(value, expected);
  assertions++;
}

try {
  check(isAllowedRead(request('read_file', join(allowed, 'GUIDE.md')), [allowed], tmp), true);
  check(isAllowedRead(request('read_file', join(allowed, 'missing.md')), [allowed], tmp), true);
  check(isAllowedRead(request('read_file', join(allowed, 'inside')), [allowed], tmp), true);
  check(isAllowedRead(request('read_file', join(allowed, 'escape')), [allowed], tmp), false);
  check(isAllowedRead(request('read_file', join(allowed, '..', 'private', 'secret')), [allowed], tmp), false);
  check(isAllowedRead(request('read_file', allowed + '-sibling/GUIDE.md'), [allowed], tmp), false);
  check(isAllowedRead(request('write_file', join(allowed, 'GUIDE.md'), 'edit'), [allowed], tmp), false);
  check(isAllowedRead(request('run_command', join(allowed, 'GUIDE.md'), 'execute'), [allowed], tmp), false);
  check(isAllowedRead(request('mcp_read_file', join(allowed, 'GUIDE.md')), [allowed], tmp), false);
  check(isAllowedRead(request('read_file', 'skills/GUIDE.md'), [allowed], tmp), true);
  check(isAllowedRead(request('read_file', 'skills/GUIDE.md'), [allowed], null), false);

  const injection = request('read_file', join(allowed, 'GUIDE.md'));
  injection.toolCall.rawInput.CommandLine = 'touch /tmp/unexpected';
  check(isAllowedRead(injection, [allowed], tmp), false);

  const p = new AccessPolicy([allowed]);
  p.fromClient({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: tmp } });
  const opened = p.fromAgent({
    jsonrpc: '2.0',
    id: 1,
    result: {
      sessionId: 's',
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
      configOptions: [
        {
          id: 'mode',
          category: 'mode',
          type: 'select',
          currentValue: 'default',
          options: [{ value: 'default', name: 'Default' }],
        },
      ],
    },
  }).downstream;
  check(opened.result.modes.currentModeId, 'default');
  check(opened.result.modes.availableModes.at(-1).id, FULL_ACCESS);
  check(opened.result.configOptions[0].options.at(-1).value, FULL_ACCESS);

  const read = {
    jsonrpc: '2.0',
    id: 10,
    method: 'session/request_permission',
    params: request('read_file', join(allowed, 'GUIDE.md')),
  };
  check(p.fromAgent(read).reason, 'read-only');

  const command = {
    jsonrpc: '2.0',
    id: 11,
    method: 'session/request_permission',
    params: request('run_command', 'ignored', 'execute'),
  };
  check(!!p.fromAgent(command).downstream, true);

  const enter = p.fromClient({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/set_mode',
    params: { sessionId: 's', modeId: FULL_ACCESS },
  });
  check(enter.params.modeId, 'default');
  check(!!p.fromAgent(command).downstream, true);

  p.fromAgent({ jsonrpc: '2.0', id: 2, result: {} });
  check(p.fromAgent(command).reason, FULL_ACCESS);

  const other = structuredClone(command);
  other.params.sessionId = 'other';
  check(!!p.fromAgent(other).downstream, true);

  const question = structuredClone(command);
  question.params.toolCall.name = 'ask_user';
  check(!!p.fromAgent(question).downstream, true);

  p.fromClient({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/set_config_option',
    params: { sessionId: 's', configId: 'mode', value: 'default' },
  });
  check(!!p.fromAgent(command).downstream, true);

  p.fromAgent({
    jsonrpc: '2.0',
    id: 3,
    result: { configOptions: [{ id: 'mode', category: 'mode', type: 'select', currentValue: 'default', options: [] }] },
  });
  check(!!p.fromAgent(command).downstream, true);

  p.fromClient({
    jsonrpc: '2.0',
    id: 4,
    method: 'session/set_config_option',
    params: { sessionId: 's', configId: 'mode', value: FULL_ACCESS },
  });
  p.fromAgent({ jsonrpc: '2.0', id: 4, error: { code: 1, message: 'failed' } });
  check(!!p.fromAgent(command).downstream, true);

  const persistent = structuredClone(read);
  persistent.params.options = [{ optionId: 'always', kind: 'allow_always', name: 'Always allow' }];
  check(!!p.fromAgent(persistent).downstream, true);

  console.log(
    JSON.stringify({
      passed: true,
      assertions,
      coverage: [
        'read-only roots',
        'missing files',
        'symlink escape',
        'path traversal',
        'sibling prefix',
        'write/command/MCP remain prompted',
        'no persistent grants',
        'explicit full-access entry and exit',
        'session isolation',
        'real questions retained',
      ],
    }),
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
