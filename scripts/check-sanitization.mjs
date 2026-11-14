import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const BINARY_EXTENSIONS = /\.(?:png|jpg|jpeg|gif|webp|ico|woff2?|ttf|pdf|tgz)$/i;

const FORBIDDEN_PATTERNS = [
  { name: 'linux-data-mount-home', regex: /\/data\d{2}\/home\//i },
  {
    name: 'specific-user-home',
    regex: /\/(?:home|Users)\/(?!user\b|alice\b|developer\b|runner\b|ubuntu\b)[a-z0-9._-]{3,}\//i,
  },
  { name: 'npm-global-hardcode', regex: /\.npm-global\/lib\/node_modules/i },
  { name: 'private-key-block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  {
    name: 'secret-token',
    regex: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z-_]{30,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
  },
  {
    name: 'internal-issue-key',
    regex: /\b(?!(?:UTF|ISO|SHA|CVE|RFC|ECMA|IEEE|POSIX|ANSI|HTTP|GRPC|JSON|YAML|NODE|V8|MIT|BSD|GPL|LGPL|MPL|EPL|CDDL|CC0)-\d)[A-Z]{3,8}-\d+(?:\.\d+)+\b/,
  },
];

if (process.env.SANITIZE_EXTRA_REGEX) {
  FORBIDDEN_PATTERNS.push({
    name: 'env-extra-forbidden',
    regex: new RegExp(process.env.SANITIZE_EXTRA_REGEX, 'i'),
  });
}

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkFiles(full, out);
    } else if (stat.isFile() && !BINARY_EXTENSIONS.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const findings = [];

for (const file of walkFiles(ROOT)) {
  const rel = relative(ROOT, file);
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.regex.test(line)) {
        findings.push({ location: `${rel}:${idx + 1}`, rule: rule.name });
      }
    }
  }
}

if (existsSync(join(ROOT, '.git'))) {
  try {
    const commits = execFileSync('git', ['-C', ROOT, 'log', '--all', '--format=%H %B'], { encoding: 'utf8' });
    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.regex.test(commits)) {
        findings.push({ location: 'git-history', rule: rule.name });
      }
    }
  } catch {
    // Empty git repository before initial commit has no log entries yet.
  }
}

if (findings.length > 0) {
  console.error('Sanitization check failed:', JSON.stringify(findings, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ passed: true, checkedRoot: '.', rules: FORBIDDEN_PATTERNS.length }));
