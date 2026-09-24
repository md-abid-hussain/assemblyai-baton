/**
 * load-env.ts - load the repo-root `.env` into `process.env` for Node scripts (Next loads it by itself).
 *
 * - Uses Node's built-in parser (`util.parseEnv`); values already set in the shell win.
 * - Strips a trailing ` # comment` on unquoted values (the existing `.env` uses them).
 * - Empty values are skipped (so `POLAR_WEBHOOK_SECRET=` stays unset).
 * - Missing file is fine (Zerops has no .env; the bundle's migrate/cron read the container env).
 * - Never prints values.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

/** Repo root, found by walking up from this file (scripts/lib → repo), else cwd (bundled copies). */
export function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const fromFile = resolve(here, "..", "..");
  if (existsSync(resolve(fromFile, "package.json"))) return fromFile;
  return process.cwd();
}

/** Parse `.env` text into name → value (comments stripped, empties dropped). */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(parseEnv(text))) {
    const v = (raw ?? "").replace(/\s+#.*$/, "").trim();
    if (v !== "") out[k] = v;
  }
  return out;
}

const loadedPaths = new Set<string>();

/** Load `<repo>/.env` once (shell values win). Returns the names that were set, or null when there is no file. */
export function loadEnv(path = resolve(repoRoot(), ".env")): string[] | null {
  if (!existsSync(path)) return null;
  if (loadedPaths.has(path)) return [];
  loadedPaths.add(path);
  const set: string[] = [];
  for (const [k, v] of Object.entries(parseDotEnv(readFileSync(path, "utf8")))) {
    if (process.env[k] === undefined || process.env[k] === "") {
      process.env[k] = v;
      set.push(k);
    }
  }
  return set;
}
