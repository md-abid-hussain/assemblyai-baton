/**
 * paths.ts - every filesystem location the kit touches, resolved from this file (never from cwd),
 * so commands work no matter which directory you run them from.
 */
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** tools/recording-kit */
export const KIT_ROOT = resolve(HERE, "..");
/** repo root (C:/Users/abid1/Desktop/assembly-ai) */
export const REPO_ROOT = resolve(KIT_ROOT, "..", "..");
/** repo-root .env (read only, never written) */
export const ENV_PATH = resolve(REPO_ROOT, ".env");
/** tracked scenario ground truth */
export const SCENARIOS_DIR = resolve(REPO_ROOT, "data", "scenarios");
/** git-ignored call audio + sidecars */
export const CALLS_DIR = resolve(REPO_ROOT, "data", "calls");
export const RAW_DIR = resolve(CALLS_DIR, "raw");
export const SPLIT_DIR = resolve(CALLS_DIR, "split");
export const MANIFEST_PATH = resolve(CALLS_DIR, "manifest.json");
/** docs (role cards are generated here) */
export const DOCS_DIR = resolve(REPO_ROOT, "docs");
/** git-ignored participant phone numbers + consent */
export const PARTICIPANTS_PATH = resolve(KIT_ROOT, "participants.json");
export const PARTICIPANTS_EXAMPLE_PATH = resolve(KIT_ROOT, "participants.example.json");

/** Repo-relative path with forward slashes (what goes into sidecars). */
export function repoRel(p: string): string {
  return relative(REPO_ROOT, p).split(sep).join("/");
}

/** Resolve a repo-relative (forward-slash) path back to an absolute path. */
export function fromRepoRel(p: string): string {
  return resolve(REPO_ROOT, ...p.split("/"));
}
