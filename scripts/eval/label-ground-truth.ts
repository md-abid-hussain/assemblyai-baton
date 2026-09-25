/**
 * label-ground-truth.ts - auto-labels for kept takes (DESIGN §6.1), written with `reviewed:false`.
 *
 *   npx tsx --conditions=react-server scripts/eval/label-ground-truth.ts --calls pilot|chosen|all|<ids>
 *       [--force] [--retranscribe] [--dry-run] [--calls-dir …] [--scenarios-dir …] [--data-root …]
 *
 * Per take:
 *  1. A 2-channel WAV rebuilt locally from the split files (ch1 = rep, ch2 = customer) → AssemblyAI async,
 *     multichannel, universal-3-5-pro, keyterms = policy keyterms + the take's truth values (allowed for labelling
 *     only). ≈ $0.0035 per channel-minute. The transcript is kept in data/cache/asr/<callId>.json (re-used unless
 *     --retranscribe), so re-running the locator costs nothing on AssemblyAI.
 *  2. sol (effort low) locates first mentions, acknowledgements, the hand-off line + reply, diagnosis end, tail start.
 *  3. data/labels/<callId>.json (CallLabels, reviewed:false) + data/labels/<callId>.auto.json (flags for review).
 * A labels file that is already reviewed is never overwritten (even with --force: un-review it first).
 * Spend is recorded in the limits ledger (aai_async, openai).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { keytermsFromPolicy } from "../../src/core/aai/stt-params";
import { interleave } from "../../src/core/audio/pcm";
import { encodeWav } from "../../src/core/audio/wav-decode";
import type { Channel } from "../../src/core/contracts/case";
import type { LabelsAutoFile } from "../../src/core/contracts/ext/wp9-data";
import { equalizeChannels } from "../../src/core/scenario/assets";
import { planCalls, type PlannedCall } from "../../src/core/scenario/build";
import { intentSpecOf } from "../../src/core/scenario/intent-spec";
import type { KitScenario } from "../../src/core/scenario/kit";
import {
  buildLocatorInput, LOCATOR_FORMAT, LOCATOR_PROMPT, locatorFacts, resolveLabels, utterancesFromTranscript, type LocatorOutput, type TranscriptLike,
} from "../../src/core/scenario/labels";
import { stableJson } from "../../src/core/scenario/assets";
import { labelsAutoPath, labelsPath, loadKit, parseFlags, PILOT_SCENARIOS, readLabels, readSplit, resolvePaths, str, type PipelinePaths } from "../calls/lib/kit-io";

export const ASYNC_USD_PER_CHANNEL_SEC = 0.0035 / 60;

const asrPath = (dataRoot: string, callId: string) => join(dataRoot, "data", "cache", "asr", `${callId}.json`);

export function selectLabelTargets(calls: readonly PlannedCall[], which: string): PlannedCall[] {
  if (which === "all") return [...calls];
  if (which === "chosen") return calls.filter((c) => c.chosen);
  if (which === "pilot") return calls.filter((c) => c.chosen && (PILOT_SCENARIOS as readonly string[]).includes(c.entry.scenarioId));
  const ids = new Set(which.split(",").map((s) => s.trim()));
  return calls.filter((c) => ids.has(c.entry.callId) || ids.has(c.entry.scenarioId));
}

/** Labelling keyterms: the production policy keyterms + the take's truth values that are words (≤ 50 chars). */
export function labellingKeyterms(c: PlannedCall): string[] {
  const out = new Set(keytermsFromPolicy(c.scenario.policy));
  for (const v of Object.values(c.scenario.truth)) {
    if (!v || !/\p{L}/u.test(v) || v.length > 50 || v.split(/\s+/).length > 6 || /^\d{4}-\d{2}-\d{2}$/.test(v)) continue;
    out.add(v.replace(/_/g, " "));
  }
  return [...out].slice(0, 100);
}

