// intentToMission — expand a free-form INTENT into a full mission spec
// that already respects the workspace's HR-* rules.

'use strict';

const { loadWorkspaceHrs } = require('./hrs');
const { invokeClaude, extractJson } = require('./claude');
const { preflightCheck } = require('./preflight');
const { selfHealSpec } = require('./self-heal');

const RECENT_MISSIONS_LIMIT = 20;
const INTENT_MAX_CHARS = 4000;
const CONTEXT_MAX_CHARS = 4000;

async function loadWorkspaceBySlug(sb, slug) {
  const rows = await sb(
    'GET',
    '/rest/v1/fabric_workspaces?slug=eq.' + encodeURIComponent(slug) + '&select=id,slug,name'
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('workspace_not_found: ' + slug);
  }
  return rows[0];
}

async function loadRecentMissions(sb, workspaceId) {
  const path =
    '/rest/v1/fabric_squad_missions' +
    '?workspace_id=eq.' + encodeURIComponent(workspaceId) +
    '&select=id,name,status,created_at' +
    '&order=created_at.desc' +
    '&limit=' + RECENT_MISSIONS_LIMIT;
  const rows = await sb('GET', path);
  return Array.isArray(rows) ? rows : [];
}

async function loadLayer0Premissas(sb, workspaceId) {
  const path =
    '/rest/v1/fabric_layer0_premissas' +
    '?workspace_id=eq.' + encodeURIComponent(workspaceId) +
    '&select=id,title,body,severity,premissa_kind';
  const rows = await sb('GET', path);
  return Array.isArray(rows) ? rows : [];
}

function buildIntentPrompt({ intent, context, layer0, hrs, recentMissions }) {
  const layer0Summary = layer0
    .map((p) => '- ' + p.id + ' (' + (p.premissa_kind || 'guidance') + '/' + (p.severity || 'soft') + '): ' + p.title)
    .join('\n');
  const hrSummary = hrs
    .map((h) => '- ' + h.id + ' (' + h.severity + '): ' + h.body)
    .join('\n');
  const recent = recentMissions
    .map((m) => '- [' + m.status + '] ' + m.name)
    .join('\n');
  return [
    'You are a mission-spec generator for the Fabric autodev system.',
    '',
    'Given a free-form INTENT, generate ONE detailed mission spec (name + description) that',
    'fulfills the intent without violating any Hard Rule (HR-*). The description should be',
    'self-contained: CONTEXT, SCOPE, VALIDATIONS, NAO FAZER.',
    '',
    'LAYER 0 PREMISSAS (constraints):',
    layer0Summary || '(none)',
    '',
    'HARD RULES (MUST NOT violate):',
    hrSummary || '(none)',
    '',
    'RECENT MISSIONS (avoid duplicates):',
    recent || '(none)',
    '',
    'ADDITIONAL CONTEXT:',
    String(context || '').slice(0, CONTEXT_MAX_CHARS),
    '',
    'INTENT:',
    String(intent || '').slice(0, INTENT_MAX_CHARS),
    '',
    'Output JSON only:',
    '{ "name": "<short title under 80 chars>", "description": "<full mission spec>" }',
  ].join('\n');
}

async function intentToMission({ workspace_slug, intent, context }, deps) {
  const { sb, claude = invokeClaude, dispatch } = deps;
  if (!sb) throw new Error('intentToMission: deps.sb required');
  if (!intent || typeof intent !== 'string') throw new Error('intentToMission: intent required');

  const workspace = await loadWorkspaceBySlug(sb, workspace_slug);
  const [layer0, hrs, recentMissions] = await Promise.all([
    loadLayer0Premissas(sb, workspace.id),
    loadWorkspaceHrs(sb, workspace.id),
    loadRecentMissions(sb, workspace.id),
  ]);

  const prompt = buildIntentPrompt({ intent, context, layer0, hrs, recentMissions });
  const stdout = await claude(prompt, { effort: 'high', timeoutMs: 180_000 });
  const parsed = extractJson(stdout);
  if (!parsed || !parsed.name || !parsed.description) {
    throw new Error('intent_generation_failed: malformed Claude response');
  }

  const candidateMission = {
    workspace_id: workspace.id,
    name: parsed.name,
    description: parsed.description,
  };

  let preflight = await preflightCheck(candidateMission, { sb, claude });
  let healed = null;
  if (!preflight.pass) {
    healed = await selfHealSpec(candidateMission, preflight, { sb, claude });
    if (!healed.pass) {
      return {
        pass: false,
        mission_id: null,
        name: parsed.name,
        dispatched: false,
        preflight,
        heal_attempts: healed.attempts,
        candidate_description: candidateMission.description,
      };
    }
    candidateMission.description = healed.new_description;
    preflight = healed.final_check;
  }

  const inserted = await sb('POST', '/rest/v1/fabric_squad_missions', {
    workspace_id: workspace.id,
    name: candidateMission.name,
    description: candidateMission.description,
    source: 'auto-intent',
    status: 'pending',
  });
  const row = Array.isArray(inserted) ? inserted[0] : inserted;
  const missionId = row && row.id;

  let dispatched = false;
  if (typeof dispatch === 'function' && missionId) {
    try {
      await dispatch({ id: missionId, ...candidateMission });
      dispatched = true;
    } catch (err) {
      process.stderr.write('[intent] dispatch failed: ' + err.message + '\n');
    }
  }

  return {
    pass: true,
    mission_id: missionId,
    name: candidateMission.name,
    dispatched,
    preflight,
    heal_attempts: healed ? healed.attempts : [],
  };
}

module.exports = { intentToMission, buildIntentPrompt };
