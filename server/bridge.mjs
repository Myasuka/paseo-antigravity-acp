import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { AccessPolicy } from './access-policy.mjs';
import { SessionMetadata } from './session-metadata.mjs';
import { preserveToolContent } from './tool-content.mjs';
import { BackgroundDrain } from './background-drain.mjs';
import { mergeReadOnlyRoots, parseExtraReadRoots, resolveAgyBinary } from './resolve-agy.mjs';

const policyPath = process.env.PASEO_AGY_READ_POLICY_FILE ?? new URL('./read-policy.json', import.meta.url);
const rules = JSON.parse(readFileSync(policyPath, 'utf8'));
if (!Array.isArray(rules.readOnlyRoots) || !rules.readOnlyRoots.every(root => typeof root === 'string')) {
  throw new Error('Invalid read-only policy');
}
const extraRoots = parseExtraReadRoots(process.env.PASEO_AGY_EXTRA_READ_ROOTS);
const policy = new AccessPolicy(mergeReadOnlyRoots(rules.readOnlyRoots, extraRoots));

const metadata = new SessionMetadata({
  progressUpdates: process.env.PASEO_AGY_PROGRESS_UPDATES !== '0',
  backgroundApprovals: process.env.PASEO_AGY_NATIVE_FULL_ACCESS !== '1',
});

const backgroundTimeout = Number(process.env.PASEO_AGY_BACKGROUND_TIMEOUT_MS ?? 3600000);
if (!Number.isInteger(backgroundTimeout) || backgroundTimeout < 1000 || backgroundTimeout > 86400000) {
  throw new Error('PASEO_AGY_BACKGROUND_TIMEOUT_MS must be between 1000 and 86400000');
}

const resolved = resolveAgyBinary({ env: process.env });
if (!resolved.found || !resolved.path) {
  process.stderr.write(
    `Antigravity CLI (agy) executable not found. Checked: ${resolved.checked.join(', ') || 'PATH and standard locations'}\n`,
  );
  process.exit(1);
}

const args = ['acp', '--process-per-session'];
if (process.env.PASEO_AGY_NATIVE_FULL_ACCESS === '1') {
  args.push('--dangerously-skip-permissions');
}

const child = spawn(resolved.path, args, {
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit'],
  detached: true,
});

const background = new BackgroundDrain({ emit: deliver, timeoutMs: backgroundTimeout });
let stopping = false;
let timer;

function stop() {
  if (stopping) return;
  stopping = true;
  background.close();
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  timer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
    process.exit(1);
  }, 5000);
  timer.unref();
}

function write(stream, message) {
  if (!stream.destroyed) stream.write(JSON.stringify(message) + '\n');
}

function deliver(message) {
  if (!message) return;
  const result = policy.fromAgent(metadata.fromAgent(preserveToolContent(message)));
  if (result.upstream) {
    background.permissionResolved(result.upstream.id);
    if (process.env.PASEO_AGY_POLICY_AUDIT) {
      appendFileSync(
        process.env.PASEO_AGY_POLICY_AUDIT,
        JSON.stringify({ event: 'automatic-permission', reason: result.reason }) + '\n',
      );
    }
    write(child.stdin, result.upstream);
  }
  if (result.downstream) write(process.stdout, result.downstream);
}

async function clientLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write('Invalid client ACP JSON.\n');
    stop();
    return;
  }
  try {
    write(child.stdin, await background.fromClient(metadata.fromClient(policy.fromClient(message))));
  } catch (error) {
    if ('id' in message) {
      deliver({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message } });
    } else {
      process.stderr.write('Unable to process ACP notification.\n');
    }
  }
}

let agentQueue = Promise.resolve();
function agentLine(line) {
  if (!line.trim()) return;
  agentQueue = agentQueue.then(async () => {
    if (stopping) return;
    try {
      deliver(await background.fromAgent(JSON.parse(line)));
    } catch {
      process.stderr.write('Invalid agent ACP JSON.\n');
      stop();
    }
  });
}

createInterface({ input: process.stdin }).on('line', line => { void clientLine(line); }).on('close', stop);
createInterface({ input: child.stdout }).on('line', line => { void agentLine(line); });
child.on('error', () => {
  process.stderr.write('Unable to start agy ACP.\n');
  stop();
});
child.on('close', code => {
  background.close();
  clearTimeout(timer);
  process.exit(code ?? 0);
});
child.stdin.on('error', stop);
process.stdin.on('error', stop);
process.stdout.on('error', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('exit', () => {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
});
