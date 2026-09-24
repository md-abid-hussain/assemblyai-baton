/**
 * T6 / C9 - bring-your-own LLM through the stored-agent `llm` field, compared with the managed LLM:
 *   managed (baseline) | OpenAI direct (gpt-4.1-mini) | Gateway gpt-5-mini | Gateway claude-haiku-4-5 |
 *   Gateway qwen3.5-4b-32k-fast (the only Gateway model this account can call, see t6a2)
 * Plus: is `llm` accepted inline in session.update?
 * Per config: one text turn (reply.create) + one speech turn (question_24k.wav, tool round trip).
 * Every agent created here is deleted at the end.
 *
 *   npx tsx voice-agent/t6-byo-llm.ts [only-label]
 * Log: spikes/out/va-t6-byo-llm.jsonl
 */
import { ASSEMBLYAI_API_KEY, OPENAI_API_KEY } from "../lib/env.ts";
import { LLM_GATEWAY_BASE, RealtimeAudioFeeder, type LlmConfig } from "./client.ts";
import { LOOKUP_ORDER_TOOL, SYSTEM_PROMPT, lookupOrder } from "./core-loop-config.ts";
import { resolve } from "node:path";
import { writeWav } from "../lib/wav.ts";
import { bytesToPcm16 } from "../lib/audio.ts";
import { OUT_DIR, awaitTurn, brief, concatBytes, leadingSilenceByReply, loadFixturePcm, newRecorder, open, restFor, sleep, speechTurn, transcribeWav, vaLogger } from "./harness.ts";

const only = process.argv[2];
const log = vaLogger(only ? `t6-byo-llm-${only}` : "t6-byo-llm");
const rest = restFor(log);
const out: Record<string, unknown> = {};

const CONFIGS: { label: string; llm?: LlmConfig; full: boolean; noTools?: boolean }[] = [
  { label: "managed", full: true },
  { label: "openai-direct-gpt-4.1-mini", llm: { base_url: "https://api.openai.com/v1", model: "gpt-4.1-mini", api_key: OPENAI_API_KEY }, full: true },
  { label: "gateway-gpt-5-mini", llm: { base_url: LLM_GATEWAY_BASE, model: "gpt-5-mini", api_key: ASSEMBLYAI_API_KEY }, full: false },
  { label: "gateway-claude-haiku-4-5", llm: { base_url: LLM_GATEWAY_BASE, model: "claude-haiku-4-5-20251001", api_key: ASSEMBLYAI_API_KEY }, full: false },
  { label: "gateway-qwen3.5-4b-fast", llm: { base_url: LLM_GATEWAY_BASE, model: "qwen3.5-4b-32k-fast", api_key: ASSEMBLYAI_API_KEY }, full: true },
  { label: "gateway-qwen3.5-4b-fast-no-tools", llm: { base_url: LLM_GATEWAY_BASE, model: "qwen3.5-4b-32k-fast", api_key: ASSEMBLYAI_API_KEY }, full: false, noTools: true },
];

async function inlineProbe() {
  const s = await open(log, { apiKey: ASSEMBLYAI_API_KEY });
  const r: Record<string, unknown> = {};
  try {
    const ready = await s.start({ system_prompt: "Test.", output: { voice: "alba" }, llm: [CONFIGS[1]!.llm!] } as never, 8000);
    r.ready = true;
    r.configLlm = (ready.config as { llm?: unknown } | undefined)?.llm;
  } catch (e) {
    r.ready = false;
    r.error = (e as { event?: unknown }).event ?? String(e);
  }
  await s.end();
  r.close = s.closed ?? null;
  return r;
}

