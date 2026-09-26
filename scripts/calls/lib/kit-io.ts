/**
 * scripts/calls/lib/kit-io.ts - file IO shared by the WP9 scripts (calls:build, eval:cache-stt, labels, extraction).
 *
 * Input paths are configurable so the pipeline runs on today's real takes, on a synthetic take, or in a unit test:
 *   --calls-dir / BATON_CALLS_DIR        kit output (manifest.json, raw/*.json, split/*.wav). READ-ONLY.
 *                                        Default: <main checkout>/data/calls (a worktree under .wt/ reads the main
 *                                        checkout's recordings, because data/calls is git-ignored).
 *   --sim-takes-dir / BATON_SIM_TAKES_DIR  the same layout, holding takes WP9 GENERATED (scenario/sim-take.ts).
 *                                        Default: <repo>/data/sim-takes (committed: nobody's voice is in it).
 *                                        A simulated take is used only for a scenario with no usable real take, so
 *                                        the real recordings take over by themselves the moment the kit writes them.
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
import { isSimulatedTake, KitManifestSchema, KitScenarioSchema, KitSidecarSchema, parseKit, type KitScenario, type KitSidecar } from "../../../src/core/scenario/kit";
import { parseSttCacheJsonl } from "../../../src/core/scenario/stt-cache";

/** The 5 pilot takes (TASKS WP9 acceptance 3): the chosen takes of these scenarios (override: BATON_PILOT=s01,s02,…). */
export const PILOT_SCENARIOS: readonly string[] = (process.env.BATON_PILOT ?? "s01,s02,s03,s05,s10").split(",").map((s) => s.trim()).filter(Boolean);

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** `<main>/.wt/<name>` → `<main>`; any other path is returned unchanged. */
export function mainCheckoutOf(repoRoot: string): string {
  const m = /^(.*)[\\/]\.wt[\\/][^\\/]+[\\/]?$/.exec(repoRoot);
  return m ? m[1]! : repoRoot;
}

/** Any `.../data/calls`, in this checkout or another one. */
export const isRecordingKitDir = (dir: string): boolean => /(^|[\\/])data[\\/]calls[\\/]?$/i.test(resolve(dir));

/**
 * `data/calls` belongs to the recording kit and holds real people's voices: no Baton script ever writes into it
 * (DESIGN §3.1). The check is on the shape of the path, not on one known location, because a worktree, a temp dir
 * and the main checkout each have their own.
 */
export function assertNotRecordingKitDir(dir: string, what: string): void {
  if (isRecordingKitDir(dir)) throw new Error(`refusing to write ${what} into data/calls (the recording kit's own directory): ${resolve(dir)}`);
}

export interface PipelinePaths {
  repoRoot: string;
  callsDir: string;
  simTakesDir: string;
  scenariosDir: string;
  outRoot: string;
  dataRoot: string;
}

export interface PathOptions {
  callsDir?: string | undefined;
  simTakesDir?: string | undefined;
  scenariosDir?: string | undefined;
  outRoot?: string | undefined;
  dataRoot?: string | undefined;
  repoRoot?: string | undefined;
}

export function resolvePaths(o: PathOptions = {}, env: Readonly<Record<string, string | undefined>> = process.env): PipelinePaths {
  const repoRoot = resolve(o.repoRoot ?? REPO_ROOT);
  const pick = (flag: string | undefined, envKey: string, dflt: string): string => resolve(flag ?? env[envKey] ?? dflt);
  return {
    repoRoot,
    callsDir: pick(o.callsDir, "BATON_CALLS_DIR", join(mainCheckoutOf(repoRoot), "data", "calls")),
    simTakesDir: pick(o.simTakesDir, "BATON_SIM_TAKES_DIR", join(repoRoot, "data", "sim-takes")),
    scenariosDir: pick(o.scenariosDir, "BATON_SCENARIOS_DIR", join(repoRoot, "data", "scenarios")),
    outRoot: pick(o.outRoot, "BATON_OUT_ROOT", repoRoot),
    dataRoot: pick(o.dataRoot, "BATON_DATA_ROOT", repoRoot),
  };
}

// ------------------------------------------------------------------------------------------------ kit inputs

export interface KitInputs {
  scenarios: KitScenario[];
  /** Every parseable sidecar, sorted by base: the real takes, plus simulated stand-ins for scenarios with none. */
  sidecars: KitSidecar[];
  manifestChosen: Record<string, string | null> | undefined;
  /** Scenario ids whose take in `sidecars` is simulated (empty once the real ones are recorded). */
  simulatedScenarioIds: string[];
  warnings: string[];
}

/** Which input dir holds a take's `raw/` and `split/`: generated takes live apart from the recordings. */
export const takeDirOf = (p: Pick<PipelinePaths, "callsDir" | "simTakesDir">, sc: Pick<KitSidecar, "provenance">): string =>
  isSimulatedTake(sc) ? p.simTakesDir : p.callsDir;

/** A take the plan can use at all: downloaded and not thrown away. */
const isUsable = (sc: KitSidecar): boolean => sc.state === "downloaded" && sc.review.status !== "discard";

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

