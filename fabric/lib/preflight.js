// preflightCheck — LLM-based Hard Rule violation detector for mission specs.

'use strict';

const { loadWorkspaceHrs } = require('./hrs');
const { invokeClaude, extractJson } = require('./claude');

const MAX_SPEC_CHARS = 8000;

function buildPrompt(hrs, missionDescription) {
  const summary = hrs
    .map((h) => '- ' + h.id + ' (' + h.severity + '): ' + h.body)
    .join('\n');
  return [
    'You are a non-custodial / security invariant validator for the Fabric autodev system.',
    '',
    'The following mission is about to be dispatched. Determine if it VIOLATES any of the Hard Rules listed below.',
    '',
    'HARD RULES:',
    summary,
    '',
    'MISSION DESCRIPTION:',
    String(missionDescription || '').slice(0, MAX_SPEC_CHARS),
    '',
    'Answer in strict JSON:',
    '{',
    '  "decision": "PASS" | "VIOLATE",',
    '  "violations": [{"hr_id": "...", "reason": "..."}],',
    '  "rewrite_suggestion": "if VIOLATE: 2-3 sentences proposing how to refactor mission to respect HRs"',
    '}',
    '',
    'Be strict. Err on the side of VIOLATE if any doubt. Output JSON only, no prose.',
  ].join('\n');
}

async function preflightCheck(mission, deps) {
  const { sb, claude = invokeClaude } = deps;
  if (!sb) throw new Error('preflightCheck: deps.sb required');

  const hrs = await loadWorkspaceHrs(sb, mission.workspace_id);
  if (!hrs.length) {
    return { pass: true, hrs_checked: 0, violations: [], rewrite_suggestion: null };
  }

  const prompt = buildPrompt(hrs, mission.description);

  let stdout;
  try {
    stdout = await claude(prompt);
  } catch (err) {
    return {
      pass: true,
      hrs_checked: hrs.length,
      violations: [],
      rewrite_suggestion: null,
      error: 'claude_invoke_failed: ' + err.message,
    };
  }

  const decision = extractJson(stdout);
  if (!decision) {
    return {
      pass: true,
      hrs_checked: hrs.length,
      violations: [],
      rewrite_suggestion: null,
      error: 'no_json_in_response',
    };
  }

  return {
    pass: decision.decision === 'PASS',
    hrs_checked: hrs.length,
    violations: Array.isArray(decision.violations) ? decision.violations : [],
    rewrite_suggestion: decision.rewrite_suggestion || null,
  };
}

module.exports = { preflightCheck, buildPrompt };
