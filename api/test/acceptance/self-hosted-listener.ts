// Z62: public acceptance check for the self-hosted listener install path.
// Reports {ok, checks: {...}} so anyone can verify, without authenticating,
// that the `@zettapay/listener` package is shippable end-to-end.
//
// Three checks:
//   1) npm_registry  — fetch registry.npmjs.org/@zettapay/listener; assert
//                       the manifest is reachable and lists a `latest` tag.
//   2) repo_artifacts — assert every deploy artifact (Dockerfile, README,
//                       LICENSE, package.json) referenced by the listener
//                       `files` whitelist is present in the repo so a
//                       `npm pack` from main would produce a complete tarball.
//   3) design_doc     — assert docs/architecture/self-hosted-listener-design.md
//                       is present and at least 1 KB (sanity for the gate doc
//                       Z55 mandates).
//
// No auth, no side effects, GET-only. Returns 200 when every check passes,
// 503 otherwise — mirrors the shape of /api/test/acceptance/btc-payment so
// the install wizard and HR-scan can poll either endpoint uniformly.

import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const PACKAGE_NAME = '@zettapay/listener';
const REGISTRY_URL = 'https://registry.npmjs.org/@zettapay%2Flistener';
const REGISTRY_TIMEOUT_MS = 5_000;

// Files that must exist in packages/listener/ for the published tarball to be
// useful. Matches the `files` whitelist in packages/listener/package.json.
const REQUIRED_LISTENER_FILES = [
  'package.json',
  'README.md',
  'LICENSE',
  'Dockerfile',
] as const;

const DESIGN_DOC_PATH = 'docs/architecture/self-hosted-listener-design.md';
const DESIGN_DOC_MIN_BYTES = 1024;

interface CheckResult {
  ok: boolean;
  detail?: unknown;
  [extra: string]: unknown;
}

function findRepoRoot(): string | null {
  let cursor = process.cwd();
  for (let i = 0; i < 8; i++) {
    try {
      readFileSync(join(cursor, 'package.json'), 'utf8');
      return cursor;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return null;
      cursor = parent;
    }
  }
  return null;
}

async function checkNpmRegistry(): Promise<CheckResult & { version?: string; published_at?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REGISTRY_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: ctrl.signal,
    });
    if (res.status === 404) {
      // Package not published yet — surface as a non-blocking "pending" rather
      // than a hard failure so the gate can be flipped the moment NPM_TOKEN
      // lands without re-deploying this function.
      return {
        ok: false,
        detail: { status: 404, reason: 'package_not_published_yet', name: PACKAGE_NAME },
      };
    }
    if (!res.ok) {
      return { ok: false, detail: { status: res.status, reason: 'registry_non_2xx' } };
    }
    const body = (await res.json()) as {
      'dist-tags'?: Record<string, string>;
      time?: Record<string, string>;
    };
    const version = body['dist-tags']?.latest;
    if (typeof version !== 'string' || version.length === 0) {
      return { ok: false, detail: { reason: 'missing_latest_tag', body } };
    }
    const publishedAt = body.time?.[version];
    return {
      ok: true,
      version,
      ...(publishedAt ? { published_at: publishedAt } : {}),
    };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

function checkRepoArtifacts(repoRoot: string): CheckResult & {
  present?: string[];
  missing?: string[];
} {
  const listenerRoot = join(repoRoot, 'packages/listener');
  const present: string[] = [];
  const missing: string[] = [];
  for (const rel of REQUIRED_LISTENER_FILES) {
    const abs = join(listenerRoot, rel);
    try {
      const stat = statSync(abs);
      if (stat.isFile() && stat.size > 0) {
        present.push(rel);
      } else {
        missing.push(rel);
      }
    } catch {
      missing.push(rel);
    }
  }
  return {
    ok: missing.length === 0,
    present,
    ...(missing.length > 0 ? { missing } : {}),
  };
}

function checkDesignDoc(repoRoot: string): CheckResult & { bytes?: number } {
  const abs = join(repoRoot, DESIGN_DOC_PATH);
  try {
    const stat = statSync(abs);
    if (!stat.isFile()) {
      return { ok: false, detail: 'design_doc_not_a_file', bytes: 0 };
    }
    if (stat.size < DESIGN_DOC_MIN_BYTES) {
      return {
        ok: false,
        detail: { reason: 'design_doc_too_small', min_bytes: DESIGN_DOC_MIN_BYTES },
        bytes: stat.size,
      };
    }
    return { ok: true, bytes: stat.size };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET only' } });
    return;
  }

  const startedAt = Date.now();
  const repoRoot = findRepoRoot();
  const checks: Record<string, CheckResult> = {};

  checks.check_1_npm_registry = await checkNpmRegistry();

  if (repoRoot) {
    checks.check_2_repo_artifacts = checkRepoArtifacts(repoRoot);
    checks.check_3_design_doc = checkDesignDoc(repoRoot);
  } else {
    checks.check_2_repo_artifacts = { ok: false, detail: 'repo_root_not_found' };
    checks.check_3_design_doc = { ok: false, detail: 'repo_root_not_found' };
  }

  const ok = Object.values(checks).every((c) => c.ok === true);
  const elapsedMs = Date.now() - startedAt;

  res.status(ok ? 200 : 503).json({
    ok,
    elapsed_ms: elapsedMs,
    package: PACKAGE_NAME,
    docs: 'https://github.com/leandromaiam-code/zettapay/tree/main/packages/listener#readme',
    checks,
  });
}
