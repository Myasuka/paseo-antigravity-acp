import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  expandHomePath,
  mergeReadOnlyRoots,
  parseExtraReadRoots,
  resolveAgyBinary,
} from '../server/resolve-agy.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'agy-resolve-unit-'));

function makeExe(dir, name = 'agy') {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, name);
  writeFileSync(target, '#!/bin/sh\nexit 0\n');
  chmodSync(target, 0o755);
  return target;
}

try {
  const fakeHome = join(tmp, 'home');
  const configuredBin = makeExe(join(fakeHome, 'custom'), 'agy');
  const envBin = makeExe(join(tmp, 'env-bin'), 'agy');
  const pathBin = makeExe(join(tmp, 'path-bin'), 'agy');
  const fallbackBin = makeExe(join(fakeHome, '.local', 'bin'), 'agy');

  assert.equal(expandHomePath('~/custom/agy', fakeHome), configuredBin);
  assert.equal(expandHomePath('~', fakeHome), fakeHome);
  assert.equal(expandHomePath('', fakeHome), '');

  // 1. Configured path wins over env, PATH, and fallback
  const byConfig = resolveAgyBinary({
    configuredPath: '~/custom/agy',
    env: { PASEO_AGY_BIN: envBin, PATH: join(tmp, 'path-bin') },
    homedirPath: fakeHome,
    platform: 'linux',
  });
  assert.equal(byConfig.found, true);
  assert.equal(byConfig.source, 'configured');
  assert.equal(byConfig.path, configuredBin);

  // Explicit invalid configuredPath fails closed instead of silently using a different binary
  const badConfig = resolveAgyBinary({
    configuredPath: '~/custom/nonexistent-agy',
    env: { PASEO_AGY_BIN: envBin, PATH: join(tmp, 'path-bin') },
    homedirPath: fakeHome,
    platform: 'linux',
  });
  assert.equal(badConfig.found, false);
  assert.equal(badConfig.source, 'configured');

  // 2. PASEO_AGY_BIN wins over PATH and fallback
  const byEnv = resolveAgyBinary({
    configuredPath: '',
    env: { PASEO_AGY_BIN: envBin, PATH: join(tmp, 'path-bin') },
    homedirPath: fakeHome,
    platform: 'linux',
  });
  assert.equal(byEnv.found, true);
  assert.equal(byEnv.source, 'env');
  assert.equal(byEnv.path, envBin);

  // 3. PATH wins over ~/.local/bin/agy fallback
  const byPath = resolveAgyBinary({
    configuredPath: '',
    env: { PATH: [join(tmp, 'empty'), join(tmp, 'path-bin')].join(delimiter) },
    homedirPath: fakeHome,
    platform: 'linux',
  });
  assert.equal(byPath.found, true);
  assert.equal(byPath.source, 'path');
  assert.equal(byPath.path, pathBin);

  // 4. Fallback hits ~/.local/bin/agy when PATH is empty
  const byFallback = resolveAgyBinary({
    configuredPath: '',
    env: { PATH: '' },
    homedirPath: fakeHome,
    platform: 'linux',
  });
  assert.equal(byFallback.found, true);
  assert.equal(byFallback.source, 'fallback');
  assert.equal(byFallback.path, fallbackBin);

  // 5. Extra read-only root parsing & deduplicating merge
  assert.deepEqual(parseExtraReadRoots('["~/docs", " ~/skills ", ""]'), ['~/docs', '~/skills']);
  assert.deepEqual(parseExtraReadRoots('~/one\n~/two\r\n'), ['~/one', '~/two']);
  assert.deepEqual(parseExtraReadRoots(''), []);
  assert.deepEqual(mergeReadOnlyRoots(['~/.agents/skills', '~/docs'], ['~/docs', '~/extra']), [
    '~/.agents/skills',
    '~/docs',
    '~/extra',
  ]);

  // 6. Default read-policy.json contains only portable public skill directories
  const policy = JSON.parse(readFileSync(new URL('../server/read-policy.json', import.meta.url), 'utf8'));
  assert.deepEqual(policy.readOnlyRoots, [
    '~/.agents/skills',
    '~/.codex/skills',
    '~/.claude/skills',
    '~/.gemini/antigravity-cli/builtin/skills',
  ]);

  console.log(
    JSON.stringify({
      passed: true,
      coverage: ['configured>env>PATH>fallback', 'fail-closed explicit config', 'tilde expansion', 'extra roots merge', 'portable default policy'],
    }),
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
