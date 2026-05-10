#!/usr/bin/env node
// Exports the canonical OpenAPI spec from @zettapay/api to disk in two
// flavors: the source-of-truth 3.1 document and a 3.0.3 downconvert that
// keeps openapi-generator templates (python/go/rust/php/etc.) happy.
//
// Run: `npm run openapi:export` (after `npm run -w @zettapay/api build`).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const apiDist = resolve(repoRoot, "packages/api/dist/lib/openapi.js");

const { getOpenApiDocument, getOpenApi30Document } = await import(
  `file://${apiDist}`
);

const targets = [
  {
    file: resolve(repoRoot, "docs/api-reference/openapi.json"),
    doc: getOpenApiDocument(),
    label: "3.1.0",
  },
  {
    file: resolve(repoRoot, "docs/api-reference/openapi-3.0.json"),
    doc: getOpenApi30Document(),
    label: "3.0.3",
  },
];

for (const { file, doc, label } of targets) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(doc, null, 2) + "\n", "utf8");
  process.stdout.write(`wrote ${label} -> ${file}\n`);
}
