/**
 * cache-stt.ts - `npm run eval:cache-stt` (DESIGN §6.2): live Streaming STT once per take × variant, cached as
 * `data/cache/stt/<callId>/<variant>.jsonl`.
 *
 *   RUN_LIVE=1 BATON_DEPLOY_ID=dev-wp9 npm run eval:cache-stt -- --calls all|<id,id,…>|chosen|pilot
 *       [--variants pc_ctx,pc_noctx[,mono_diar]] [--max-usd 0.50] [--speed 1] [--force] [--dry-run]
 *       [--calls-dir …] [--scenarios-dir …] [--data-root …]
 *
 * - Every open goes through scripts/lib/aai-open.ts (limits authority: the laptop file guard, or the Zerops authority
 *   with LIMITS_ROLE=remote), rep + customer as ONE n=2 grant, always Terminate. SERIAL (one call at a time).
 * - Audio = the take's split WAVs → µ-law, byte-identical to public/calls (§6.2). Params = WP4's `buildSttParams`
 *   (the production per-channel params); `mono_diar` adds speaker_labels + max_speakers 2 on the downmix.
 * - Takes with `twilio.recording_channels !== 2` are excluded from every per-channel variant (§6.2).
 * - Resumable: a complete cache (trailers present) is skipped unless --force. Written atomically (tmp + rename).
 * - Budget: stops BEFORE a call × variant whose list-price estimate would exceed --max-usd (default $0.50).
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import type { StreamingParams } from "../../src/core/aai/streaming";
import { buildSttParams, checkBeginConfiguration } from "../../src/core/aai/stt-params";
import { mulawDecodeSample, mulawEncodeSample } from "../../src/core/audio/mulaw";
import { STT_VARIANTS, type SttVariant } from "../../src/core/contracts/eval";
import type { Scenario } from "../../src/core/contracts/scenario";
import { takeAudioOf } from "../../src/core/scenario/assets";
import { planCalls, type PlannedCall } from "../../src/core/scenario/build";
import { isCompleteCache, serializeSttCacheRecord } from "../../src/core/scenario/stt-cache";
import { downmixUlaw, estimateSttUsd, runSttCache, type OpenedChannel, type OpenedSessions, type RunnerSession } from "../../src/core/scenario/stt-run";
import { loadKit, parseFlags, PILOT_SCENARIOS, readSplit, readSttCache, resolvePaths, str, sttCachePath, type PipelinePaths } from "../calls/lib/kit-io";


export interface CacheTarget {
  call: PlannedCall;
  variant: SttVariant;
  estUsd: number;
}

/** Which (take, variant) pairs to run: per-channel variants never on MONO takes (§6.2). */
export function selectTargets(calls: readonly PlannedCall[], which: string, variants: readonly SttVariant[], durationMs: (c: PlannedCall) => number): { targets: CacheTarget[]; skipped: string[] } {
  const skipped: string[] = [];
  let chosen: PlannedCall[];
  if (which === "all") chosen = [...calls];
  else if (which === "chosen") chosen = calls.filter((c) => c.chosen);
  else if (which === "pilot") chosen = calls.filter((c) => c.chosen && (PILOT_SCENARIOS as readonly string[]).includes(c.entry.scenarioId));
  else {
    const ids = new Set(which.split(",").map((s) => s.trim()).filter(Boolean));
    chosen = calls.filter((c) => ids.has(c.entry.callId) || ids.has(c.entry.scenarioId));
    for (const id of ids) if (!calls.some((c) => c.entry.callId === id || c.entry.scenarioId === id)) skipped.push(`${id}: no usable take`);
  }
  const targets: CacheTarget[] = [];
  for (const c of chosen) {
    if (c.sidecar.review.status === "discard") continue;
    for (const v of variants) {
      if (v === "pc_ctx_8k") {
        skipped.push(`${c.entry.callId} ${v}: golden 16 kHz calls only`);
        continue;
      }
      if (v !== "mono_diar" && !c.dualChannel) {
        skipped.push(`${c.entry.callId} ${v}: not a 2-channel recording (excluded from per-channel variants)`);
        continue;
      }
      targets.push({ call: c, variant: v, estUsd: estimateSttUsd(v, durationMs(c)) });
    }
  }
  return { targets, skipped };
}

