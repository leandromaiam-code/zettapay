#!/usr/bin/env node
// Hard-Rule regex scanner. Reads HR-* rules from fabric/seed/zettapay_hrs.json
// and applies their detection_patterns against either a git diff or specific
// files. Designed to run as a PR gate (.github/workflows/hr-scan.yml).
//
// Modes:
//   node scripts/hr-scan.mjs diff [<base-ref>]   default base: origin/main
//   node scripts/hr-scan.mjs files <path> [<path>...]
//   node scripts/hr-scan.mjs tree                 scan all tracked files
//
// Exit codes: 0 clean (or only soft hits), 1 hard violation, 2 blocker.
//
// Override (Fabric autodev only): set ALLOW_HR_OVERRIDE to a comma-separated
// list of HR ids (e.g. "HR-CUSTODY,HR-PII-MINIMAL"). Documented but discouraged.

import { readFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const RULES_PATH = join(REPO, 'fabric/seed/zettapay_hrs.json');

const PATH_ALLOWLIST = [
  /^docs\//,
  /^audit\//,
  /^examples\//,
  /^scripts\//,
  /^fabric\//,
  /^community\//,
  /^public\/install\//,
  /^packages\/legacy-solana\//,
  /(^|\/)kyc(\.[a-z]+)?$/i,
  /(^|\/)kyc\//i,
  /(^|\/)sumsub/i,
  /(^|\/)\.env\.example(\..*)?$/,
  /\.md$/i,
  /\.mdx$/i,
  /\.test\.(ts|tsx|js|mjs|cjs)$/i,
  /\.spec\.(ts|tsx|js|mjs|cjs)$/i,
  /(^|\/)tests?\//,
  /(^|\/)__tests__\//,
];

const SEVERITY_EXIT = { soft: 0, hard: 1, blocker: 2 };

function loadRules() {
  const raw = readFileSync(RULES_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed.rules.map((r) => ({
    ...r,
    regexes: r.detection_patterns.map((p) => new RegExp(p, 'i')),
  }));
}

function isAllowlisted(path) {
  return PATH_ALLOWLIST.some((re) => re.test(path));
}

function parseOverrides() {
  const raw = (process.env.ALLOW_HR_OVERRIDE || '').trim();
  if (!raw) return new Set();
  return new Set(raw.split(/[,\s]+/).map((s) => s.split(':').pop()).filter(Boolean));
}

function looksLikePlaceholderSecret(text, regex) {
  const m = text.match(regex);
  if (!m) return false;
  const body = m[0].replace(/^(sk_live_|zk_live_|whsec_|ghp_|0x)/i, '');
  if (body.length < 12) return false;
  const lower = body.toLowerCase();
  const uniq = new Set(lower.replace(/[^a-z0-9]/g, '')).size;
  if (uniq <= 4) return true;
  if (/^([a-f0-9])\1{15,}$/i.test(lower)) return true;
  if (/^x{12,}$|^a{12,}$|^0{12,}$|^f{12,}$|^deadbeef/i.test(lower)) return true;
  return false;
}

function checkLine(text, rules) {
  const hits = [];
  for (const rule of rules) {
    for (let i = 0; i < rule.regexes.length; i++) {
      const re = rule.regexes[i];
      if (!re.test(text)) continue;
      if (rule.id === 'HR-SECRETS-IN-GIT' && looksLikePlaceholderSecret(text, re)) continue;
      hits.push({ rule, pattern: rule.detection_patterns[i] });
      break;
    }
  }
  return hits;
}

function parseAddedLines(diff) {
  const out = [];
  let file = null;
  let cursor = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = null;
      cursor = 0;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const m = raw.match(/^\+\+\+ (?:b\/)?(.+)$/);
      file = m && m[1] !== '/dev/null' ? m[1] : null;
      continue;
    }
    if (raw.startsWith('--- ')) continue;
    if (raw.startsWith('@@')) {
      const m = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) cursor = parseInt(m[1], 10);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      out.push({ file, line: cursor, text: raw.slice(1) });
      cursor++;
    } else if (raw.startsWith(' ')) {
      cursor++;
    }
  }
  return out;
}

function gitDiff(base) {
  const cmd = `git diff --no-color --unified=0 ${base}...HEAD`;
  return execSync(cmd, { cwd: REPO, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
}

function listTracked() {
  const out = execSync('git ls-files', { cwd: REPO, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function scanFileLines(path) {
  const abs = join(REPO, path);
  try {
    if (statSync(abs).isDirectory()) return [];
  } catch {
    return [];
  }
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n');
  return lines.map((t, i) => ({ file: path, line: i + 1, text: t }));
}

function emitGitHub(violation) {
  const sev = violation.rule.severity;
  const level = sev === 'soft' ? 'warning' : 'error';
  const msg = `${violation.rule.id} (${sev}): pattern /${violation.pattern}/ matched. ${violation.rule.title}.`;
  // GitHub Actions annotation
  if (process.env.GITHUB_ACTIONS) {
    process.stdout.write(
      `::${level} file=${violation.file},line=${violation.line}::${msg.replace(/\n/g, ' ')}\n`
    );
  }
  process.stdout.write(
    `${violation.file}:${violation.line}\t[${sev.toUpperCase()}] ${violation.rule.id}\t${violation.pattern}\t${violation.snippet}\n`
  );
}

function emitSummary(violations, overrides) {
  const counts = { soft: 0, hard: 0, blocker: 0 };
  for (const v of violations) counts[v.rule.severity]++;
  process.stdout.write(
    `\n[hr-scan] summary: soft=${counts.soft} hard=${counts.hard} blocker=${counts.blocker}` +
      (overrides.size ? ` (override active: ${[...overrides].join(',')})` : '') +
      '\n'
  );
}

function run() {
  const [, , mode = 'diff', ...rest] = process.argv;
  const rules = loadRules();
  const overrides = parseOverrides();

  let candidates;
  if (mode === 'diff') {
    const base = rest[0] || process.env.HR_SCAN_BASE || 'origin/main';
    candidates = parseAddedLines(gitDiff(base));
  } else if (mode === 'files') {
    if (!rest.length) {
      process.stderr.write('[hr-scan] files mode requires at least one path\n');
      process.exit(64);
    }
    candidates = rest.flatMap((p) => scanFileLines(p));
  } else if (mode === 'tree') {
    candidates = listTracked().flatMap((p) => scanFileLines(p));
  } else {
    process.stderr.write(`[hr-scan] unknown mode: ${mode}\n`);
    process.exit(64);
  }

  const violations = [];
  for (const c of candidates) {
    if (isAllowlisted(c.file)) continue;
    const hits = checkLine(c.text, rules);
    for (const hit of hits) {
      if (overrides.has(hit.rule.id)) continue;
      violations.push({
        file: c.file,
        line: c.line,
        rule: hit.rule,
        pattern: hit.pattern,
        snippet: c.text.trim().slice(0, 160),
      });
    }
  }

  for (const v of violations) emitGitHub(v);
  emitSummary(violations, overrides);

  let exit = 0;
  for (const v of violations) {
    const code = SEVERITY_EXIT[v.rule.severity] ?? 0;
    if (code > exit) exit = code;
  }
  process.exit(exit);
}

run();
