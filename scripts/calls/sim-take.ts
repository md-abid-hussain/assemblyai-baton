/**
 * sim-take.ts - generate a SIMULATED take in the recording-kit's format, so the Baton flagship path works before
 * the recording session happens (WP9·2 fallback; PLATFORM P7, §7.5.3).
 *
 *   npx tsx --conditions=react-server scripts/calls/sim-take.ts --scenarios s01[,s02] --dry-run
 *   RUN_LIVE=1 BATON_DEPLOY_ID=dev-wp9 npx tsx --conditions=react-server scripts/calls/sim-take.ts \
 *       --scenarios s01,s02 [--max-usd 0.15] [--out data/sim-takes] [--force] [--at <iso>]
 *
 * Steps, per scenario:
 *   1. gpt-6-luna writes the two-party dialogue from data/scenarios/<id>.json (facts, beats, the rep hand-off line
 *      and the customer's acceptance). The hand-off line is then forced to the scenario's exact wording.
 *   2. gpt-4o-mini-tts-2025-12-15 voices every turn: `cedar` for the rep, `marin` for the customer.
 *   3. The clips are laid out on one call clock and written per channel at 8 kHz, plus the interleaved "raw" file
 *      and a sidecar carrying `provenance.kind = "simulated"`.
 *   4. `data/labels/<callId>.json` is written straight off the timeline: exact `lineStartMs/lineEndMs/acceptStartMs`
 *      (Express needs them), `reviewed: false` and NO invented word-level mentions, so the take is never `inEval`.
 *
 * Output goes to `data/sim-takes/` - never `data/calls/`, which is the recording kit's and holds real voices.
 * `calls:build` uses a simulated take only for a scenario with no usable real take, so the recordings take over by
 * themselves. Spend is reserved and settled in the limits ledger; nothing runs without RUN_LIVE=1.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { peakDbfs, rmsDbfs } from "../../src/core/audio/pcm";
import { encodeWav } from "../../src/core/audio/wav-decode";
import { KitScenarioSchema, parseKit, type KitScenario, type KitRole } from "../../src/core/scenario/kit";
import { stableJson } from "../../src/core/scenario/assets";
import {
  clipDurationMs, enforceHandoff, joinPcm, planSimTimeline, simBase, simChannelsOf, simLabels, simScriptInput, simSidecar, simStereoOf,
  SIM_PROVENANCE_DETAIL, SIM_RATE, SIM_SCRIPT_INSTRUCTIONS, SIM_SCRIPT_JSON_SCHEMA, SIM_SCRIPT_MODEL, SIM_TTS_MODEL, SIM_TTS_RATE, SIM_VOICES,
  SimScriptSchema, trimClip, type SimClip, type SimScript, type SimTurn,
} from "../../src/core/scenario/sim-take";
import { assertNotRecordingKitDir, parseFlags, REPO_ROOT, sha256HexOf, str } from "./lib/kit-io";
import { writeManifest } from "./synthetic-take";

type OpenAI = import("openai").default;
type Ledger = import("../../src/core/contracts/services").LimitsAuthority["ledger"];

/** List price of the models this script uses (research/10 §3.2; WP17's tts.ts for the TTS rates). */
export const SCRIPT_USD_PER_INPUT_TOKEN = 0.4 / 1_000_000;
export const SCRIPT_USD_PER_OUTPUT_TOKEN = 1.6 / 1_000_000;
export const TTS_USD_PER_REQUEST = 0.0004;
export const TTS_USD_PER_CHAR = 16 / 1_000_000;

/** A rough but honest pre-flight estimate, so --dry-run can refuse an over-budget run before spending anything. */
export function estimateScenarioUsd(scenario: KitScenario, o: { turns?: number; charsPerTurn?: number } = {}): number {
  const turns = o.turns ?? ((scenario as { talk_track?: unknown[] }).talk_track?.length ?? 16);
  const chars = turns * (o.charsPerTurn ?? 140);
  const script = 4000 * SCRIPT_USD_PER_INPUT_TOKEN + 900 * SCRIPT_USD_PER_OUTPUT_TOKEN;
  return script + turns * TTS_USD_PER_REQUEST + chars * TTS_USD_PER_CHAR;
}

