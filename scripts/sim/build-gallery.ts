/**
 * scripts/sim/build-gallery.ts - build a gallery relay's pre-generated simulated call (PLATFORM §7.5, §7.5.3;
 * TASKS-v2 §6 WP17 T2). WP17·2.
 *
 *   npx tsx --conditions=react-server scripts/sim/build-gallery.ts [--relay dental-deposit] [--sample 0]
 *       [--write-script] [--stt] [--max-usd 0.15] [--dry-run] [--check]
 *
 * What it does, in order:
 *   1. loads `data/relays/<relay>.json` + `<relay>.presets.json`, parses both, applies every preset and records each
 *      variant's `blueprintHash` (the same audio serves them all: a preset changes only the AI half);
 *   2. the SCRIPT: `scripts/sim/scripts/<relay>.<sample>.json` if it exists, otherwise ONE live luna call
 *      (`generateSimScript`, RUN_LIVE=1) whose validated output is written there and committed. Committing the
 *      script is what makes the build reproducible: acceptance 1 ("a re-run with a warm cache is byte-identical
 *      and $0") cannot hold if the script is regenerated;
 *   3. the VOICES: `voiceSimCall` through the ledgered `TtsService` with the file clip cache
 *      (`scripts/sim/.cache/tts`, git-ignored), plus each preset's extra `answer:<field>` clip;
 *   4. the ASSETS: `public/calls/sim-<relay>/{rep.ulaw,customer.ulaw,peaks.json,clip.<sha256>.pcm}` (static files:
 *      gallery sims never touch the `/api/sim-calls` route) and the `GallerySimCall` entry in
 *      `src/generated/sim-calls.json`;
 *   5. `--stt`: the Express cache (DESIGN §5.1.6) - one live per-channel `pc_ctx` pass over the two µ-law channels
 *      through `runSttCache`, written as `public/data/cached-turns/<simCallId>.json`.
 *
 * Spend: OpenAI (script + TTS misses) and, with `--stt`, AssemblyAI. Everything is reserved and settled in the
 * ledger (env `dev-wp17`), and the run REFUSES to start if the worst case exceeds `--max-usd`. `--check` re-runs
 * steps 1, 3 and 4 against the committed files and fails on any difference; it needs no network on a warm cache.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { StreamingParams } from "../../src/core/aai/streaming";
import { checkBeginConfiguration, STT_INACTIVITY_TIMEOUT_S, STT_MODE, STT_PROMPT, STT_SPEECH_MODEL, TUNING_8K } from "../../src/core/aai/stt-params";
import type { GallerySimCall, SimAiClips, TtsClip } from "../../src/core/contracts/ext/wp17-sim";
import { GallerySimCallsSchema, simClipFile } from "../../src/core/contracts/ext/wp17-sim";
import type { SimScript } from "../../src/core/contracts/v2/api";
import { SimScriptSchema } from "../../src/core/contracts/v2/api";
import { BlueprintSchema, type Blueprint } from "../../src/core/contracts/v2/blueprint";
import { applyRelayPreset, parsePresetsFile, type RelayPreset } from "../../src/core/relay/draft/presets";
import { cachedTurnsFileOf, isCompleteCache } from "../../src/core/scenario/stt-cache";
import { runSttCache, estimateSttUsd, type OpenedChannel, type OpenedSessions, type RunnerSession } from "../../src/core/scenario/stt-run";
import { createOpenAI } from "../../src/server/openai/client";
import { generateSimScript, validateSimScript } from "../../src/server/openai/sim-script";
import { normalizeTtsText, ttsCostUsd, TtsService } from "../../src/server/openai/tts";
import { simCallIdFor, voiceSimCall } from "../../src/server/sim/generate";
import { simManifestEntry } from "../../src/server/sim/store";
import { voiceFor } from "../../src/server/sim/voices";
import { getLimitsAuthority } from "../lib/limits";
import { loadEnv, repoRoot } from "../lib/load-env";
import { blueprintHash } from "./lib/blueprint-hash";
import { FsTtsCache } from "./lib/fs-tts-cache";

const ENV = "dev-wp17";
const SALT = "gallery";
/** Where the AI half's clips and the two channels are served from (static, not the API route). */
const publicDirOf = (slug: string): string => `calls/sim-${slug}`;

