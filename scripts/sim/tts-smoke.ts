/**
 * scripts/sim/tts-smoke.ts - WP17·1 live check of the TTS module and the sim assembler (TASKS-v2 §7: ≤ $0.05 OpenAI,
 * $0 AssemblyAI). Needs RUN_LIVE=1 and OPENAI_API_KEY (never printed).
 *
 *   1. voice an 8-turn script (rep cedar, customer marin, the exact handoff line) plus the 4 AI-half clips through
 *      the real `TtsService` (pinned gpt-4o-mini-tts-2025-12-15, pcm 24 kHz), every miss reserved and settled from
 *      the character count in the ledger (env dev-wp17), clips cached in scripts/sim/.cache/tts;
 *   2. assemble the stereo 8 kHz mu-law call, check the timeline, register it in a memory store and resolve it;
 *   3. re-voice on the warm cache: must be $0 and byte-identical;
 *   4. one `stream_format:"sse"` request to read the `speech.audio.done` usage (calibrates the per-char rate);
 *   5. write <out>/sim-smoke.wav (stereo: left rep, right customer) for listening.
 *
 *   RUN_LIVE=1 npx tsx --conditions=react-server scripts/sim/tts-smoke.ts [--out <dir>] [--no-sse]
 *   (--no-sse skips step 4; on a warm clip cache the run is then $0)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeWav, interleave, mulawDecode } from "../../src/core/audio";
import type { SimScript } from "../../src/core/contracts/v2/api";
import type { Blueprint } from "../../src/core/contracts/v2/blueprint";
import { createOpenAI } from "../../src/server/openai/client";
import { normalizeTtsText, ttsCostUsd, TtsService, TTS_MODEL } from "../../src/server/openai/tts";
import { simCallIdFor, voiceSimCall } from "../../src/server/sim/generate";
import { MemorySimCallStore } from "../../src/server/sim/store";
import { CUSTOMER_INSTRUCTIONS } from "../../src/server/sim/voices";
import { getLimitsAuthority } from "../lib/limits";
import { loadEnv, repoRoot } from "../lib/load-env";
import { FsTtsCache } from "./lib/fs-tts-cache";

const ENV = "dev-wp17";
const MAX_USD = 0.05;
/** List prices (DESIGN §7.1), only to compare with the char-based settlement. */
const USD_PER_TEXT_TOKEN = 0.6 / 1e6;
const USD_PER_AUDIO_TOKEN = 12 / 1e6;

const REP_LINE = "OK if my assistant finishes the booking? I'll stay on the line.";
const blueprint = {
  handoff: { repLine: REP_LINE },
  playbook: { persona: { tone: "Warm, upbeat and efficient." } },
  context: { samples: [{ customer: { firstName: "Maya", lastName: "Ortiz", phoneLast4: "4417" }, org: { name: "BrightSmile Dental", repFirstName: "Dana" }, callDate: "2026-09-25", facts: {}, tables: {} }] },
} as unknown as Pick<Blueprint, "handoff" | "playbook" | "context">;
const script: SimScript = {
  turns: [
    { speaker: "rep", text: "Thanks for calling BrightSmile Dental, this is Dana.", tag: "greet" },
    { speaker: "customer", text: "Hi, I need to book a cleaning.", tag: "other" },
    { speaker: "rep", text: "Sure. What's your full name?", tag: "ask" },
    { speaker: "customer", text: "Maya Ortiz.", tag: "answer" },
    { speaker: "rep", text: "And which day works for you?", tag: "ask" },
    { speaker: "customer", text: "Tuesday morning.", tag: "answer" },
    { speaker: "rep", text: REP_LINE, tag: "handoff" },
    { speaker: "customer", text: "Sure, go ahead.", tag: "accept" },
  ],
  left_for_ai: ["insurance_carrier"],
  ai_half_answers: [{ field: "insurance_carrier", spoken: "It's BrightSmile Plus." }],
  consent_phrase: "Yes, please text me the link.",
  closing_phrase: "No, that's everything, thanks.",
};
const SSE_TEXT = "Tuesday at nine works for me.";

function fail(msg: string): never {
  console.error(`[tts-smoke] FAIL: ${msg}`);
  process.exit(1);
}

async function sseProbe(tts: TtsService, client: ReturnType<typeof createOpenAI>): Promise<Record<string, unknown>> {
  const ledger = getLimitsAuthority().ledger;
  const est = ttsCostUsd(SSE_TEXT);
  const r = await ledger.reserve({ provider: "openai", action: "tts_sse_probe", refId: "wp17-smoke", estUsd: est, env: ENV });
  if (!r.ok) fail("ledger refused the SSE probe");
  let audioBytes = 0;
  type SpeechUsage = { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  const got: { usage: SpeechUsage | null } = { usage: null };
  try {
    const res = await client.audio.speech.create({
      model: tts.model, voice: "marin", input: SSE_TEXT, response_format: "pcm", stream_format: "sse", instructions: CUSTOMER_INSTRUCTIONS,
    });
    const text = await res.text();
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const ev = JSON.parse(line.slice(6)) as { type: string; audio?: string; usage?: SpeechUsage };
      if (ev.type === "speech.audio.delta" && ev.audio) audioBytes += Buffer.from(ev.audio, "base64").byteLength;
      if (ev.type === "speech.audio.done") got.usage = ev.usage ?? null;
    }
  } catch (e) {
    await ledger.release(r.id);
    throw e;
  }
  const usage = got.usage;
  const usageUsd = usage ? (usage.input_tokens ?? 0) * USD_PER_TEXT_TOKEN + (usage.output_tokens ?? 0) * USD_PER_AUDIO_TOKEN : null;
  const settled = Math.max(est, usageUsd ?? 0);
  await ledger.settle(r.id, settled);
  const audioMs = Math.round((audioBytes / 2 / 24_000) * 1000);
  return {
    chars: SSE_TEXT.length, audioMs, usage, usageUsd: usageUsd === null ? null : Number(usageUsd.toFixed(7)), charUsd: est, settledUsd: settled,
    outputTokensPerSec: usage?.output_tokens && audioMs ? Number(((usage.output_tokens * 1000) / audioMs).toFixed(2)) : null,
  };
}

