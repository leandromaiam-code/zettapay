import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ServiceInfo {
  name: string;
  version: string;
}

let cached: ServiceInfo | null = null;

function readPackageJson(): ServiceInfo {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, "../../package.json"),
      resolve(here, "../../../package.json"),
    ];
    for (const path of candidates) {
      try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw) as { name?: string; version?: string };
        if (parsed.version) {
          return {
            name: parsed.name ?? "zettapay-api",
            version: parsed.version,
          };
        }
      } catch {
        // try next candidate
      }
    }
  } catch {
    // fall through
  }
  return { name: "zettapay-api", version: "0.0.0" };
}

export function getServiceInfo(): ServiceInfo {
  if (cached) return cached;
  cached = readPackageJson();
  return cached;
}
