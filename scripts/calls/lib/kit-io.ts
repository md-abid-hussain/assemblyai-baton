/**
 * scripts/calls/lib/kit-io.ts - file IO shared by the WP9 scripts (calls:build, eval:cache-stt, labels, extraction).
 *
 * Input paths are configurable so the pipeline runs on today's real takes, on a synthetic take, or in a unit test:
 *   --calls-dir / BATON_CALLS_DIR        kit output (manifest.json, raw/*.json, split/*.wav). READ-ONLY.
 *                                        Default: <main checkout>/data/calls (a worktree under .wt/ reads the main
 *                                        checkout's recordings, because data/calls is git-ignored).
 *   --scenarios-dir / BATON_SCENARIOS_DIR  kit scenarios (data/scenarios/sNN.json). Default: <repo>/data/scenarios.
 *   --out / BATON_OUT_ROOT               where src/generated, public/calls, public/data/cached-turns go. Default: <repo>.
 *   --data-root / BATON_DATA_ROOT        where data/{labels,cache} live. Default: <repo>.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeWav } from "../../../src/core/audio/wav-decode";
import { deinterleave } from "../../../src/core/audio/pcm";
import type { SttCacheRecord, SttVariant } from "../../../src/core/contracts/eval";
import { CallLabelsSchema, type CallLabels } from "../../../src/core/contracts/scenario";
import type { ChannelPcm } from "../../../src/core/scenario/assets";
import { KitManifestSchema, KitScenarioSchema, KitSidecarSchema, parseKit, type KitScenario, type KitSidecar } from "../../../src/core/scenario/kit";
import { parseSttCacheJsonl } from "../../../src/core/scenario/stt-cache";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** `<main>/.wt/<name>` → `<main>`; any other path is returned unchanged. */
export function mainCheckoutOf(repoRoot: string): string {
  const m = /^(.*)[\\/]\.wt[\\/][^\\/]+[\\/]?$/.exec(repoRoot);
  return m ? m[1]! : repoRoot;
}

export interface PipelinePaths {
  repoRoot: string;
  callsDir: string;
  scenariosDir: string;
  outRoot: string;
  dataRoot: string;
}

export interface PathOptions {
  callsDir?: string | undefined;
  scenariosDir?: string | undefined;
  outRoot?: string | undefined;
  dataRoot?: string | undefined;
  repoRoot?: string | undefined;
}

export function resolvePaths(o: PathOptions = {}, env: NodeJS.ProcessEnv = process.env): PipelinePaths {
  const repoRoot = resolve(o.repoRoot ?? REPO_ROOT);
  const pick = (flag: string | undefined, envKey: string, dflt: string): string => resolve(flag ?? env[envKey] ?? dflt);
  return {
    repoRoot,
    callsDir: pick(o.callsDir, "BATON_CALLS_DIR", join(mainCheckoutOf(repoRoot), "data", "calls")),
    scenariosDir: pick(o.scenariosDir, "BATON_SCENARIOS_DIR", join(repoRoot, "data", "scenarios")),
    outRoot: pick(o.outRoot, "BATON_OUT_ROOT", repoRoot),
    dataRoot: pick(o.dataRoot, "BATON_DATA_ROOT", repoRoot),
  };
}

// ------------------------------------------------------------------------------------------------ kit inputs

