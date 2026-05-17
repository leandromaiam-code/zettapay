# Wiring `preflightCheck` + `selfHealSpec` + `intentToMission` into `/opt/fabric-api/server.js`

Drop-in instructions for the Fabric control-plane API server. The libraries
under `fabric/lib/` are deliberately CommonJS and dependency-free so they can
be `require()`'d from the existing `server.js`.

## 1. Vendor the libs onto the Fabric host

```bash
sudo install -d /opt/veridian-fabric/fabric/lib
sudo install -d /opt/veridian-fabric/fabric/bin
sudo install -d /opt/veridian-fabric/fabric/seed
sudo install -m 0644 fabric/lib/*.js  /opt/veridian-fabric/fabric/lib/
sudo install -m 0755 fabric/bin/*.js  /opt/veridian-fabric/fabric/bin/
sudo install -m 0755 fabric/bin/*.sh  /opt/jarvisai/scripts/
```

## 2. Apply the migration + seed

```bash
psql "${SUPABASE_DB_URL}" -f fabric/migrations/0001_hr_columns.sql
psql "${SUPABASE_DB_URL}" -f fabric/seed/zettapay_hrs.sql
```

## 3. Patch `server.js`

Near the top of the file, alongside the existing `sb` definition:

```js
const { preflightCheck } = require('/opt/veridian-fabric/fabric/lib/preflight');
const { selfHealSpec }   = require('/opt/veridian-fabric/fabric/lib/self-heal');
const { intentToMission } = require('/opt/veridian-fabric/fabric/lib/intent');
const { appendAudit }    = require('/opt/veridian-fabric/fabric/lib/audit');
```

Inside `handleExecuteMission`, **before** the `claude-code` spawn block:

```js
const check = await preflightCheck(mission, { sb });
await appendAudit(sb, {
  workspace_id: mission.workspace_id,
  event_type: 'preflight_hr_check',
  payload: { mission_id: mission.id, ...check },
});

if (!check.pass) {
  const healed = await selfHealSpec(mission, check, { sb });
  await appendAudit(sb, {
    workspace_id: mission.workspace_id,
    event_type: 'preflight_self_heal',
    payload: { mission_id: mission.id, attempts: healed.attempts, healed: healed.pass },
  });
  if (healed.pass) {
    mission.description = healed.new_description;
    await sb('PATCH', `/rest/v1/fabric_squad_missions?id=eq.${mission.id}`, {
      description: healed.new_description,
    });
  } else {
    res.statusCode = 412;
    return res.end(JSON.stringify({
      error: 'preflight_hr_violation',
      violations: check.violations,
      attempted_heal: healed.attempts,
    }));
  }
}
```

Add a fresh route handler alongside `/execute-mission`:

```js
if (req.method === 'POST' && url.pathname === '/intent-to-mission') {
  const body = await readJsonBody(req);
  try {
    const dispatch = async (m) => fetchInternal('POST', '/execute-mission', { mission_id: m.id });
    const result = await intentToMission(body, { sb, dispatch });
    res.statusCode = result.pass ? 200 : 412;
    return res.end(JSON.stringify(result));
  } catch (err) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: err.message }));
  }
}
```

`readJsonBody` and `fetchInternal` are assumed to exist in `server.js`. If not,
adapt to whatever request-parsing helper is already in use.

## 4. Install systemd timers

```bash
sudo install -m 0644 fabric/systemd/fabric-hr-postscan.service \
  /etc/systemd/system/fabric-hr-postscan.service
sudo install -m 0644 fabric/systemd/fabric-hr-postscan.timer \
  /etc/systemd/system/fabric-hr-postscan.timer
sudo install -m 0644 fabric/systemd/fabric-hr-learning.service \
  /etc/systemd/system/fabric-hr-learning.service
sudo install -m 0644 fabric/systemd/fabric-hr-learning.timer \
  /etc/systemd/system/fabric-hr-learning.timer

sudo install -d /etc/fabric /var/lib/fabric
sudo tee /etc/fabric/hr.env >/dev/null <<EOF
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
GH_TOKEN=...
EOF
sudo chmod 0600 /etc/fabric/hr.env

sudo systemctl daemon-reload
sudo systemctl enable --now fabric-hr-postscan.timer fabric-hr-learning.timer
systemctl status fabric-hr-postscan.timer fabric-hr-learning.timer
```

## 5. Verify

```bash
# Preflight dry-run against a known-bad spec
echo '{"workspace_id":"c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b","description":"Add TREASURY_PRIVATE_KEY env and KeyManager.signBtcTx for sweep cron."}' \
  | node /opt/veridian-fabric/fabric/bin/preflight.js --stdin
# Expect: { "pass": false, "violations": [{...HR-CUSTODY...}], ... }

# Audit tail
/opt/jarvisai/scripts/check-hr-audit.sh zettapay 10
```

## Rollback

Removing the patch is a single revert of the lines added to `server.js` and:

```bash
sudo systemctl disable --now fabric-hr-postscan.timer fabric-hr-learning.timer
```

The migration is forward-compatible — the new columns have safe defaults and do
not break callers that don't set them.