/** Per-turn tone direction. Kept short: gpt-4o-mini-tts follows a sentence better than a paragraph. */
export function ttsInstructionsFor(scenario: KitScenario, who: KitRole): string {
  const style = who === "rep" ? (scenario.rep as { style?: string }).style : undefined;
  const base =
    who === "rep"
      ? "A friendly insurance agent on a recorded service call. Calm, unhurried, clear with numbers and dates."
      : "A customer on the phone from home. Natural, a little informal, warm.";
  return `${base}${style ? ` ${style}.` : ""} Telephone audio: plain delivery, no announcer voice, no music.`;
}

export interface SimDeps {
  client?: OpenAI;
  ledger?: Ledger;
  /** Override for tests: returns PCM16 @ 24 kHz for one turn. */
  speak?: (o: { text: string; voice: string; instructions: string }) => Promise<Int16Array>;
  /** Override for tests: returns the script the writer produced, plus what it cost. */
  write?: (scenario: KitScenario, targetSeconds: number) => Promise<{ script: SimScript; usd: number }>;
  log?: (line: string) => void;
}

async function openaiClient(deps: SimDeps): Promise<OpenAI> {
  if (deps.client) return deps.client;
  const { createOpenAI } = await import("../../src/server/openai/client");
  const { loadEnv } = await import("../lib/load-env");
  loadEnv();
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY missing (value never printed)");
  return createOpenAI(key, { maxRetries: 1, timeoutMs: 60_000 });
}

/** Step 1: the dialogue. */
async function writeScript(client: OpenAI, scenario: KitScenario, targetSeconds: number): Promise<{ script: SimScript; usd: number }> {
  const { extractStructured } = await import("../../src/server/openai/client");
  const r = await extractStructured<unknown>(client, {
    model: SIM_SCRIPT_MODEL,
    reasoningEffort: "none",
    temperature: 0.7,
    instructions: SIM_SCRIPT_INSTRUCTIONS,
    input: simScriptInput(scenario, { targetSeconds }),
    format: { name: "sim_call_script", schema: SIM_SCRIPT_JSON_SCHEMA, strict: true },
    maxOutputTokens: 3000,
    label: `wp9_sim_script_${scenario.id}`,
  });
  const script = SimScriptSchema.parse(r.data);
  const usd = r.usage.input_tokens * SCRIPT_USD_PER_INPUT_TOKEN + r.usage.output_tokens * SCRIPT_USD_PER_OUTPUT_TOKEN;
  return { script, usd };
}

/** Step 2: one TTS request per turn, serially (no burst against the rate limit). */
async function speakTurns(
  client: OpenAI,
  scenario: KitScenario,
  turns: readonly SimTurn[],
  deps: SimDeps,
): Promise<{ clips: SimClip[]; usd: number; chars: number }> {
  const { openSpeechPcmStream } = await import("../../src/server/openai/client");
  const { bytesToPcm16 } = await import("../../src/core/audio/pcm");
  const clips: SimClip[] = [];
  let usd = 0;
  let chars = 0;
  for (const t of turns) {
    const instructions = ttsInstructionsFor(scenario, t.who);
    const voice = SIM_VOICES[t.who];
    let samples: Int16Array;
    if (deps.speak) samples = await deps.speak({ text: t.text, voice, instructions });
    else {
      const { chunks } = await openSpeechPcmStream(client, {
        input: t.text,
        voice,
        instructions,
        model: SIM_TTS_MODEL,
        signal: AbortSignal.timeout(60_000),
      });
      const parts: Int16Array[] = [];
      for await (const c of chunks) parts.push(bytesToPcm16(c.pcm));
      samples = joinPcm(parts);
    }
    if (samples.length === 0) throw new Error(`TTS returned no audio for turn "${t.text.slice(0, 40)}"`);
    clips.push({ samples: trimClip(samples, { rate: SIM_TTS_RATE }), rate: SIM_TTS_RATE });
    chars += t.text.length;
    usd += TTS_USD_PER_REQUEST + t.text.length * TTS_USD_PER_CHAR;
  }
  return { clips, usd, chars };
}

export interface SimTakeResult {
  scenarioId: string;
  callId: string;
  durationMs: number;
  turns: number;
  repairs: string[];
  handoffMs: { lineStartMs: number; acceptStartMs: number | null };
  usd: { script: number; tts: number };
  files: string[];
}

export interface BuildSimTakeOptions {
  scenariosDir: string;
  outDir: string;
  dataRoot: string;
  scenarioId: string;
  at: string;
  take?: number;
  deps?: SimDeps;
}

