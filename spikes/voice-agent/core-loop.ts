/**
 * Core loop: token connect -> session.update (prompt, AI-disclosure greeting, voice, PCM16 24 kHz both
 * ways, client function tool lookup_order with a digit pattern) -> session.ready -> continuous real-time
 * "mic" (silence + fixtures/question_24k.wav in 50 ms chunks) -> tool.call/tool.result (reply.done rule)
 * -> reply audio saved to out/agent_reply.wav -> barge-in with more speech while the agent answers ->
 * session.end.
 *
 * Latency is measured from the fixture's end of speech (recorded time of the last voiced sample).
 *
 *   npx tsx voice-agent/core-loop.ts
 * Log: spikes/out/va-core-loop.jsonl  Audio: spikes/out/agent_reply.wav, spikes/out/agent_after_bargein.wav
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { writeWav } from "../lib/wav.ts";
import { bytesToPcm16, trimSilence } from "../lib/audio.ts";
import { ttsPcm24k } from "../lib/tts.ts";
import { pcm16ToBytes } from "../lib/audio.ts";
import { GREETING, LOOKUP_ORDER_TOOL, SYSTEM_PROMPT, lookupOrder } from "./core-loop-config.ts";
import { RealtimeAudioFeeder, type ReplyDoneEvent, type ServerEvent, type TranscriptAgentEvent } from "./client.ts";
import { OUT_DIR, brief, concatBytes, firstAudibleAfter, leadingSilenceByReply, loadFixturePcm, newRecorder, open, restFor, sleep, vaLogger } from "./harness.ts";

const log = vaLogger("core-loop");
const rest = restFor(log, "bearer");
const rec = newRecorder();
const out: Record<string, unknown> = {};

const pcmSec = (bytes: number) => bytes / 2 / 24000;

async function main() {
  const q = loadFixturePcm("question_24k.wav");
  out.fixture = { name: "question_24k.wav", durationMs: Math.round(q.durationMs), speechStartMs: q.speechStartMs, speechEndMs: q.speechEndMs };

  // barge-in utterance (OpenAI TTS, cached under spikes/.cache/tts)
  const barge = await ttsPcm24k({ input: "Wait, sorry, stop. Can you just text me the tracking number instead?", voice: "marin" }, log);
  const bargeBytes = new Uint8Array(pcm16ToBytes(barge.samples));
  const bargeTrim = trimSilence(barge.samples, 24000, { thresholdDb: -45, padMs: 0 });
  out.bargeClip = { durationMs: Math.round(barge.durationMs), speechEndMs: Math.round((bargeTrim.end / 24000) * 1000), cached: barge.cached };

  const { token } = await rest.mintToken({ expiresInSeconds: 60, maxSessionDurationSeconds: 180 });
  const s = await open(log, { token }, rec);
  const hardStop = setTimeout(() => {
    log.note("hard stop at 150 s");
    void s.end();
  }, 150_000);

  s.tools.register("lookup_order", (args) => lookupOrder(args));

  const config = {
    system_prompt: SYSTEM_PROMPT,
    greeting: GREETING,
    input: { format: { encoding: "audio/pcm" as const, sample_rate: 24000 } },
    output: { voice: "alba", format: { encoding: "audio/pcm" as const, sample_rate: 24000 } },
    tools: [LOOKUP_ORDER_TOOL],
  };
  const tU = log.elapsed();
  const ready = await s.start(config);
  out.session_id = ready.session_id;
  out.readyAfterUpdateMs = Math.round(log.elapsed() - tU);
  out.readyConfig = ready.config;
  const feeder = new RealtimeAudioFeeder(s);
  feeder.start();

  // --- greeting ------------------------------------------------------------------------------
  const greetDone = (await s.waitFor("reply.done", { timeoutMs: 20000 })) as ReplyDoneEvent;
  const greetId = rec.replyOrder[0] ?? "?";
  const greetBytes = (rec.audioByReply.get(greetId) ?? []).reduce((a, b) => a + b.length, 0);
  const greetFirstAudio = rec.events.find((e) => e.ev.type === "reply.audio")?.ms ?? log.elapsed();
  out.greeting = {
    reply_id: greetId,
    status: greetDone.status,
    audioSec: +pcmSec(greetBytes).toFixed(2),
    firstAudioAfterReadyMs: Math.round(greetFirstAudio - (rec.first.get("session.ready") ?? 0)),
    replyDoneAfterFirstAudioMs: Math.round((rec.first.get("reply.done") ?? 0) - greetFirstAudio),
  };
  // wait until the greeting would have finished playing on a real speaker
  const playEnd = greetFirstAudio + pcmSec(greetBytes) * 1000 + 400;
  if (playEnd > log.elapsed()) await sleep(playEnd - log.elapsed());

  // --- user question -----------------------------------------------------------------------
  const evIdxBeforeQuestion = rec.events.length;
  const clip = await feeder.play(q.bytes);
  const recordStartLogMs = clip.recordStartMs - log.t0;
  const speechEndLogMs = recordStartLogMs + q.speechEndMs;
  out.questionSent = { recordStartLogMs: Math.round(recordStartLogMs), speechEndLogMs: Math.round(speechEndLogMs), chunks: clip.chunks };

  // wait for tool result reply (or any completed reply after the question)
  const firstAfter = (type: string, afterMs: number, pred?: (e: ServerEvent) => boolean) => rec.events.find((e) => e.ms >= afterMs && e.ev.type === type && (!pred || pred(e.ev)));
  const deadline = Date.now() + 40000;
  let answerReplyId: string | undefined;
  while (Date.now() < deadline) {
    const tr = s.tools.traces[0];
    if (tr?.sentAtMs !== undefined) {
      const sentLog = tr.sentAtMs - log.t0;
      const rs = firstAfter("reply.started", sentLog);
      const ra = rs && firstAfter("reply.audio", rs.ms);
      if (rs && ra) {
        answerReplyId = String((rs.ev as { reply_id?: string }).reply_id);
        break;
      }
    } else if (!tr) {
      // no tool call: settle for the first completed reply after the question
      const rd = firstAfter("reply.done", speechEndLogMs);
      if (rd && Date.now() > deadline - 30000) {
        const rs = firstAfter("reply.started", speechEndLogMs);
        answerReplyId = String((rs?.ev as { reply_id?: string } | undefined)?.reply_id ?? "?");
        break;
      }
    }
    await sleep(50);
  }
  out.answerReplyId = answerReplyId ?? null;

  // --- barge-in while the answer is playing -----------------------------------------------
  let bargeSpeechEndLogMs: number | undefined;
  if (answerReplyId) {
    const ansFirstAudio = firstAfter("reply.audio", rec.first.get("reply.started") ?? 0, () => rec.currentReplyId === answerReplyId);
    void ansFirstAudio;
    await sleep(1500); // ~1.5 s into the agent's answer (as a listener would hear it)
    const bargeReq = log.elapsed();
    const bclip = await feeder.play(bargeBytes);
    const bStart = bclip.recordStartMs - log.t0;
    bargeSpeechEndLogMs = bStart + (out.bargeClip as { speechEndMs: number }).speechEndMs;
    out.bargeIn = { requestedAtLogMs: Math.round(bargeReq), recordStartLogMs: Math.round(bStart), speechEndLogMs: Math.round(bargeSpeechEndLogMs) };
    // wait for the agent to respond to the barge-in and finish
    const until = Date.now() + 25000;
    while (Date.now() < until) {
      const rd = rec.events.filter((e) => e.ms > bargeSpeechEndLogMs! && e.ev.type === "reply.done");
      if (rd.length) {
        // reply.audio is delivered at real-time pace, so reply.done already marks the end of playback
        await sleep(800);
        break;
      }
      await sleep(100);
    }
  } else {
    log.note("no answer reply detected; skipping barge-in");
    await sleep(3000);
  }

  await feeder.stop();
  const ended = await s.end();
  clearTimeout(hardStop);
  out.sessionEnded = ended ?? null;
  out.close = s.closed ?? null;
  out.feeder = { sentChunks: feeder.sentChunks, maxLateMs: Math.round(feeder.maxLateMs) };

  // --- analysis -------------------------------------------------------------------------------
  const evs = rec.events.slice(evIdxBeforeQuestion);
  const rel = (ms: number | undefined) => (ms === undefined ? null : Math.round(ms - speechEndLogMs));
  const find = (type: string, after = recordStartLogMs, pred?: (e: ServerEvent) => boolean) => evs.find((e) => e.ms >= after && e.ev.type === type && (!pred || pred(e.ev)));
  const sStarted = find("input.speech.started");
  const sStopped = find("input.speech.stopped");
  const tUser = find("transcript.user");
  const rStarted = find("reply.started", sStopped?.ms ?? speechEndLogMs);
  const rAudio = find("reply.audio", sStopped?.ms ?? speechEndLogMs);
  const toolCall = find("tool.call");
  const trace = s.tools.traces[0];
  const toolSentLog = trace?.sentAtMs !== undefined ? trace.sentAtMs - log.t0 : undefined;
  const ansStarted = toolSentLog !== undefined ? find("reply.started", toolSentLog) : undefined;
  const ansAudio = toolSentLog !== undefined ? find("reply.audio", toolSentLog) : undefined;
  out.latencyFromSpeechEndMs = {
    "input.speech.started (from speech START)": sStarted ? Math.round(sStarted.ms - (recordStartLogMs + q.speechStartMs)) : null,
    "input.speech.stopped": rel(sStopped?.ms),
    "transcript.user": rel(tUser?.ms),
    "reply.started": rel(rStarted?.ms),
    "first reply.audio": rel(rAudio?.ms),
    "tool.call": rel(toolCall?.ms),
    "tool.result sent": rel(toolSentLog),
    "answer reply.started (after tool.result)": rel(ansStarted?.ms),
    "answer first reply.audio": rel(ansAudio?.ms),
    "tool.result -> answer first audio": ansAudio && toolSentLog !== undefined ? Math.round(ansAudio.ms - toolSentLog) : null,
    "first AUDIBLE agent audio after final speech.stopped": sStopped ? rel(firstAudibleAfter(rec, sStopped.ms)) : null,
    "answer first AUDIBLE audio": toolSentLog !== undefined ? rel(firstAudibleAfter(rec, toolSentLog)) : null,
  };
  out.userTranscript = (tUser?.ev as { text?: string } | undefined)?.text ?? null;
  out.toolTrace = s.tools.traces.map((t) => ({
    call: t.call,
    result: t.result,
    dropped: t.dropped ?? null,
    handlerMs: t.handlerDoneAtMs !== undefined ? Math.round(t.handlerDoneAtMs - t.receivedAtMs) : null,
    waitedForReplyDoneMs: t.sentAtMs !== undefined && t.handlerDoneAtMs !== undefined ? Math.round(t.sentAtMs - t.handlerDoneAtMs) : null,
  }));

  // compact event sequence after the question (types + key fields)
  out.sequence = evs
    .filter((e) => e.ev.type !== "reply.audio" && e.ev.type !== "transcript.agent.delta" && e.ev.type !== "transcript.user.delta")
    .map((e) => {
      const { type, ...rest } = e.ev as Record<string, unknown>;
      return `${Math.round(e.ms - speechEndLogMs)}ms ${String(type)} ${JSON.stringify(rest).slice(0, 180)}`;
    });
  out.agentTranscripts = rec.events.filter((e) => e.ev.type === "transcript.agent").map((e) => ({ atRelMs: rel(e.ms), ...(e.ev as TranscriptAgentEvent) }));
  out.replyDones = rec.events.filter((e) => e.ev.type === "reply.done").map((e) => ({ atRelMs: rel(e.ms), ...(e.ev as ReplyDoneEvent) }));
  out.eventTypeCounts = rec.events.reduce<Record<string, number>>((a, e) => ((a[e.ev.type] = (a[e.ev.type] ?? 0) + 1), a), {});

  // delivery pacing of reply audio: audio seconds vs wall seconds between first and last chunk
  const perReply: Record<string, unknown> = {};
  for (const id of rec.replyOrder) {
    const chunks = rec.events.filter((e) => e.ev.type === "reply.audio" && (e.ev as { reply_id?: string }).reply_id === id);
    const bytes = (rec.audioByReply.get(id) ?? []).reduce((a, b) => a + b.length, 0);
    perReply[id] = {
      chunks: chunks.length,
      audioSec: +pcmSec(bytes).toFixed(2),
      wallSecFirstToLast: chunks.length ? +((chunks[chunks.length - 1]!.ms - chunks[0]!.ms) / 1000).toFixed(2) : null,
      avgChunkBytes: chunks.length ? Math.round(bytes / chunks.length) : null,
    };
  }
  out.replyAudioDelivery = perReply;
  out.leadingSilenceMsByReply = leadingSilenceByReply(rec);
  // every user turn: end of voiced audio is unknown per turn, so report stop -> first audible per turn
  const turns: Record<string, unknown>[] = [];
  for (const e of rec.events) {
    if (e.ev.type !== "input.speech.stopped") continue;
    const rs = rec.events.find((x) => x.ms >= e.ms && x.ev.type === "reply.started");
    const tu = rec.events.find((x) => x.ms >= e.ms && x.ev.type === "transcript.user");
    const aud = firstAudibleAfter(rec, e.ms);
    turns.push({ stoppedAtRelMs: rel(e.ms), text: (tu?.ev as { text?: string } | undefined)?.text ?? null, replyStartedAfterStopMs: rs ? Math.round(rs.ms - e.ms) : null, firstAudibleAfterStopMs: aud !== undefined ? Math.round(aud - e.ms) : null });
  }
  out.perUserTurn = turns;
  const deltas = rec.events.filter((e) => e.ev.type === "transcript.agent.delta").slice(0, 6).map((e) => e.ev);
  out.sampleAgentDeltas = deltas;
  const userDeltas = rec.events.filter((e) => e.ev.type === "transcript.user.delta").slice(0, 4).map((e) => e.ev);
  out.sampleUserDeltas = userDeltas;

  // --- save audio -----------------------------------------------------------------------------
  const postQuestionIds = rec.replyOrder.filter((id) => id !== greetId);
  const bargeIdx = bargeSpeechEndLogMs !== undefined ? rec.events.findIndex((e) => e.ms > bargeSpeechEndLogMs! - 4000 && e.ev.type === "input.speech.started") : -1;
  const bargeAtMs = bargeIdx >= 0 ? rec.events[bargeIdx]!.ms : Infinity;
  const beforeBarge: Uint8Array[] = [];
  const afterBarge: Uint8Array[] = [];
  for (const id of postQuestionIds) {
    const startedAt = rec.events.find((e) => e.ev.type === "reply.started" && (e.ev as { reply_id?: string }).reply_id === id)?.ms ?? 0;
    (startedAt < bargeAtMs ? beforeBarge : afterBarge).push(...(rec.audioByReply.get(id) ?? []));
  }
  const replyPath = resolve(OUT_DIR, "agent_reply.wav");
  const replyBytes = concatBytes(beforeBarge);
  writeWav(replyPath, bytesToPcm16(replyBytes), 24000, 1);
  const afterPath = resolve(OUT_DIR, "agent_after_bargein.wav");
  writeWav(afterPath, bytesToPcm16(concatBytes(afterBarge)), 24000, 1);
  out.savedAudio = { agent_reply_wav: { path: replyPath, sec: +pcmSec(replyBytes.length).toFixed(2), replies: postQuestionIds.length }, agent_after_bargein_wav: { path: afterPath, sec: +pcmSec(concatBytes(afterBarge).length).toFixed(2) } };

  // --- barge-in verdict -----------------------------------------------------------------------
  const interruptedDone = rec.events.find((e) => e.ev.type === "reply.done" && (e.ev as ReplyDoneEvent).status === "interrupted");
  const interruptedTranscript = rec.events.find((e) => e.ev.type === "transcript.agent" && (e.ev as TranscriptAgentEvent).interrupted === true);
  out.bargeInVerdict = {
    replyDoneInterrupted: interruptedDone ? { atRelToBargeSpeechEndMs: bargeSpeechEndLogMs !== undefined ? Math.round(interruptedDone.ms - bargeSpeechEndLogMs) : null, ev: interruptedDone.ev } : null,
    transcriptAgentInterrupted: interruptedTranscript ? interruptedTranscript.ev : null,
    speechStartedDuringAnswer: bargeIdx >= 0 ? { atRelToBargeRecordStartMs: Math.round(bargeAtMs - (out.bargeIn as { recordStartLogMs: number }).recordStartLogMs) } : null,
  };

  // persist session id for the session-history test
  const sessFile = resolve(OUT_DIR, "va-sessions.json");
  const prev = existsSync(sessFile) ? (JSON.parse(readFileSync(sessFile, "utf8")) as Record<string, unknown>) : {};
  writeFileSync(sessFile, JSON.stringify({ ...prev, core: { session_id: ready.session_id, endedAt: new Date().toISOString() } }, null, 2));

  const ok = !!trace?.sentAtMs && !!rAudio;
  const bargeOk = !!interruptedDone || !!interruptedTranscript;
  log.result(ok && bargeOk ? "PASS" : ok ? "PARTIAL" : "FAIL", out);
  log.close();
  console.log(brief({ ...out, readyConfig: "<omitted>" }, 12000));
}

main().catch((e) => {
  log.error(e);
  log.close();
  console.error(e);
  process.exit(1);
});