export interface KitInputs {
  scenarios: KitScenario[];
  /** Every parseable sidecar, sorted by base. */
  sidecars: KitSidecar[];
  manifestChosen: Record<string, string | null> | undefined;
  warnings: string[];
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

/** Kit scenarios: `sNN.json` only (`shared.json` and anything else is ignored). Throws on an invalid scenario. */
export function loadScenarios(scenariosDir: string): KitScenario[] {
  if (!existsSync(scenariosDir)) throw new Error(`scenarios dir not found: ${scenariosDir}`);
  return readdirSync(scenariosDir)
    .filter((f) => /^s\d{2}\.json$/.test(f))
    .sort()
    .map((f) => parseKit(KitScenarioSchema, readJson(join(scenariosDir, f)), `scenarios/${f}`));
}

/**
 * Sidecars + manifest. The calls dir must exist (a typo must not look like "no takes" and prune public/calls).
 * A sidecar that does not parse (e.g. the kit is rewriting it right now) is a warning, not a failure.
 */
export function loadKit(p: Pick<PipelinePaths, "callsDir" | "scenariosDir">): KitInputs {
  if (!existsSync(p.callsDir) || !statSync(p.callsDir).isDirectory()) throw new Error(`calls dir not found: ${p.callsDir} (set --calls-dir or BATON_CALLS_DIR)`);
  const warnings: string[] = [];
  const scenarios = loadScenarios(p.scenariosDir);
  const rawDir = join(p.callsDir, "raw");
  const sidecars: KitSidecar[] = [];
  if (existsSync(rawDir)) {
    for (const f of readdirSync(rawDir).filter((x) => x.endsWith(".json")).sort()) {
      try {
        sidecars.push(parseKit(KitSidecarSchema, readJson(join(rawDir, f)), `raw/${f}`));
      } catch (e) {
        warnings.push(`raw/${f}: skipped (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }
  let manifestChosen: Record<string, string | null> | undefined;
  const mPath = join(p.callsDir, "manifest.json");
  if (existsSync(mPath)) {
    try {
      const m = parseKit(KitManifestSchema, readJson(mPath), "manifest.json");
      manifestChosen = Object.fromEntries(m.scenarios.map((s) => [s.scenario_id, s.chosen_take]));
    } catch (e) {
      warnings.push(`manifest.json: ignored (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return { scenarios, sidecars, manifestChosen, warnings };
}

/** `split/<base>_{rep,customer}.wav` (PCM16 mono 8 kHz), or null when either file is missing. */
export function readSplit(callsDir: string, base: string): ChannelPcm | null {
  const read = (role: "rep" | "customer") => {
    const path = join(callsDir, "split", `${base}_${role}.wav`);
    if (!existsSync(path)) return null;
    const w = decodeWav(new Uint8Array(readFileSync(path)));
    return { samples: w.channels === 1 ? w.samples : deinterleave(w.samples, w.channels)[0]!, rate: w.sampleRate };
  };
  const rep = read("rep");
  const customer = read("customer");
  if (!rep || !customer) return null;
  if (rep.rate !== customer.rate) throw new Error(`${base}: rep and customer split WAVs differ in sample rate`);
  return { rep: rep.samples, customer: customer.samples, sampleRate: rep.rate };
}

// ------------------------------------------------------------------------------------------------ WP9 data

export const labelsPath = (dataRoot: string, callId: string): string => join(dataRoot, "data", "labels", `${callId}.json`);
export const labelsAutoPath = (dataRoot: string, callId: string): string => join(dataRoot, "data", "labels", `${callId}.auto.json`);
export const sttCachePath = (dataRoot: string, callId: string, variant: SttVariant): string => join(dataRoot, "data", "cache", "stt", callId, `${variant}.jsonl`);
export const extractCachePath = (dataRoot: string, callId: string, version: string, variant: SttVariant): string =>
  join(dataRoot, "data", "cache", "extract", callId, `${version}.${variant}.json`);
export const verifyCachePath = (dataRoot: string, callId: string, variant: SttVariant): string => join(dataRoot, "data", "cache", "verify", `${callId}.${variant}.json`);

export function readLabels(dataRoot: string, callId: string): CallLabels | null {
  const p = labelsPath(dataRoot, callId);
  if (!existsSync(p)) return null;
  return parseKit(CallLabelsSchema, readJson(p), `data/labels/${callId}.json`);
}

export function readSttCache(dataRoot: string, callId: string, variant: SttVariant): SttCacheRecord[] | null {
  const p = sttCachePath(dataRoot, callId, variant);
  if (!existsSync(p)) return null;
  return parseSttCacheJsonl(readFileSync(p, "utf8"), `data/cache/stt/${callId}/${variant}.jsonl`);
}

// ------------------------------------------------------------------------------------------------ writing

export const sha256HexOf = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** Write only when the content differs (idempotent builds leave mtimes alone). Returns true when written. */
export function writeIfChanged(path: string, data: Uint8Array | string): boolean {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (existsSync(path)) {
    const cur = readFileSync(path);
    if (cur.equals(bytes)) return false;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return true;
}

/** Remove every entry of `dir` whose name is not in `keep`. Returns the removed names. */
export function pruneDir(dir: string, keep: ReadonlySet<string>): string[] {
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (keep.has(name)) continue;
    rmSync(join(dir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** Minimal `--flag value` / `--flag` parser (scripts take few options; unknown flags are an error). */
export function parseFlags(argv: readonly string[], known: Record<string, "string" | "boolean">): Record<string, string | boolean | undefined> {
  const out: Record<string, string | boolean | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const [name, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
    const kind = known[name];
    if (!kind) throw new Error(`unknown flag --${name} (known: ${Object.keys(known).map((k) => `--${k}`).join(" ")})`);
    if (kind === "boolean") out[name] = inline === undefined ? true : inline !== "false";
    else {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`--${name} needs a value`);
      out[name] = v;
    }
  }
  return out;
}

export const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);
