// Shared regex-scan utilities used by both /scripts/hr-scan.mjs (CI) and
// the Fabric post-merge cron (fabric/bin/postscan.js).

'use strict';

const SEVERITY_EXIT = { soft: 0, hard: 1, blocker: 2 };

const DEFAULT_PATH_ALLOWLIST = [
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

function isAllowlisted(path, allowlist = DEFAULT_PATH_ALLOWLIST) {
  return allowlist.some((re) => re.test(path));
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

function compileRule(rule) {
  return {
    id: rule.id,
    severity: rule.severity || 'soft',
    title: rule.title || rule.id,
    body: rule.body || '',
    patterns: (rule.detection_patterns || []).map((p) => ({ src: p, re: new RegExp(p, 'i') })),
  };
}

function checkLine(text, compiledRules) {
  const hits = [];
  for (const rule of compiledRules) {
    for (const { src, re } of rule.patterns) {
      if (!re.test(text)) continue;
      if (rule.id === 'HR-SECRETS-IN-GIT' && looksLikePlaceholderSecret(text, re)) continue;
      hits.push({ rule, pattern: src });
      break;
    }
  }
  return hits;
}

function scanFiles(filesWithContent, rules, opts = {}) {
  const allowlist = opts.allowlist || DEFAULT_PATH_ALLOWLIST;
  const overrides = new Set(opts.overrides || []);
  const compiled = rules.map(compileRule);
  const violations = [];
  for (const { path, content } of filesWithContent) {
    if (isAllowlisted(path, allowlist)) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      for (const hit of checkLine(text, compiled)) {
        if (overrides.has(hit.rule.id)) continue;
        violations.push({
          file: path,
          line: i + 1,
          rule_id: hit.rule.id,
          severity: hit.rule.severity,
          pattern: hit.pattern,
          snippet: text.trim().slice(0, 160),
        });
      }
    }
  }
  return violations;
}

function maxSeverityExit(violations) {
  let code = 0;
  for (const v of violations) {
    const c = SEVERITY_EXIT[v.severity] ?? 0;
    if (c > code) code = c;
  }
  return code;
}

module.exports = {
  DEFAULT_PATH_ALLOWLIST,
  SEVERITY_EXIT,
  isAllowlisted,
  compileRule,
  checkLine,
  scanFiles,
  maxSeverityExit,
  looksLikePlaceholderSecret,
};
