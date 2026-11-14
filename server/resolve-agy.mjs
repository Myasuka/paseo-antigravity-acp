import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export function expandHomePath(rawPath, home = homedir()) {
  if (typeof rawPath !== 'string') return '';
  const trimmed = rawPath.trim();
  if (!trimmed) return '';
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolve(home, trimmed.slice(2));
  }
  return trimmed;
}

function isExecutableFile(filePath, platform = process.platform) {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === 'win32') return true;
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveAgyBinary({
  configuredPath = '',
  env = process.env,
  platform = process.platform,
  homedirPath = homedir(),
} = {}) {
  const checked = [];
  const exeNames = platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy'] : ['agy'];

  const checkCandidate = (raw, source) => {
    const expanded = expandHomePath(raw, homedirPath);
    if (!expanded) return null;
    const target = isAbsolute(expanded) ? expanded : resolve(expanded);
    if (!checked.includes(target)) checked.push(target);
    if (isExecutableFile(target, platform)) {
      return { found: true, path: target, source, checked };
    }
    return null;
  };

  if (typeof configuredPath === 'string' && configuredPath.trim()) {
    const hit = checkCandidate(configuredPath, 'configured');
    return hit ?? { found: false, path: null, source: 'configured', checked };
  }

  if (typeof env.PASEO_AGY_BIN === 'string' && env.PASEO_AGY_BIN.trim()) {
    const hit = checkCandidate(env.PASEO_AGY_BIN, 'env');
    return hit ?? { found: false, path: null, source: 'env', checked };
  }

  const pathVar = typeof env.PATH === 'string' ? env.PATH : '';
  for (const segment of pathVar.split(delimiter)) {
    const dir = expandHomePath(segment, homedirPath);
    if (!dir) continue;
    for (const exe of exeNames) {
      const hit = checkCandidate(join(dir, exe), 'path');
      if (hit) return hit;
    }
  }

  const fallbacks = platform === 'win32'
    ? [
        join(homedirPath, '.local', 'bin', 'agy.exe'),
        join(homedirPath, 'AppData', 'Local', 'Programs', 'agy', 'agy.exe'),
      ]
    : [
        join(homedirPath, '.local', 'bin', 'agy'),
        '/opt/homebrew/bin/agy',
        '/usr/local/bin/agy',
      ];

  for (const fallback of fallbacks) {
    const hit = checkCandidate(fallback, 'fallback');
    if (hit) return hit;
  }

  return { found: false, path: null, source: 'none', checked };
}

export function parseExtraReadRoots(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') return [];
  const trimmed = rawValue.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean);
    }
  } catch {
    // Fall back to colon/newline separated paths when not JSON.
  }
  return trimmed.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
}

export function mergeReadOnlyRoots(baseRoots = [], extraRoots = []) {
  const seen = new Set();
  const merged = [];
  for (const item of [...baseRoots, ...extraRoots]) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    merged.push(trimmed);
  }
  return merged;
}
