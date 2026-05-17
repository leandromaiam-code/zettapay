// selfHealSpec — iteratively rewrite a mission spec until it passes preflight.

'use strict';

const { invokeClaude } = require('./claude');
const { preflightCheck } = require('./preflight');
const { loadWorkspaceHrs } = require('./hrs');

const DEFAULT_ATTEMPTS = 3;
const MAX_SPEC_CHARS = 8000;

function buildHealPrompt(hrs, originalDescription, violations) {
  const summary = hrs
    .map((h) => '- ' + h.id + ' (' + h.severity + '): ' + h.body)
    .join('\n');
  const violationList = (violations || [])
    .map((v) => '- ' + v.hr_id + ': ' + v.reason)
    .join('\n');
  return [
    'You are a mission-spec rewriter for the Fabric autodev system.',
    '',
    'The previous mission spec VIOLATED these Hard Rules:',
    violationList || '(none specified — assume general HR violation)',
    '',
    'HARD RULES (canonical):',
    summary,
    '',
    'ORIGINAL SPEC:',
    String(originalDescription || '').slice(0, MAX_SPEC_CHARS),
    '',
    'Rewrite the spec to PRESERVE the underlying objective while NOT violating any Hard Rule.',
    'Keep the same overall structure (sections, scope, validations). Replace forbidden mechanisms',
    'with the non-violating equivalent (e.g. custodial key storage -> merchant-held xpub +',
    'address derivation; wallet.connect -> pubkey input field; etc.).',
    '',
    'Output JSON only:',
    '{ "new_description": "...full rewritten spec..." }',
  ].join('\n');
}

async function selfHealSpec(mission, initialCheck, deps) {
  const { sb, claude = invokeClaude, maxAttempts = DEFAULT_ATTEMPTS } = deps;
  if (!sb) throw new Error('selfHealSpec: deps.sb required');

  const hrs = await loadWorkspaceHrs(sb, mission.workspace_id);
  const attempts = [];
  let lastCheck = initialCheck;
  let currentDescription = mission.description;

  for (let i = 1; i <= maxAttempts; i++) {
    const prompt = buildHealPrompt(hrs, currentDescription, lastCheck.violations);
    let stdout;
    try {
      stdout = await claude(prompt, { effort: 'high' });
    } catch (err) {
      attempts.push({ attempt: i, error: 'claude_invoke_failed: ' + err.message });
      continue;
    }
    const match = stdout.match(/\{[\s\S]*\}/);
    let parsed = null;
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
    if (!parsed || !parsed.new_description) {
      attempts.push({ attempt: i, error: 'no_new_description' });
      continue;
    }

    const rewrittenMission = Object.assign({}, mission, { description: parsed.new_description });
    const check = await preflightCheck(rewrittenMission, { sb, claude });
    attempts.push({ attempt: i, pass: check.pass, violations: check.violations });

    if (check.pass) {
      return {
        pass: true,
        attempts,
        new_description: parsed.new_description,
        final_check: check,
      };
    }
    currentDescription = parsed.new_description;
    lastCheck = check;
  }

  return { pass: false, attempts, new_description: null, final_check: lastCheck };
}

module.exports = { selfHealSpec, buildHealPrompt };
