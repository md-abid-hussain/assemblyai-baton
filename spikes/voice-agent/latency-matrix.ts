/**
 * Latency matrix (plain Q&A, no tools): end of user speech -> input.speech.stopped -> first reply.audio ->
 * first AUDIBLE reply audio, for input.transcription_mode balanced | min_latency | max_accuracy.
 * Also times how long after session end the recording/timeline artifacts appear (T10 follow-up) and
 * cross-checks our numbers with the timeline's time_to_first_audio_ms.
 *
 *   npx tsx voice-agent/latency-matrix.ts
 * Log: spikes/out/va-latency-matrix.jsonl
 */
import { ASSEMBLYAI_API_KEY } from "../lib/env.ts";
import { pcm16ToBytes, trimSilence } from "../lib/audio.ts";
import { ttsPcm24k } from "../lib/tts.ts";
import { RealtimeAudioFeeder, type TranscriptionMode } from "./client.ts";
import { brief, leadingSilenceByReply, newRecorder, open, restFor, sleep, speechTurn, vaLogger, type SpeechTurnMetrics } from "./harness.ts";

const log = vaLogger("latency-matrix");
const rest = restFor(log);
const out: Record<string, unknown> = {};

const PROMPT =
  "You are Max, Acme Shop's AI phone assistant. Facts: the store is open 9 a.m. to 6 p.m. Monday to Saturday and closed on Sunday. Acme ships to the United States and Canada only. Answer in one short sentence. No markdown.";
const QUESTIONS = ["What time do you open on Saturdays?", "Do you ship to Canada?", "Okay, thanks. Are you open on Sunday?"];

async function main() {
  const clips = [];
  for (const q of QUESTIONS) {
    const r = await ttsPcm24k({ input: q, voice: "marin" }, log);
    const t = trimSilence(r.samples, 24000, { thresholdDb: -45, padMs: 0 });
    clips.push({ text: q, bytes: new Uint8Array(pcm16ToBytes(r.samples)), speechEndMs: Math.round((t.end / 24000) * 1000), durationMs: Math.round(r.durationMs) });
  }
  out.clips = clips.map((c) => ({ text: c.text, durationMs: c.durationMs, speechEndMs: c.speechEndMs }));

  const modes: TranscriptionMode[] = ["balanced", "min_latency", "max_accuracy"];
  const sessions: { mode: string; id: string; endedAt: number }[] = [];
  const artifactWatch: Promise<unknown>[] = [];
  const rows: Record<string, unknown>[] = [];
  for (const mode of modes) {
    const rec = newRecorder();
    const s = await open(log, { apiKey: ASSEMBLYAI_API_KEY }, rec);
    const hardStop = setTimeout(() => void s.end(), 90_000);
    const ready = await s.start({ system_prompt: PROMPT, output: { voice: "alba" }, input: { transcription_mode: mode } });
    const feeder = new RealtimeAudioFeeder(s);
    feeder.start();
    await sleep(800);
    const turns: SpeechTurnMetrics[] = [];
    for (const c of clips) {
      turns.push(await speechTurn(s, rec, log, feeder, c, { timeoutMs: 20000, quietMs: 800 }));
      await sleep(600);
    }
    await feeder.stop();
    clearTimeout(hardStop);
    const ended = await s.end();
    const endedAt = Date.now();
    sessions.push({ mode, id: ready.session_id, endedAt });
    const lead = leadingSilenceByReply(rec);
    for (const [i, t] of turns.entries()) {
      rows.push({
        mode,
        q: QUESTIONS[i],
        stop: t.finalSpeechStopped,
        firstChunk: t.firstAudioAfterStop,
        firstAudible: t.firstAudibleAfterStop,
        user: t.userTranscripts.join(" | "),
        agent: t.agentText.join(" | "),
      });
    }
    out[`leadingSilence_${mode}`] = lead;
    out[`ended_${mode}`] = ended ?? null;
    console.log(mode, brief(rows.filter((r) => r.mode === mode), 1500));
    // watch artifacts for this session in the background
    const id = ready.session_id;
    artifactWatch.push(
      (async () => {
        for (let i = 0; i < 40; i++) {
          const sr = await rest.getSession(id);
          const types = (sr.artifacts ?? []).map((a) => a.type);
          if (types.includes("audio") && types.includes("timeline")) {
            const tl = await (await fetch(sr.artifacts!.find((a) => a.type === "timeline")!.url)).json() as { turns?: { trigger?: string; time_to_first_audio_ms?: number | null; user_speech_ended_at_ms?: number | null; agent_reply_started_at_ms?: number | null }[] };
            return { mode, id, availableAfterEndMs: Date.now() - endedAt, polls: i + 1, timelineTTFA: (tl.turns ?? []).map((t) => ({ trigger: t.trigger, ttfa: t.time_to_first_audio_ms ?? null })) };
          }
          await sleep(5000);
        }
        return { mode, id, availableAfterEndMs: null, note: "not available within ~200 s" };
      })(),
    );
  }
  out.rows = rows;
  out.artifacts = await Promise.all(artifactWatch);
  log.result("PASS", out);
  log.close();
  console.table(rows.map((r) => ({ mode: r.mode, q: String(r.q).slice(0, 28), stop: r.stop, firstChunk: r.firstChunk, firstAudible: r.firstAudible })));
  console.log(brief(out.artifacts, 2000));
}

main().catch((e) => {
  log.error(e);
  log.close();
  console.error(e);
  process.exit(1);
});