/** Kit scenarios: `sNN.json` only (`shared.json` and anything else is ignored). Throws on an invalid scenario. */
export function loadScenarios(scenariosDir: string): KitScenario[] {
  if (!existsSync(scenariosDir)) throw new Error(`scenarios dir not found: ${scenariosDir}`);
  return readdirSync(scenariosDir)
    .filter((f) => /^s\d{2}\.json$/.test(f))
    .sort()
    .map((f) => parseKit(KitScenarioSchema, readJson(join(scenariosDir, f)), `scenarios/${f}`));
}

/** Sidecars under `<dir>/raw/*.json`. A file that does not parse (the kit may be rewriting it) is a warning. */
function readSidecars(dir: string, label: string, warnings: string[]): KitSidecar[] {
  const rawDir = join(dir, "raw");
  if (!existsSync(rawDir)) return [];
  const out: KitSidecar[] = [];
  for (const f of readdirSync(rawDir).filter((x) => x.endsWith(".json")).sort()) {
    try {
      out.push(parseKit(KitSidecarSchema, readJson(join(rawDir, f)), `${label}/raw/${f}`));
    } catch (e) {
      warnings.push(`${label}/raw/${f}: skipped (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return out;
}

/** `<dir>/manifest.json` → scenario id → chosen take. */
function readManifestChosen(dir: string, label: string, warnings: string[]): Record<string, string | null> | undefined {
  const mPath = join(dir, "manifest.json");
  if (!existsSync(mPath)) return undefined;
  try {
    const m = parseKit(KitManifestSchema, readJson(mPath), `${label}/manifest.json`);
    return Object.fromEntries(m.scenarios.map((s) => [s.scenario_id, s.chosen_take]));
  } catch (e) {
    warnings.push(`${label}/manifest.json: ignored (${e instanceof Error ? e.message : String(e)})`);
    return undefined;
  }
}

/**
 * Sidecars + manifest. The calls dir must exist (a typo must not look like "no takes" and prune public/calls).
 *
 * Simulated takes (`simTakesDir`, optional) are a FALLBACK, per scenario: they are loaded only for scenarios that
 * have no usable real take, so recording s01 for real is all it takes for the generated s01 to disappear from
 * `calls.json`, `public/calls/` and the picker on the next `calls:build`.
 */
export function loadKit(p: Pick<PipelinePaths, "callsDir" | "scenariosDir"> & { simTakesDir?: string | undefined }): KitInputs {
  if (!existsSync(p.callsDir) || !statSync(p.callsDir).isDirectory()) throw new Error(`calls dir not found: ${p.callsDir} (set --calls-dir or BATON_CALLS_DIR)`);
  const warnings: string[] = [];
  const scenarios = loadScenarios(p.scenariosDir);
  const real = readSidecars(p.callsDir, "calls", warnings);
  const realBases = new Set(real.map((sc) => sc.base));

  const simDir = p.simTakesDir;
  const haveReal = new Set(real.filter(isUsable).map((sc) => sc.scenario?.id).filter((id): id is string => !!id));
  const sim: KitSidecar[] = [];
  const simulatedScenarioIds: string[] = [];
  if (simDir && simDir !== p.callsDir && existsSync(simDir) && statSync(simDir).isDirectory()) {
    for (const sc of readSidecars(simDir, "sim-takes", warnings)) {
      const id = sc.scenario?.id;
      if (!id) {
        warnings.push(`sim-takes/raw/${sc.base}.json: no scenario id; ignored`);
        continue;
      }
      if (haveReal.has(id)) continue; // a real take exists: the stand-in steps aside
      if (!isSimulatedTake(sc)) {
        warnings.push(`sim-takes/raw/${sc.base}.json: no provenance.kind "simulated"; ignored (generated takes must label themselves)`);
        continue;
      }
      if (realBases.has(sc.base)) {
        warnings.push(`${sc.base}: a real take has the same base; the simulated one is ignored`);
        continue;
      }
      sim.push(sc);
      if (!simulatedScenarioIds.includes(id)) simulatedScenarioIds.push(id);
    }
  }
  if (sim.length) warnings.push(`using ${sim.length} SIMULATED take(s) for ${simulatedScenarioIds.join(", ")}: no real recording yet (generated audio, labelled "simulated")`);

  const realChosen = readManifestChosen(p.callsDir, "calls", warnings);
  const simChosen = sim.length ? readManifestChosen(simDir!, "sim-takes", warnings) : undefined;
  let manifestChosen: Record<string, string | null> | undefined;
  if (realChosen || simChosen) {
    manifestChosen = { ...realChosen };
    // Only for scenarios the real manifest has nothing for, and only takes we actually loaded.
    const simBases = new Set(sim.map((s) => s.base));
    for (const [id, base] of Object.entries(simChosen ?? {})) if (base && !manifestChosen[id] && simBases.has(base)) manifestChosen[id] = base;
  }

  const sidecars = [...real, ...sim].sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
  return { scenarios, sidecars, manifestChosen, simulatedScenarioIds, warnings };
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