async function runConfig(c: (typeof CONFIGS)[number]) {
  const res: Record<string, unknown> = { label: c.label, model: c.llm?.model ?? "managed", base_url: c.llm?.base_url ?? null };
  const create = await rest.request(
    "POST",
    "/agents",
    { name: `va-smoke-t6-${c.label}`, system_prompt: SYSTEM_PROMPT, voice: { voice_id: "alba" }, ...(c.llm ? { llm: [c.llm] } : {}) },
    `create-agent ${c.label}`,
  );
  res.createStatus = create.status;
  const agentId = (create.body as { id?: string }).id;
  res.agentLlmOnRead = (create.body as { llm?: unknown }).llm;
  if (!agentId) {
    res.createError = create.body;
    return res;
  }
  try {
    const rec = newRecorder();
    const s = await open(log, { apiKey: ASSEMBLYAI_API_KEY }, rec);
    const hardStop = setTimeout(() => void s.end(), 90_000);
    s.tools.register("lookup_order", (a) => lookupOrder(a));
    try {
      const ready = await s.start({ agent_id: agentId });
      res.session_id = ready.session_id;
      res.readyLlm = (ready.config as { llm?: unknown } | undefined)?.llm;
      if (!c.noTools) {
        const u = await s.update({ tools: [LOOKUP_ORDER_TOOL] });
        res.toolsUpdate = u.type;
      }
      const feeder = new RealtimeAudioFeeder(s);
      feeder.start();
      await sleep(300);
      res.textTurn = await awaitTurn(s, rec, log, `${c.label}: reply.create`, () => s.send({ type: "reply.create", instructions: "Greet the caller and ask how you can help, in one short sentence." }), {
        timeoutMs: c.full ? 20000 : 12000,
      });
      console.log(c.label, "text:", brief(res.textTurn, 500));
      if (c.full && (res.textTurn as { firstAudioMs: number | null }).firstAudioMs !== null) {
        const q = loadFixturePcm("question_24k.wav");
        res.speechTurn = await speechTurn(s, rec, log, feeder, q, { timeoutMs: 30000 });
        console.log(c.label, "speech:", brief(res.speechTurn, 900));
      }
      await feeder.stop();
    } catch (e) {
      res.sessionError = (e as { event?: unknown }).event ?? String(e);
    }
    clearTimeout(hardStop);
    res.errorsSeen = rec.events.filter((e) => e.ev.type === "session.error").map((e) => e.ev);
    res.leadingSilenceMsByReply = leadingSilenceByReply(rec);
    const wav = resolve(OUT_DIR, `va-t6-${c.label}.wav`);
    const all = concatBytes(rec.replyOrder.flatMap((id) => rec.audioByReply.get(id) ?? []));
    writeWav(wav, bytesToPcm16(all), 24000, 1);
    res.audioWav = { path: wav, sec: +(all.length / 48000).toFixed(2) };
    if (all.length) res.whatTheAgentSaid = await transcribeWav(wav, log);
    res.ended = (await s.end()) ?? null;
    res.close = s.closed ?? null;
  } finally {
    res.deleteStatus = await rest.deleteAgent(agentId);
  }
  return res;
}

async function main() {
  if (!only) {
    out.inlineLlm = await inlineProbe();
    console.log("inline llm:", brief(out.inlineLlm, 600));
  }
  const results: Record<string, unknown>[] = [];
  for (const c of CONFIGS) {
    if (only && c.label !== only) continue;
    results.push(await runConfig(c));
  }
  out.results = results;
  out.summary = results.map((r) => {
    const t = r.textTurn as { replyStartedMs: number | null; firstAudioMs: number | null; agentText: string[] } | undefined;
    const sp = r.speechTurn as { finalSpeechStopped: number | null; firstAudioAfterStop: number | null; toolCall: number | null; answerFirstAudio: number | null; agentText: string[] } | undefined;
    return {
      label: r.label,
      createStatus: r.createStatus,
      textFirstAudioMs: t?.firstAudioMs ?? null,
      textFirstAudibleMs: (t as { firstAudibleMs?: number | null } | undefined)?.firstAudibleMs ?? null,
      textSaid: t?.agentText?.[0] ?? null,
      speechStopMs: sp?.finalSpeechStopped ?? null,
      speechFirstAudioMs: sp?.firstAudioAfterStop ?? null,
      speechFirstAudibleMs: (sp as { firstAudibleAfterStop?: number | null } | undefined)?.firstAudibleAfterStop ?? null,
      toolCallMs: sp?.toolCall ?? null,
      answerFirstAudioMs: sp?.answerFirstAudio ?? null,
      answerFirstAudibleMs: (sp as { answerFirstAudible?: number | null } | undefined)?.answerFirstAudible ?? null,
      whatTheAgentSaid: r.whatTheAgentSaid ?? null,
      answer: sp?.agentText?.slice(-1)[0] ?? null,
      errors: r.errorsSeen,
    };
  });
  log.result("PASS", out);
  log.close();
  console.log(JSON.stringify(out.summary, null, 1));
}

main().catch((e) => {
  log.error(e);
  log.close();
  console.error(e);
  process.exit(1);
});