interface Flags {
  relay: string;
  sample: number;
  writeScript: boolean;
  stt: boolean;
  maxUsd: number;
  dryRun: boolean;
  check: boolean;
}

function parseArgs(argv: readonly string[]): Flags {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : null;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  return {
    relay: get("relay") ?? "dental-deposit",
    sample: Number(get("sample") ?? "0"),
    writeScript: has("write-script"),
    stt: has("stt"),
    maxUsd: Number(get("max-usd") ?? "0.15"),
    dryRun: has("dry-run"),
    check: has("check"),
  };
}

function fail(msg: string): never {
  console.error(`[build-gallery] FAIL: ${msg}`);
  process.exit(1);
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

function writeFileAtomic(path: string, bytes: Uint8Array | string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

const same = (path: string, bytes: Uint8Array | string): boolean =>
  existsSync(path) && Buffer.from(readFileSync(path)).equals(Buffer.from(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes));

// ------------------------------------------------------------------------------------------- Express STT cache

/**
 * The per-channel `pc_ctx` params for a SIM: the production shape (`buildSttParams`, DESIGN §5.1.5) with the
 * relay's own keyterms and scenario prompt instead of Baton's policy. 8 kHz µ-law, so the TUNING_8K turn silences
 * apply, exactly as on a recorded take.
 */
export function simSttParams(bp: Pick<Blueprint, "listening">, sample: Blueprint["context"]["samples"][number]): StreamingParams {
  const ctx = new Set<string>();
  for (const path of bp.listening.contextKeyterms) {
    const [head, ...rest] = path.split(".");
    const key = rest.join(".");
    if (head === "customer") ctx.add(key === "fullName" ? `${sample.customer.firstName} ${sample.customer.lastName}` : key === "firstName" ? sample.customer.firstName : sample.customer.lastName);
    else if (head === "org") ctx.add(key === "name" ? sample.org.name : sample.org.repFirstName);
    else if (head === "fact") ctx.add(sample.facts[key] ?? "");
    else if (head === "table") {
      const [table, column] = key.split(".");
      for (const row of sample.tables[table ?? ""] ?? []) ctx.add(row[column ?? ""] ?? "");
    }
  }
  const keyterms = [...new Set([...bp.listening.keyterms, ...ctx])].filter((k) => k.trim().length > 0).map((k) => k.slice(0, 50)).slice(0, 100);
  return {
    speech_model: STT_SPEECH_MODEL,
    encoding: "pcm_mulaw",
    sample_rate: 8000,
    mode: STT_MODE,
    inactivity_timeout: STT_INACTIVITY_TIMEOUT_S,
    keyterms_prompt: keyterms,
    prompt: (bp.listening.scenarioPrompt || STT_PROMPT).slice(0, 1750),
    min_turn_silence: TUNING_8K.min_turn_silence,
    max_turn_silence: TUNING_8K.max_turn_silence,
  } as StreamingParams;
}

async function buildExpressCache(i: { callId: string; rep: Uint8Array; customer: Uint8Array; params: StreamingParams; durationMs: number }): Promise<{ path: string; billedSec: number; finals: number }> {
  const { openStreamingPair } = await import("../lib/aai-open");
  const adapt = (h: { session: import("../../src/core/aai/streaming").StreamingSession; close(): Promise<{ session_duration_seconds?: number } | null> }): OpenedChannel => {
    const check = checkBeginConfiguration(h.session.begin);
    if (!check.ok) throw new Error(`Begin.configuration mismatch: ${check.mismatches.join("; ")}`);
    const s = h.session;
    const session: RunnerSession = {
      on: (_t, fn) => s.on("message", (m) => fn(m as Record<string, unknown>)),
      sendAudio: (f) => s.sendAudio(f),
      updateConfiguration: (patch) => s.updateConfiguration(patch),
      begin: { ...(s.begin as unknown as Record<string, unknown>), id: s.begin.id },
    };
    return { session, close: () => h.close(), params: i.params as unknown as Record<string, unknown> };
  };
  const open = async (): Promise<OpenedSessions> => {
    const pair = await openStreamingPair({ label: "wp17_gallery_sim", maxDurationMs: i.durationMs + 60_000, source: "script", rep: i.params, customer: i.params });
    try {
      return { rep: adapt(pair.rep), customer: adapt(pair.customer) };
    } catch (e) {
      await pair.close();
      throw e;
    }
  };
  const r = await runSttCache(
    { callId: i.callId, variant: "pc_ctx", audio: { rep: i.rep, customer: i.customer }, ctxCarry: "last_rep_turn" },
    {
      open,
      now: () => performance.now(),
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      isoNow: () => new Date().toISOString(),
      onProgress: ({ sentMs, totalMs }) => process.stdout.write(`\r  stt ${Math.floor((sentMs / totalMs) * 100)}%   `),
    },
  );
  process.stdout.write("\n");
  if (!isCompleteCache(r.records, "pc_ctx")) throw new Error("the STT run finished without trailers");
  const file = cachedTurnsFileOf(i.callId, r.records);
  const path = join(repoRoot(), "public", "data", "cached-turns", `${i.callId}.json`);
  writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
  return {
    path,
    billedSec: Object.values(r.meta).reduce((s, m) => s + (m?.billedSeconds ?? 0), 0),
    finals: file.channels.rep.length + file.channels.customer.length,
  };
}

// ------------------------------------------------------------------------------------------- main

async function main(): Promise<void> {
  loadEnv();
  const f = parseArgs(process.argv.slice(2));
  const root = repoRoot();

  // 1. the relay and its presets -------------------------------------------------------------
  const bp = BlueprintSchema.parse(readJson(join(root, "data", "relays", `${f.relay}.json`)));
  if (bp.meta.slug !== f.relay) fail(`the blueprint's slug is "${bp.meta.slug}", not "${f.relay}"`);
  const sample = bp.context.samples[f.sample];
  if (!sample) fail(`sample ${f.sample} does not exist`);
  const presetsPath = join(root, "data", "relays", `${f.relay}.presets.json`);
  const presets: RelayPreset[] = existsSync(presetsPath) ? parsePresetsFile(readJson(presetsPath), f.relay).presets : [];
  const baseHash = blueprintHash(bp);
  const variants = presets.map((p) => {
    const variant = BlueprintSchema.parse(applyRelayPreset(bp, p));
    return { presetId: p.id, blueprintHash: blueprintHash(variant), preset: p };
  });
  // A gallery sim is a static file: `CallCatalog` resolves it by slug + hash, never by a relay id (which is
  // per-database), so the id stays empty here.
  const relay = { relayId: "", slug: bp.meta.slug, title: bp.meta.title, blueprintHash: baseHash };
  const simCallId = simCallIdFor({ kind: "audio", versionKey: `${bp.meta.slug}@${baseHash}`, sampleIndex: f.sample, salt: SALT });
  console.log(`relay ${relay.slug} (${baseHash.slice(0, 12)}…) sample ${f.sample} → ${simCallId}`);
  for (const v of variants) console.log(`  preset ${v.presetId} → ${v.blueprintHash.slice(0, 12)}…`);

  // 2. the script ------------------------------------------------------------------------------
  const scriptPath = join(root, "scripts", "sim", "scripts", `${f.relay}.${f.sample}.json`);
  let script: SimScript;
  let scriptUsd = 0;
  if (existsSync(scriptPath) && !f.writeScript) {
    script = SimScriptSchema.parse(readJson(scriptPath));
    const v = validateSimScript(script, { blueprint: bp, sampleIndex: f.sample });
    if (!v.ok) fail(`the committed script no longer passes validation: ${v.issues.join("; ")}`);
    console.log(`script: ${scriptPath} (${script.turns.length} turns, ${v.chars} chars, cached)`);
  } else {
    if (f.check) fail("--check needs the committed script");
    if (f.dryRun) {
      console.log(`dry run: no committed script at ${scriptPath}; a live run would write one (one luna call, ≈ $0.001) and then voice it`);
      return;
    }
    if (process.env.RUN_LIVE !== "1") fail("no committed script: set RUN_LIVE=1 to write one (one luna call, ≈ $0.001)");
    const key = process.env.OPENAI_API_KEY?.trim();
    if (!key) fail("OPENAI_API_KEY is not set (value never printed)");
    const client = createOpenAI(key, { maxRetries: 0, timeoutMs: 60_000 });
    const ledger = getLimitsAuthority().ledger;
    const r = await generateSimScript(
      { openai: () => client, ledger: () => ledger, env: () => ENV },
      { blueprint: bp, sampleIndex: f.sample, refId: simCallId },
    );
    script = r.script;
    scriptUsd = r.usd;
    console.log(`script: luna, attempt ${r.attempts}, ${r.chars} chars, handoff similarity ${r.handoffSimilarity?.toFixed(2) ?? "n/a"}, $${r.usd.toFixed(5)}, ${r.ms} ms`);
    writeFileAtomic(scriptPath, `${JSON.stringify(script, null, 2)}\n`);
    console.log(`       written to ${scriptPath} (commit it: the build is only reproducible with it)`);
  }

  // 3. the voices ------------------------------------------------------------------------------
  const presetAnswers = variants.flatMap((v) => v.preset.sim.answers.map((a) => ({ ...a, presetId: v.presetId })));
  const worstTexts = [
    ...script.turns.map((t) => t.text),
    "Yes, that's right.",
    script.consent_phrase,
    script.closing_phrase,
    ...script.ai_half_answers.map((a) => a.spoken),
    ...presetAnswers.map((a) => a.spoken),
  ];
  const worstUsd = worstTexts.reduce((s, t) => s + ttsCostUsd(normalizeTtsText(t)), 0) + (f.stt ? estimateSttUsd("pc_ctx", 90_000) : 0);
  console.log(`worst case if nothing is cached: $${worstUsd.toFixed(4)} (cap $${f.maxUsd.toFixed(2)})`);
  if (worstUsd > f.maxUsd) fail(`worst-case spend exceeds --max-usd ${f.maxUsd}`);
  if (f.dryRun) {
    console.log("dry run: nothing built");
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) fail("OPENAI_API_KEY is not set (value never printed)");
  const client = createOpenAI(apiKey, { maxRetries: 0, timeoutMs: 30_000 });
  const cache = new FsTtsCache(join(root, "scripts/sim/.cache/tts"));
  const ledger = getLimitsAuthority().ledger;
  const tts = new TtsService({ openai: () => client, cache, ledger: () => ledger, env: () => ENV });

  const voiced = await voiceSimCall(tts, {
    simCallId, script, blueprint: bp, sampleIndex: f.sample, relay, relayVersionId: `gallery:${relay.slug}`, gallery: true, scriptUsd,
  });
  const clips = new Map<string, TtsClip>(voiced.clips);
  const aiClips: SimAiClips = { ...voiced.row.aiClips };
  if (presetAnswers.length) {
    const voice = voiceFor("customer", bp.playbook.persona.tone, sample);
    const extra = await tts.synthMany(presetAnswers.map((a) => ({ text: a.spoken, ...voice, refId: simCallId })));
    presetAnswers.forEach((a, i) => {
      const c = extra[i]!;
      if (!clips.has(c.hash)) clips.set(c.hash, c);
      aiClips[`answer:${a.field}`] = { hash: c.hash, text: normalizeTtsText(a.spoken), durationMs: c.durationMs };
    });
  }
  const ttsUsd = [...clips.values()].reduce((s, c) => s + c.usd, 0);
  const misses = [...clips.values()].filter((c) => !c.cached).length;
  const a = voiced.assembled;
  console.log(`voiced: ${clips.size} clips (${misses} miss${misses === 1 ? "" : "es"}), call ${(a.durationMs / 1000).toFixed(1)} s, handoff ${JSON.stringify(a.handoff)}, $${ttsUsd.toFixed(5)}`);
  if (f.check && misses > 0) fail(`--check re-voiced ${misses} clip(s): the build is not reproducible from the committed script`);

  // 4. the static assets and the manifest -------------------------------------------------------
  const rel = publicDirOf(relay.slug);
  const dir = join(root, "public", rel);
  const url = (file: string): string => `/${rel}/${file}`;
  const files = new Map<string, Uint8Array | string>([
    ["rep.ulaw", a.rep],
    ["customer.ulaw", a.customer],
    ["peaks.json", `${JSON.stringify(a.peaks)}\n`],
  ]);
  // Only the AI half's clips are served on their own: the human half is the two µ-law channels (the line clips
  // stay in the build cache, so a re-run is still $0 and byte-identical).
  for (const hash of new Set(Object.values(aiClips).map((c) => c.hash))) {
    const c = clips.get(hash);
    if (!c) fail(`clip ${hash} was not voiced`);
    files.set(simClipFile(hash), c.pcm24k);
  }

  const entry = simManifestEntry({ id: simCallId, durationMs: a.durationMs, handoff: a.handoff, script: voiced.row.script });
  const gallery: GallerySimCall = {
    id: simCallId,
    relay,
    sampleIndex: f.sample,
    entry: { ...entry, assets: { rep: url("rep.ulaw"), customer: url("customer.ulaw"), peaks: url("peaks.json") } },
    aiClips: Object.fromEntries(Object.entries(aiClips).map(([k, c]) => [k, { ...c, url: url(simClipFile(c.hash)) }])),
    timeline: a.timeline,
    variants: variants.map((v) => ({ presetId: v.presetId, blueprintHash: v.blueprintHash })),
  };
  const manifestPath = join(root, "src", "generated", "sim-calls.json");
  const existing = GallerySimCallsSchema.parse(readJson(manifestPath));
  const manifest = [...existing.filter((g) => !(g.relay.slug === relay.slug && g.sampleIndex === f.sample)), gallery]
    .sort((x, y) => (x.relay.slug === y.relay.slug ? x.sampleIndex - y.sampleIndex : x.relay.slug < y.relay.slug ? -1 : 1));
  const manifestJson = `${JSON.stringify(GallerySimCallsSchema.parse(manifest), null, 2)}\n`;

  const changed: string[] = [];
  for (const [name, bytes] of files) if (!same(join(dir, name), bytes)) changed.push(`${rel}/${name}`);
  if (!same(manifestPath, manifestJson)) changed.push("src/generated/sim-calls.json");
  if (f.check) {
    const stale = existsSync(dir) ? readdirSync(dir).filter((n) => !files.has(n)) : [];
    if (changed.length || stale.length) fail(`--check: ${[...changed, ...stale.map((s) => `stale ${rel}/${s}`)].join(", ")}`);
    console.log(`check: ${files.size + 1} files identical`);
  } else {
    mkdirSync(dir, { recursive: true });
    for (const [name, bytes] of files) writeFileAtomic(join(dir, name), bytes);
    for (const stale of readdirSync(dir).filter((n) => !files.has(n))) {
      rmSync(join(dir, stale));
      console.log(`  removed stale ${rel}/${stale}`);
    }
    writeFileAtomic(manifestPath, manifestJson);
    console.log(`assets: public/${rel}/ (${files.size} files), src/generated/sim-calls.json${changed.length ? "" : " (unchanged)"}`);
  }

  // 5. the Express cache -------------------------------------------------------------------------
  let stt: { path: string; billedSec: number; finals: number } | null = null;
  const turnsPath = join(root, "public", "data", "cached-turns", `${simCallId}.json`);
  if (f.stt && !f.check) {
    if (existsSync(turnsPath)) {
      console.log(`express cache: ${turnsPath} (already built; delete it to re-run)`);
    } else if (process.env.RUN_LIVE !== "1") {
      fail("--stt needs RUN_LIVE=1 (one live AssemblyAI pass over the two channels)");
    } else {
      process.env.BATON_DEPLOY_ID ??= ENV;
      stt = await buildExpressCache({ callId: simCallId, rep: a.rep, customer: a.customer, params: simSttParams(bp, sample), durationMs: a.durationMs });
      console.log(`express cache: ${stt.finals} finals, ${stt.billedSec.toFixed(1)} s billed → ${stt.path}`);
    }
  } else if (!existsSync(turnsPath)) {
    console.log(`express cache: NOT built (run with --stt); Express prefill will re-transcribe at case creation`);
  }

  console.log(JSON.stringify({
    ok: true, simCallId, relay: relay.slug, blueprintHash: baseHash, variants: gallery.variants, sampleIndex: f.sample,
    turns: script.turns.length, humanChars: voiced.humanChars, durationMs: a.durationMs, handoff: a.handoff,
    clips: clips.size, aiClipKeys: Object.keys(aiClips).sort(), changed,
    spendUsd: { script: Number(scriptUsd.toFixed(6)), tts: Number(ttsUsd.toFixed(6)) },
    expressCache: stt ? { finals: stt.finals, billedSec: Number(stt.billedSec.toFixed(1)) } : null,
  }));
}

main().catch((e: unknown) => {
  console.error("[build-gallery] error:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exit(1);
});