async function transcribe(paths: PipelinePaths, c: PlannedCall, force: boolean): Promise<{ t: TranscriptLike; id: string | null; usd: number }> {
  const cached = asrPath(paths.dataRoot, c.entry.callId);
  if (!force && existsSync(cached)) {
    const j = JSON.parse(readFileSync(cached, "utf8")) as { id: string | null; utterances: TranscriptLike["utterances"] };
    return { t: { utterances: j.utterances }, id: j.id, usd: 0 };
  }
  const { AssemblyAIAsyncClient, billableSeconds } = await import("../../src/server/aai/async");
  const { loadEnv } = await import("../lib/load-env");
  const { getLimitsAuthority } = await import("../lib/limits");
  loadEnv();
  const key = process.env.ASSEMBLYAI_API_KEY?.trim();
  if (!key) throw new Error("ASSEMBLYAI_API_KEY missing (value never printed)");
  const pcm = readSplit(paths.callsDir, c.entry.callId);
  if (!pcm) throw new Error(`${c.entry.callId}: split WAVs missing`);
  const { rep, customer } = equalizeChannels(pcm.rep, pcm.customer);
  const wav = encodeWav(interleave(rep, customer), pcm.sampleRate, 2);
  const est = (rep.length / pcm.sampleRate) * 2 * ASYNC_USD_PER_CHANNEL_SEC;
  const ledger = getLimitsAuthority().ledger;
  const env = process.env.BATON_DEPLOY_ID ?? "dev-wp9";
  const res = await ledger.reserve({ provider: "aai_async", action: "wp9_label_asr", refId: c.entry.callId, estUsd: est, env });
  if (!res.ok) throw new Error(`ledger refused the async transcription (${res.code})`);
  try {
    const client = new AssemblyAIAsyncClient({ apiKey: key });
    const url = await client.upload(wav);
    const hinglish = c.entry.language === "hinglish";
    const t = await client.transcribe({
      audio_url: url,
      speech_models: ["universal-3-5-pro"],
      multichannel: true,
      punctuate: true,
      format_text: true,
      keyterms_prompt: labellingKeyterms(c),
      ...(hinglish ? { language_detection: true, language_detection_options: { expected_languages: ["en", "hi"], code_switching: true } } : { language_code: "en" }),
    });
    const usd = billableSeconds(t, true) * ASYNC_USD_PER_CHANNEL_SEC;
    await ledger.settle(res.id, usd);
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, stableJson({ id: t.id, audio_duration: t.audio_duration ?? null, audio_channels: t.audio_channels ?? null, utterances: t.utterances ?? [] }));
    return { t, id: t.id, usd };
  } catch (e) {
    await ledger.release(res.id).catch(() => undefined);
    throw e;
  }
}

async function locate(input: string): Promise<{ out: LocatorOutput; usd: number; model: string }> {
  const { createOpenAI, extractStructured, VERIFIER_MODEL } = await import("../../src/server/openai/client");
  const { usdOfSol } = await import("../../src/server/openai/verifier");
  const { loadEnv } = await import("../lib/load-env");
  const { getLimitsAuthority } = await import("../lib/limits");
  loadEnv();
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY missing (value never printed)");
  const ledger = getLimitsAuthority().ledger;
  const res = await ledger.reserve({ provider: "openai", action: "wp9_label_locate", refId: "labels", estUsd: 0.05, env: process.env.BATON_DEPLOY_ID ?? "dev-wp9" });
  if (!res.ok) throw new Error(`ledger refused the sol call (${res.code})`);
  try {
    const r = await extractStructured<LocatorOutput>(createOpenAI(key, { maxRetries: 1, timeoutMs: 180_000 }), {
      model: VERIFIER_MODEL,
      reasoningEffort: "low",
      instructions: LOCATOR_PROMPT,
      input,
      format: LOCATOR_FORMAT as unknown as { name: string; schema: Record<string, unknown>; strict: boolean },
      maxOutputTokens: 12_000,
      label: "wp9_labels",
    });
    const usd = usdOfSol(r.usage);
    await ledger.settle(res.id, usd);
    return { out: r.data, usd, model: VERIFIER_MODEL };
  } catch (e) {
    await ledger.release(res.id).catch(() => undefined);
    throw e;
  }
}