async function main(): Promise<void> {
  loadEnv();
  if (process.env.RUN_LIVE !== "1") fail("set RUN_LIVE=1 (this spends ≈ $0.01 of OpenAI credit)");
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) fail("OPENAI_API_KEY is not set (value never printed)");
  const outIdx = process.argv.indexOf("--out");
  const out = outIdx > 0 ? process.argv[outIdx + 1]! : join(tmpdir(), "wp17-sim-smoke");
  mkdirSync(out, { recursive: true });

  const ledger = getLimitsAuthority().ledger;
  const client = createOpenAI(key, { maxRetries: 0, timeoutMs: 30_000 });
  const cache = new FsTtsCache(join(repoRoot(), "scripts/sim/.cache/tts"));
  const tts = new TtsService({ openai: () => client, cache, ledger: () => ledger, env: () => ENV });

  // Spend guard: the worst case (every clip a miss) must fit the unit budget.
  const allTexts = [...script.turns.map((t) => t.text), "Yes, that's right.", script.consent_phrase, script.closing_phrase, ...script.ai_half_answers.map((a) => a.spoken), SSE_TEXT];
  const worst = allTexts.reduce((s, t) => s + ttsCostUsd(normalizeTtsText(t)), 0);
  if (worst > MAX_USD) fail(`worst-case spend $${worst.toFixed(4)} exceeds $${MAX_USD}`);

  const id = simCallIdFor({ kind: "audio", versionKey: "smoke@wp17", sampleIndex: 0, salt: "smoke-1" });
  const relay = { relayId: "rl_smoke", slug: "dental-smoke", title: "Dental smoke", blueprintHash: null };
  const t0 = Date.now();
  const v = await voiceSimCall(tts, { simCallId: id, script, blueprint, sampleIndex: 0, relay, relayVersionId: "rv_smoke", gallery: false });
  const voiceMs = Date.now() - t0;

  // Clip sanity: real speech runs ≈ 10–25 chars/s.
  const clips = [...v.clips.values()].map((c) => {
    const text = v.row.script.timeline.find((x) => x.clipHash === c.hash)?.text ?? Object.values(v.row.aiClips).find((a) => a.hash === c.hash)?.text ?? "";
    return { chars: text.length, ms: c.durationMs, cps: Number(((text.length * 1000) / c.durationMs).toFixed(1)), cached: c.cached };
  });
  for (const c of clips) if (c.ms <= 0 || c.cps < 5 || c.cps > 40) fail(`implausible clip ${JSON.stringify(c)}`);

  const a = v.assembled;
  const h = a.handoff;
  if (a.durationMs > 90_000) fail("over the 90 s cap");
  if (a.rep.length !== a.customer.length || a.rep.length !== a.durationMs * 8) fail("channel lengths");
  if (!(h.lineStartMs < h.lineEndMs && h.acceptStartMs === h.lineEndMs + 300 && h.acceptStartMs < h.acceptEndMs!)) fail(`handoff times ${JSON.stringify(h)}`);
  if (v.row.script.turns[6]!.text !== REP_LINE) fail("handoff line not exact");

  const store = new MemorySimCallStore({ tts: cache });
  await store.insert(v.row);
  const resolved = await store.resolveCall(id);
  if (!resolved || resolved.entry.decisionPointMs !== h.lineStartMs) fail("resolveCall");

  // Warm cache: $0 and byte-identical.
  const again = await voiceSimCall(tts, { simCallId: id, script, blueprint, sampleIndex: 0, relay, relayVersionId: "rv_smoke", gallery: false });
  if (again.ttsUsd !== 0 || again.cachedClips !== again.totalClips) fail("warm re-run was not free");
  if (!Buffer.from(again.row.rep!).equals(Buffer.from(v.row.rep!)) || !Buffer.from(again.row.customer!).equals(Buffer.from(v.row.customer!))) fail("warm re-run not byte-identical");

  const sse = process.argv.includes("--no-sse") ? null : await sseProbe(tts, client);

  const stereo = interleave(mulawDecode(a.rep), mulawDecode(a.customer));
  writeFileSync(join(out, "sim-smoke.wav"), encodeWav(stereo, 8000, 2));

  console.log(JSON.stringify({
    ok: true, model: TTS_MODEL, env: ENV, simCallId: id, voiceMs, durationMs: a.durationMs, handoff: h, humanChars: v.humanChars,
    clips: clips.length, missesThisRun: clips.filter((c) => !c.cached).length, ttsUsd: v.ttsUsd, clipStats: clips,
    timeline: a.timeline.map((x) => ({ i: x.i, speaker: x.speaker, tag: x.tag, startMs: x.startMs, endMs: x.endMs })),
    sse, wav: join(out, "sim-smoke.wav"),
  }));
}

main().catch((e: unknown) => {
  console.error("[tts-smoke] error:", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exit(1);
});