/** Generate one simulated take end to end and write it, its sidecar, the manifest and its labels. */
export async function buildSimTake(o: BuildSimTakeOptions): Promise<SimTakeResult> {
  const deps = o.deps ?? {};
  const log = deps.log ?? (() => undefined);
  const scenarioFile = join(o.scenariosDir, `${o.scenarioId}.json`);
  if (!existsSync(scenarioFile)) throw new Error(`scenario not found: ${scenarioFile}`);
  const scenarioText = readFileSync(scenarioFile, "utf8");
  const scenario = parseKit(KitScenarioSchema, JSON.parse(scenarioText), `scenarios/${o.scenarioId}.json`);
  const target = (scenario as { target_duration_s?: { min: number; max: number } }).target_duration_s;
  const targetSeconds = Math.round(((target?.min ?? 75) + (target?.max ?? 120)) / 2);

  const client = deps.write && deps.speak ? (undefined as unknown as OpenAI) : await openaiClient(deps);
  log(`  writing the script (${SIM_SCRIPT_MODEL}, target ≈${targetSeconds}s)…`);
  const written = deps.write ? await deps.write(scenario, targetSeconds) : await writeScript(client, scenario, targetSeconds);
  const checked = enforceHandoff(written.script, scenario);
  for (const r of checked.repairs) log(`  repair: ${r}`);
  log(`  voicing ${checked.script.turns.length} turns (${SIM_TTS_MODEL}: rep=${SIM_VOICES.rep}, customer=${SIM_VOICES.customer})…`);
  const spoken = await speakTurns(client, scenario, checked.script.turns, deps);

  const timeline = planSimTimeline(checked.script.turns, spoken.clips.map((c) => clipDurationMs(c.samples, c.rate)));
  const channels = simChannelsOf(timeline, spoken.clips);
  const durationMs = Math.round((channels.rep.length / SIM_RATE) * 1000);

  const base = simBase(o.scenarioId, o.at);
  const outDir = resolve(o.outDir);
  assertNotRecordingKitDir(outDir, "a simulated take");
  mkdirSync(join(outDir, "raw"), { recursive: true });
  mkdirSync(join(outDir, "split"), { recursive: true });
  const rel = relative(REPO_ROOT, outDir).split("\\").join("/") || "data/sim-takes";
  const files = [
    [join(outDir, "raw", `${base}.wav`), encodeWav(simStereoOf(channels), SIM_RATE, 2)],
    [join(outDir, "split", `${base}_rep.wav`), encodeWav(channels.rep, SIM_RATE, 1)],
    [join(outDir, "split", `${base}_customer.wav`), encodeWav(channels.customer, SIM_RATE, 1)],
  ] as const;
  for (const [path, bytes] of files) writeFileSync(path, bytes);

  const round1 = (n: number): number => Math.round(n * 10) / 10;
  const sidecar = simSidecar({
    scenario,
    base,
    take: o.take ?? 1,
    at: o.at,
    durationMs,
    scenarioSha256: sha256HexOf(scenarioText),
    fileDir: rel,
    rmsDbfs: { rep: round1(rmsDbfs(channels.rep)), customer: round1(rmsDbfs(channels.customer)) },
    peakDbfs: { rep: round1(peakDbfs(channels.rep)), customer: round1(peakDbfs(channels.customer)) },
  });
  writeFileSync(join(outDir, "raw", `${base}.json`), stableJson(sidecar));
  writeManifest(outDir, o.scenariosDir);

  // The script, kept next to the take so the exact words are reviewable without listening to the audio.
  const scriptDir = join(outDir, "scripts");
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(
    join(scriptDir, `${base}.json`),
    stableJson({
      callId: base,
      scenarioId: o.scenarioId,
      provenance: SIM_PROVENANCE_DETAIL,
      scriptModel: SIM_SCRIPT_MODEL,
      ttsModel: SIM_TTS_MODEL,
      voices: SIM_VOICES,
      repairs: checked.repairs,
      handoffIndex: checked.handoffIndex,
      acceptIndex: checked.acceptIndex,
      turns: timeline.turns.map((t) => ({ index: t.index, beat: t.beat, who: t.who, startMs: t.startMs, endMs: t.endMs, text: t.text })),
    }),
  );

  const labels = simLabels(base, timeline, checked.handoffIndex, checked.acceptIndex);
  const labelsDir = join(o.dataRoot, "data", "labels");
  mkdirSync(labelsDir, { recursive: true });
  writeFileSync(join(labelsDir, `${base}.json`), stableJson(labels));

  return {
    scenarioId: o.scenarioId,
    callId: base,
    durationMs,
    turns: timeline.turns.length,
    repairs: checked.repairs,
    handoffMs: { lineStartMs: labels.handoff!.lineStartMs, acceptStartMs: labels.handoff!.acceptStartMs },
    usd: { script: written.usd, tts: spoken.usd },
    files: [...files.map(([p]) => p), join(outDir, "raw", `${base}.json`), join(labelsDir, `${base}.json`)],
  };
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2), {
    scenarios: "string", out: "string", "scenarios-dir": "string", "data-root": "string",
    "max-usd": "string", at: "string", "dry-run": "boolean", force: "boolean",
  });
  const scenariosDir = resolve(str(f["scenarios-dir"]) ?? join(REPO_ROOT, "data", "scenarios"));
  const outDir = resolve(str(f.out) ?? join(REPO_ROOT, "data", "sim-takes"));
  const dataRoot = resolve(str(f["data-root"]) ?? REPO_ROOT);
  const ids = (str(f.scenarios) ?? "s01").split(",").map((s) => s.trim()).filter(Boolean);
  const maxUsd = Number(str(f["max-usd"]) ?? "0.15");
  const at = str(f.at) ?? "2026-09-25T11:00:00.000Z";

  const scenarios = ids.map((id) => {
    const p = join(scenariosDir, `${id}.json`);
    if (!existsSync(p)) throw new Error(`scenario not found: ${p}`);
    return parseKit(KitScenarioSchema, JSON.parse(readFileSync(p, "utf8")), `scenarios/${id}.json`);
  });
  const est = scenarios.map((s) => ({ id: s.id, usd: estimateScenarioUsd(s) }));
  const total = est.reduce((a, b) => a + b.usd, 0);
  console.log(`simulated takes: ${est.map((e) => `${e.id} ≈$${e.usd.toFixed(4)}`).join(", ")}  (total ≈$${total.toFixed(4)}, cap $${maxUsd.toFixed(2)})`);
  console.log(`out: ${outDir}   labels: ${join(dataRoot, "data", "labels")}`);
  if (total > maxUsd) throw new Error(`estimate $${total.toFixed(4)} exceeds --max-usd ${maxUsd.toFixed(2)}`);
  if (f["dry-run"]) return;
  if (process.env.RUN_LIVE !== "1") throw new Error("refusing to call OpenAI without RUN_LIVE=1 (use --dry-run to preview)");

  const { getLimitsAuthority } = await import("../lib/limits");
  const ledger = getLimitsAuthority().ledger;
  const env = process.env.BATON_DEPLOY_ID ?? "dev-wp9";
  let spent = 0;
  for (const s of scenarios) {
    const existing = existsSync(join(outDir, "raw")) && !f.force
      ? (await import("node:fs")).readdirSync(join(outDir, "raw")).some((n) => n.startsWith(`${s.id}_sim_`) && n.endsWith(".json"))
      : false;
    if (existing) {
      console.log(`${s.id}: a simulated take already exists (use --force to regenerate); skipped`);
      continue;
    }
    const one = est.find((e) => e.id === s.id)!.usd;
    if (spent + one > maxUsd) {
      console.log(`budget: stopping before ${s.id} at $${spent.toFixed(4)}`);
      break;
    }
    const res = await ledger.reserve({ provider: "openai", action: "wp9_sim_take", refId: s.id, estUsd: one * 1.5, env });
    if (!res.ok) throw new Error(`ledger refused (${res.code})`);
    try {
      console.log(`${s.id}: generating…`);
      const r = await buildSimTake({ scenariosDir, outDir, dataRoot, scenarioId: s.id, at, deps: { log: (l) => console.log(l) } });
      const usd = r.usd.script + r.usd.tts;
      await ledger.settle(res.id, usd);
      spent += usd;
      console.log(
        `${s.id}: ${r.callId}  ${(r.durationMs / 1000).toFixed(1)}s, ${r.turns} turns, ` +
          `hand-off at ${(r.handoffMs.lineStartMs / 1000).toFixed(1)}s, accept at ` +
          `${r.handoffMs.acceptStartMs === null ? "none" : `${(r.handoffMs.acceptStartMs / 1000).toFixed(1)}s`}, ` +
          `$${usd.toFixed(4)} (script $${r.usd.script.toFixed(4)} + tts $${r.usd.tts.toFixed(4)})`,
      );
    } catch (e) {
      await ledger.release(res.id).catch(() => undefined);
      throw e;
    }
  }
  console.log(`done: $${spent.toFixed(4)} OpenAI. Now run: npm run calls:build`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