async function labelOne(paths: PipelinePaths, c: PlannedCall, kit: KitScenario, o: { retranscribe: boolean }): Promise<{ usd: { aai: number; openai: number }; flagged: number }> {
  const spec = intentSpecOf(kit.intent);
  if (!spec) throw new Error(`no intent spec for ${kit.intent}`);
  const { t, id, usd: aai } = await transcribe(paths, c, o.retranscribe);
  const utterances = utterancesFromTranscript(t);
  if (!utterances.length) throw new Error(`${c.entry.callId}: transcript has no utterances`);
  const statedBy: Partial<Record<string, Channel>> = Object.fromEntries(Object.entries(kit.facts).map(([f, fact]) => [f, fact.stated_by]));
  const input = buildLocatorInput({ facts: locatorFacts(c.scenario, spec, statedBy), handoffLine: kit.handoff.line, utterances });
  const { out, usd: openai, model } = await locate(input);
  const overridden = new Set([...Object.keys(c.sidecar.review.fact_overrides), ...Object.keys(c.sidecar.review.status_overrides)]);
  const { labels, items } = resolveLabels({ callId: c.entry.callId, scenario: c.scenario, spec, statedBy, overridden, utterances, located: out });
  const auto: LabelsAutoFile = {
    callId: c.entry.callId,
    scenarioId: c.entry.scenarioId,
    createdAt: new Date().toISOString(),
    transcriptId: id,
    model,
    items,
    utterances: utterances.map(({ words: _w, ...u }) => u),
    usd: { aai, openai },
  };
  writeFileSync(labelsPath(paths.dataRoot, c.entry.callId), stableJson(labels));
  writeFileSync(labelsAutoPath(paths.dataRoot, c.entry.callId), stableJson(auto));
  return { usd: { aai, openai }, flagged: items.filter((i) => i.flags.length).length };
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2), {
    calls: "string", force: "boolean", retranscribe: "boolean", "dry-run": "boolean", "calls-dir": "string", "scenarios-dir": "string", "data-root": "string",
  });
  const paths = resolvePaths({ callsDir: str(f["calls-dir"]), scenariosDir: str(f["scenarios-dir"]), dataRoot: str(f["data-root"]) });
  const kit = loadKit(paths);
  const takes = kit.sidecars.filter((s) => s.state === "downloaded").flatMap((sc) => {
    const pcm = readSplit(paths.callsDir, sc.base);
    return pcm ? [{ sidecar: sc, durationMs: Math.round((Math.max(pcm.rep.length, pcm.customer.length) / pcm.sampleRate) * 1000), labels: null }] : [];
  });
  const plan = planCalls({ scenarios: kit.scenarios, takes });
  const targets = selectLabelTargets(plan.calls, str(f.calls) ?? "pilot");
  mkdirSync(join(paths.dataRoot, "data", "labels"), { recursive: true });
  let total = { aai: 0, openai: 0 };
  for (const c of targets) {
    const existing = (() => {
      try {
        return readLabels(paths.dataRoot, c.entry.callId);
      } catch {
        return null;
      }
    })();
    if (existing?.reviewed) {
      console.log(`reviewed: ${c.entry.callId} (kept; un-review it with review-labels to relabel)`);
      continue;
    }
    if (existing && !f.force) {
      console.log(`labelled: ${c.entry.callId} (unreviewed; --force to relabel)`);
      continue;
    }
    if (f["dry-run"]) {
      console.log(`would label ${c.entry.callId} (${(c.entry.durationMs / 1000).toFixed(1)} s, ≈$${((c.entry.durationMs / 1000) * 2 * ASYNC_USD_PER_CHANNEL_SEC).toFixed(4)} AAI + ≈$0.03 sol)`);
      continue;
    }
    try {
      const r = await labelOne(paths, c, kit.scenarios.find((s) => s.id === c.entry.scenarioId)!, { retranscribe: f.retranscribe === true });
      total = { aai: total.aai + r.usd.aai, openai: total.openai + r.usd.openai };
      console.log(`labelled ${c.entry.callId}: ${r.flagged} item(s) flagged for review ($${r.usd.aai.toFixed(4)} AAI, $${r.usd.openai.toFixed(4)} OpenAI)`);
    } catch (e) {
      console.error(`FAILED ${c.entry.callId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`done: $${total.aai.toFixed(4)} AssemblyAI, $${total.openai.toFixed(4)} OpenAI. Next: scripts/eval/review-labels.ts`);
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