type VariantParams = { rep: StreamingParams; customer: StreamingParams } | { mono: StreamingParams };

function paramsFor(scenario: Scenario, entry: PlannedCall["entry"], variant: SttVariant): VariantParams {
  const rep = buildSttParams(entry, scenario.policy, "rep");
  const customer = buildSttParams(entry, scenario.policy, "customer");
  if (variant !== "mono_diar") return { rep, customer };
  // Mono: one session; Hinglish when either party speaks it; diarization on (§6.2).
  const base = customer.language_codes ? customer : rep;
  return { mono: { ...base, speaker_labels: true, max_speakers: 2 } };
}

async function runOne(paths: PipelinePaths, t: CacheTarget, o: { speed: number }): Promise<{ usd: number; billed: number }> {
  const { openStreaming, openStreamingPair, STT_USD_PER_SEC } = await import("../lib/aai-open");
  const e = t.call.entry;
  const pcm = readSplit(paths.callsDir, e.callId);
  if (!pcm) throw new Error(`${e.callId}: split WAVs missing`);
  const audio = takeAudioOf(pcm);
  const params = paramsFor(t.call.scenario, e, t.variant);
  const maxDurationMs = Math.ceil(audio.durationMs / o.speed) + 60_000;
  const adapt = (h: { session: import("../../src/core/aai/streaming").StreamingSession; close(): Promise<{ session_duration_seconds?: number } | null> }, p: Record<string, unknown>): OpenedChannel => {
    const check = checkBeginConfiguration(h.session.begin);
    if (!check.ok) throw new Error(`Begin.configuration mismatch: ${check.mismatches.join("; ")}`);
    const s = h.session;
    const session: RunnerSession = {
      on: (_t, fn) => s.on("message", (m) => fn(m as Record<string, unknown>)),
      sendAudio: (f) => s.sendAudio(f),
      updateConfiguration: (patch) => s.updateConfiguration(patch),
      begin: { ...(s.begin as unknown as Record<string, unknown>), id: s.begin.id },
    };
    return { session, close: () => h.close(), params: p };
  };
  const open = async (): Promise<OpenedSessions> => {
    const common = { label: `wp9_cache_stt_${t.variant}`, maxDurationMs, source: "script" as const };
    if ("mono" in params) {
      const h = await openStreaming({ ...common, params: params.mono });
      try {
        return { mono: adapt(h, params.mono as unknown as Record<string, unknown>) };
      } catch (err) {
        await h.close();
        throw err;
      }
    }
    const pair = await openStreamingPair({ ...common, rep: params.rep, customer: params.customer });
    try {
      return { rep: adapt(pair.rep, params.rep as unknown as Record<string, unknown>), customer: adapt(pair.customer, params.customer as unknown as Record<string, unknown>) };
    } catch (err) {
      await pair.close();
      throw err;
    }
  };
  const input =
    t.variant === "mono_diar"
      ? { mono: downmixUlaw(audio.ulaw.rep, audio.ulaw.customer, mulawDecodeSample, mulawEncodeSample) }
      : { rep: audio.ulaw.rep, customer: audio.ulaw.customer };
  let lastPct = -1;
  const r = await runSttCache(
    { callId: e.callId, variant: t.variant, audio: input, ctxCarry: t.variant === "pc_ctx" ? "last_rep_turn" : "none", speed: o.speed },
    {
      open,
      now: () => performance.now(),
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      isoNow: () => new Date().toISOString(),
      onProgress: ({ sentMs, totalMs }) => {
        const pct = Math.floor((sentMs / totalMs) * 10) * 10;
        if (pct !== lastPct) process.stdout.write(`${pct}% `);
        lastPct = pct;
      },
    },
  );
  process.stdout.write("\n");
  if (!isCompleteCache(r.records, t.variant)) throw new Error(`${e.callId} ${t.variant}: run finished without trailers`);
  const out = sttCachePath(paths.dataRoot, e.callId, t.variant);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.tmp`, `${r.records.map(serializeSttCacheRecord).join("\n")}\n`);
  renameSync(`${out}.tmp`, out);
  const billed = Object.values(r.meta).reduce((s, m) => s + (m?.billedSeconds ?? 0), 0);
  const finals = r.records.filter((x) => x.message["type"] === "Turn" && x.message["end_of_turn"] === true).length;
  console.log(`  ${e.callId} ${t.variant}: ${r.records.length} messages, ${finals} finals, ${r.agentContextUpdates} agent_context updates, billed ${billed.toFixed(1)} s → ${out}`);
  return { usd: billed * STT_USD_PER_SEC, billed };
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2), {
    calls: "string", variants: "string", "max-usd": "string", speed: "string", force: "boolean", "dry-run": "boolean",
    "calls-dir": "string", "scenarios-dir": "string", "data-root": "string",
  });
  const paths = resolvePaths({ callsDir: str(f["calls-dir"]), scenariosDir: str(f["scenarios-dir"]), dataRoot: str(f["data-root"]) });
  const variants = (str(f.variants) ?? "pc_ctx,pc_noctx").split(",").map((v) => v.trim()) as SttVariant[];
  for (const v of variants) if (!(STT_VARIANTS as readonly string[]).includes(v)) throw new Error(`unknown variant ${v}`);
  const maxUsd = Number(str(f["max-usd"]) ?? "0.5");
  const speed = Number(str(f.speed) ?? "1");
  if (!(speed > 0 && speed <= 4)) throw new Error("--speed must be in (0, 4]");

  const kit = loadKit(paths);
  const durations = new Map<string, number>();
  const takes = kit.sidecars.filter((s) => s.state === "downloaded").flatMap((sc) => {
    const pcm = readSplit(paths.callsDir, sc.base);
    if (!pcm) return [];
    const d = takeAudioOf(pcm).durationMs;
    durations.set(sc.base, d);
    return [{ sidecar: sc, durationMs: d, labels: null }];
  });
  const plan = planCalls({ scenarios: kit.scenarios, takes });
  const { targets, skipped } = selectTargets(plan.calls, str(f.calls) ?? "chosen", variants, (c) => durations.get(c.entry.callId) ?? 0);
  for (const s of skipped) console.log(`skip: ${s}`);

  const todo = targets.filter((t) => {
    if (f.force) return true;
    try {
      const recs = readSttCache(paths.dataRoot, t.call.entry.callId, t.variant);
      if (recs && isCompleteCache(recs, t.variant)) {
        console.log(`cached: ${t.call.entry.callId} ${t.variant}`);
        return false;
      }
    } catch {
      /* unreadable → redo */
    }
    return true;
  });
  const est = todo.reduce((s, t) => s + t.estUsd, 0);
  console.log(`${todo.length} run(s), estimated $${est.toFixed(3)} at list price (cap $${maxUsd.toFixed(2)}); calls dir ${paths.callsDir}`);
  if (f["dry-run"]) {
    for (const t of todo) console.log(`  would run ${t.call.entry.callId} ${t.variant} (${((durations.get(t.call.entry.callId) ?? 0) / 1000).toFixed(1)} s, ≈$${t.estUsd.toFixed(4)})`);
    return;
  }
  if (process.env.RUN_LIVE !== "1") throw new Error("refusing to open live STT sessions without RUN_LIVE=1 (use --dry-run to preview)");
  process.env.BATON_DEPLOY_ID ??= "dev-wp9";

  let spent = 0;
  let committed = 0;
  for (const t of todo) {
    if (committed + t.estUsd > maxUsd) {
      console.log(`budget: stopping before ${t.call.entry.callId} ${t.variant} (committed ≈$${committed.toFixed(3)} + $${t.estUsd.toFixed(4)} > $${maxUsd.toFixed(2)})`);
      break;
    }
    committed += t.estUsd;
    console.log(`run ${t.call.entry.callId} ${t.variant} (≈$${t.estUsd.toFixed(4)})`);
    try {
      const r = await runOne(paths, t, { speed });
      spent += r.usd;
    } catch (e) {
      console.error(`  FAILED ${t.call.entry.callId} ${t.variant}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`done: billed ≈$${spent.toFixed(4)} (list price)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
