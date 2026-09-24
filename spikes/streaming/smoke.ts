/**
 * smoke.ts - AssemblyAI Streaming STT v3 smoke tests.
 *
 *   npx tsx streaming/smoke.ts <test> [<test> ...]
 *   tests: models models2 auth auth2 core diarization stereo pii pii-hash tuning modes latency-min latency-max
 *          llm llm-stress multilingual multilingual2 multilingual3 mulaw tail-silence errors limits
 *
 * Logs:    out/streaming-<test>[-<case>].jsonl   (raw server events, audio as byte tallies)
 * Summary: out/streaming-<test>.summary.json     (status, request, verbatim-truncated events, timings)
 */
import { setTimeout as sleep } from "node:timers/promises";
import { createLogger, loggedFetch, type JsonlLogger } from "../lib/log.ts";
import { STREAMING_TOKEN_URL, type StreamingParams, type TurnMessage } from "./client.ts";
import {
  API_KEY,
  brief,
  census,
  diarizationAccuracy,
  dialogScript,
  entityHits,
  loadFixture,
  rateGuard,
  runSession,
  saveSummary,
  scriptTurnAt,
  stats,
  turnLatencies,
  wer,
  type RunOptions,
  type RunResult,
} from "./harness.ts";

type Status = "PASS" | "FAIL" | "PARTIAL" | "SKIPPED";
const U35 = "universal-3-5-pro";
const BASE: StreamingParams = { speech_model: U35, sample_rate: 16000, encoding: "pcm_s16le" };

const loggers: JsonlLogger[] = [];
function logger(name: string): JsonlLogger {
  const l = createLogger(`streaming-${name}`, { maxString: 2000 });
  loggers.push(l);
  return l;
}

/** Everything a report needs from one session, compact. */
function digest(r: RunResult, extra: Record<string, unknown> = {}) {
  const firstTurn = r.turns[0];
  const firstFinal = r.finals[0];
  return {
    url: r.url.replace(/token=[^&]+/, "token=***"),
    connectMs: r.connectMs,
    connectError: r.connectError,
    begin: r.begin,
    census: census(r),
    firstTurnWallMs: firstTurn?.wallMs,
    firstTurn: firstTurn ? brief(firstTurn.msg) : undefined,
    firstFinalWallMs: firstFinal?.wallMs,
    firstFinal: firstFinal ? brief(firstFinal.turn) : undefined,
    finals: r.finals.map((f) => ({ wallMs: f.wallMs, turn_order: f.turn.turn_order, transcript: f.turn.transcript, ...(f.turn.speaker_label ? { speaker_label: f.turn.speaker_label } : {}), ...(f.turn.language_code ? { language_code: f.turn.language_code, language_confidence: f.turn.language_confidence } : {}) })),
    errors: r.errors,
    warnings: r.warnings,
    termination: r.termination,
    terminateToTerminationMs: r.terminateSentWall !== undefined && r.terminationWall !== undefined ? Math.round(r.terminationWall - r.terminateSentWall) : undefined,
    close: r.close,
    audio: r.audio,
    actions: r.actions,
    ...extra,
  };
}

const billing: { test: string; session_duration_seconds?: number; audio_duration_seconds?: number }[] = [];
function bill(test: string, r: RunResult) {
  if (r.termination) billing.push({ test, session_duration_seconds: r.termination.session_duration_seconds, audio_duration_seconds: r.termination.audio_duration_seconds });
  else if (r.begin) billing.push({ test });
}

function finish(test: string, log: JsonlLogger, status: Status, summary: Record<string, unknown>) {
  log.result(status, { cite: summary.cite });
  const path = saveSummary(test, { test, status, at: new Date().toISOString(), ...summary, billing: billing.filter((b) => b.test.startsWith(test)) });
  console.log(`\n=== ${test}: ${status} -> ${path}`);
  return status;
}

// =============================================================================================
// T1 / C1: model ids
// =============================================================================================
const MODELS_1 = [
  "universal-3-5-pro",
  "universal-3-5-pro-realtime",
  "universal-streaming-english",
  "universal-streaming-multilingual",
  "u3-rt-pro",
  "universal-3-pro",
  "universal-3-6-pro",
  "whisper-rt",
];
// discovered from the server's own enum in the 3006 rejection message
const MODELS_2 = ["universal-3-5-pro-realtime", "universal-3-6", "universal-3-7-preview", "u3-rt-agent"];
async function testModels(which: "models" | "models2" = "models"): Promise<Status> {
  const q = loadFixture("question_16k.wav");
  const models = which === "models" ? MODELS_1 : MODELS_2;
  const cases: Record<string, unknown> = {};
  for (const m of models) {
    const log = logger(`${which}-${m}`);
    const r = await runSession({ log, params: { ...BASE, speech_model: m }, fixture: q, tailMs: 2000 });
    bill(which, r);
    const text = r.finals.map((f) => f.turn.transcript).join(" ");
    cases[m] = digest(r, { accepted: !!r.begin, echoedModel: r.begin?.configuration?.model, transcript: text, orderNumberOk: text.replace(/\D/g, "").includes("481529") });
    log.close();
  }
  const s = (m: string) => cases[m] as { accepted: boolean; echoedModel?: unknown };
  const status: Status = which === "models2" ? "PASS" : s("universal-3-5-pro").accepted && s("universal-streaming-english").accepted && s("universal-streaming-multilingual").accepted ? "PASS" : "FAIL";
  return finish(which, logger(which), status, { cite: ["T1", "C1", "C2"], request: { base: BASE, fixture: q.name, chunkMs: 50 }, cases });
}

// =============================================================================================
// Auth: raw vs Bearer header, temporary token, reuse, bad token, no auth
// =============================================================================================
async function testAuth(): Promise<Status> {
  const cases: Record<string, unknown> = {};
  const P = { ...BASE };
  const quick = async (name: string, o: Partial<RunOptions>) => {
    const log = logger(`auth-${name}`);
    const r = await runSession({ log, params: P, ...o });
    bill("auth", r);
    cases[name] = digest(r);
    log.close();
    return r;
  };
  await quick("header-raw", { auth: { apiKey: API_KEY } });
  await quick("header-bearer", { auth: { apiKey: `Bearer ${API_KEY}` } });
  await quick("none-ws", { auth: { token: "" }, impl: "ws" });
  await quick("bad-token-ws", { auth: { token: "not-a-real-token-123456" }, impl: "ws" });

  // token endpoint variants (HTTP only; logged with masking)
  const tlog = logger("auth-token-http");
  const tok = async (label: string, qs: string, header: string | null) => {
    const r = await loggedFetch<{ token?: string; expires_in_seconds?: number }>(tlog, `${STREAMING_TOKEN_URL}?${qs}`, { label, headers: header === null ? {} : { Authorization: header } });
    cases[`token-http-${label}`] = { request: { url: `${STREAMING_TOKEN_URL}?${qs}`, authorization: header === null ? "none" : header.startsWith("Bearer") ? "Bearer <key>" : "<raw key>" }, status: r.status, ms: r.ms, body: r.json ? { ...r.json, ...(r.json.token ? { token: `<${r.json.token.length} chars>` } : {}) } : r.text.slice(0, 300), contentType: r.headers["content-type"] };
    return r.json?.token;
  };
  // HTTP-only variants first (no sessions)
  await tok("raw-0", "expires_in_seconds=0", API_KEY);
  await tok("raw-601", "expires_in_seconds=601", API_KEY);
  await tok("missing-expires", "", API_KEY);
  await tok("no-auth", "expires_in_seconds=60", null);
  await tok("cap-59", "expires_in_seconds=60&max_session_duration_seconds=59", API_KEY);

  // mint right before use (after the rate guard) so the 60 s redemption window never lapses
  await rateGuard(tlog);
  const tRaw = await tok("raw-60", "expires_in_seconds=60", API_KEY);
  if (tRaw) {
    // Node 22 built-in WebSocket (browser-like, no headers)
    const r1 = await quick("token-global", { auth: { token: tRaw }, impl: "global", skipRateGuard: true });
    (cases["token-global"] as Record<string, unknown>).expiresInFromNowS = r1.begin ? r1.begin.expires_at - Math.round(Date.now() / 1000) : undefined;
    // reuse the same (now redeemed) token immediately, well inside its 60 s window
    await quick("token-reuse-ws", { auth: { token: tRaw }, impl: "ws", skipRateGuard: true });
    await quick("token-reuse-global", { auth: { token: tRaw }, impl: "global", skipRateGuard: true });
  }
  await rateGuard(tlog);
  const tBearer = await tok("bearer-60", "expires_in_seconds=60", `Bearer ${API_KEY}`);
  if (tBearer) await quick("token-from-bearer-mint", { auth: { token: tBearer }, impl: "ws", skipRateGuard: true });
  await rateGuard(tlog);
  const tCap = await tok("raw-60-cap60", "expires_in_seconds=60&max_session_duration_seconds=60", API_KEY);
  if (tCap) {
    const r = await quick("token-cap60", { auth: { token: tCap }, impl: "ws", skipRateGuard: true });
    (cases["token-cap60"] as Record<string, unknown>).expiresInFromNowS = r.begin ? r.begin.expires_at - Math.round(Date.now() / 1000) : undefined;
  }
  // an expired token: 1 s redemption window, wait 3 s
  await rateGuard(tlog);
  const tShort = await tok("raw-1", "expires_in_seconds=1", API_KEY);
  if (tShort) {
    await sleep(3000);
    await quick("token-expired", { auth: { token: tShort }, impl: "ws", skipRateGuard: true });
  }
  tlog.close();
  // bad token via the browser-like client: what does a browser see?
  await quick("bad-token-global", { auth: { token: "not-a-real-token-123456" }, impl: "global" });

  const ok = (k: string) => !!(cases[k] as { begin?: unknown } | undefined)?.begin;
  const status: Status = ok("header-raw") && ok("token-global") ? "PASS" : ok("header-raw") ? "PARTIAL" : "FAIL";
  return finish("auth", logger("auth"), status, { cite: ["C4 (streaming side)", "§2.2"], cases });
}

// =============================================================================================
// Core: dialog at real time, all Turns, latency vs script, WER-ish
// =============================================================================================
async function dialogRun(test: string, params: StreamingParams | Record<string, unknown>, extra: Partial<RunOptions> = {}) {
  const log = logger(test);
  const fx = loadFixture("dialog_mono_16k.wav");
  const r = await runSession({ log, params, fixture: fx, chunkMs: 50, tailMs: 2500, ...extra });
  bill(test, r);
  const script = dialogScript();
  const lat = turnLatencies(r, script.turns);
  const hyp = r.finals.map((f) => f.turn.transcript).join(" ");
  const ref = script.turns.map((t) => t.text).join(" ");
  const partials = r.turns.filter((t) => !(t.msg as TurnMessage).end_of_turn).length;
  const metrics = {
    finals: r.finals.length,
    partials,
    speechStarted: r.events.filter((e) => (e.msg as { type?: string }).type === "SpeechStarted").length,
    wer: wer(ref, hyp),
    entities: entityHits(hyp),
    firstPartialLatencyFromSpeechMs: lat[0]?.firstPartialLatencyMs,
    eotLatency: stats(lat.filter((l) => !l.merged).map((l) => l.eotLatencyMs)),
    eotLatencyVsLastWord: stats(lat.map((l) => l.eotLatencyVsWordMs)),
    firstPartialLatency: stats(lat.map((l) => l.firstPartialLatencyMs).filter((x): x is number => x !== undefined)),
    speechStartedLatency: stats(lat.map((l) => l.speechStartedLatencyMs).filter((x): x is number => x !== undefined)),
    mergedTurns: lat.filter((l) => l.merged).length,
    latencyRows: lat,
  };
  log.note("metrics", { ...metrics, latencyRows: undefined });
  log.close();
  return { r, lat, metrics, hyp, script };
}

async function testCore(): Promise<Status> {
  const { r, metrics } = await dialogRun("core", BASE);
  const status: Status = r.begin && r.termination && metrics.finals > 0 ? "PASS" : "FAIL";
  return finish("core", logger("core-result"), status, { cite: ["C14", "§2.3"], request: { params: BASE, fixture: "dialog_mono_16k.wav", chunkMs: 50, pacing: "real time, release at end of chunk" }, ...digest(r), metrics });
}

// =============================================================================================
// Diarization
// =============================================================================================
async function testDiarization(): Promise<Status> {
  const params = { ...BASE, speaker_labels: true, max_speakers: 2 };
  const { r, metrics, script } = await dialogRun("diarization", params);
  const finalsBefore = r.finals.map((f) => f.turn);
  const before = diarizationAccuracy(finalsBefore, script.turns);
  const after = diarizationAccuracy([...r.tracker.finals.values()], script.turns);
  const revisions = r.events.filter((e) => (e.msg as { type?: string }).type === "SpeakerRevision");
  const labelled = finalsBefore.filter((t) => t.speaker_label !== undefined).length;
  const status: Status = labelled > 0 ? ((after.words.accuracy ?? 0) >= 90 ? "PASS" : "PARTIAL") : "FAIL";
  return finish("diarization", logger("diarization-result"), status, {
    cite: ["§10 (02)"],
    request: { params },
    ...digest(r),
    metrics: { ...metrics, latencyRows: undefined },
    diarization: { labelledFinals: labelled, beforeRevision: before, afterRevision: after, speakerRevisionMessages: revisions.map((e) => ({ wallMs: e.wallMs, msg: brief(e.msg) })) },
    sampleFinalWithSpeaker: finalsBefore.find((t) => t.speaker_label) ? brief(finalsBefore.find((t) => t.speaker_label), 4) : undefined,
  });
}

// =============================================================================================
// PII
// =============================================================================================
async function testPii(): Promise<Status> {
  const params = { ...BASE, redact_pii: true, redact_pii_policies: ["person_name", "phone_number", "location_address"], redact_pii_sub: "entity_name" };
  const { r, metrics, hyp } = await dialogRun("pii", params);
  const partials = r.turns.filter((t) => !(t.msg as TurnMessage).end_of_turn);
  const leaks = ["Priya", "Shah", "Daniel", "Reyes", "Donnelly", "555", "0137", "Birchwood", "Maple"].filter((w) => hyp.includes(w));
  const partialLeaks = partials.filter((p) => /Priya|Shah|Daniel|Reyes|Donnelly|555/.test((p.msg as TurnMessage).transcript)).length;
  const status: Status = r.begin && metrics.finals > 0 ? (leaks.length === 0 ? "PASS" : "PARTIAL") : "FAIL";
  return finish("pii", logger("pii-result"), status, {
    cite: ["§4 redact_pii (02)"],
    request: { params },
    ...digest(r),
    metrics: { ...metrics, latencyRows: undefined },
    pii: { partialsReceived: partials.length, partialsWithRawPii: partialLeaks, finalLeaks: leaks, samplePartial: partials[0] ? brief(partials[0].msg) : undefined },
  });
}

async function testPiiHash(): Promise<Status> {
  const log = logger("pii-hash");
  const params = { ...BASE, redact_pii: true };
  const r = await runSession({ log, params, fixture: loadFixture("question_16k.wav"), tailMs: 2000 });
  bill("pii-hash", r);
  log.close();
  const status: Status = r.begin && r.finals.length ? "PASS" : "FAIL";
  return finish("pii-hash", logger("pii-hash-result"), status, { request: { params }, ...digest(r) });
}

// =============================================================================================
// Tuning: prompt + keyterms + turn params + vad + heartbeat; mid-stream UpdateConfiguration,
// ForceEndpoint, KeepAlive
// =============================================================================================
async function testTuning(): Promise<Status> {
  const params: StreamingParams = {
    ...BASE,
    prompt: "Insurance claim phone call between adjuster Daniel Reyes of Harbor Point and claimant Priya Shah about a rear-end collision, with policy and claim numbers, addresses, a phone number and dollar amounts.",
    keyterms_prompt: ["Harbor Point", "Daniel Reyes", "Priya Shah", "Mark Donnelly", "Lakeside Auto Body", "HP7740391", "Maple Avenue"],
    min_turn_silence: 200,
    max_turn_silence: 1200,
    vad_threshold: 0.3,
    session_heartbeat: true,
  };
  const schedule: RunOptions["schedule"] = [
    { atAudioMs: 20000, label: "KeepAlive", run: (s) => s.keepAlive() },
    {
      atAudioMs: 46300,
      label: "UpdateConfiguration(agent_context + entity turn silence)",
      run: (s) => s.updateConfiguration({ agent_context: "Got it. What's the best number to reach you?", min_turn_silence: 1000, max_turn_silence: 2500 }),
    },
    {
      atAudioMs: 54000,
      label: "UpdateConfiguration(keyterms replace + restore silence)",
      run: (s) => s.updateConfiguration({ keyterms_prompt: ["Birchwood Lane", "CL44812", "appraiser"], min_turn_silence: 200, max_turn_silence: 1200 }),
    },
    { atAudioMs: 62500, label: "ForceEndpoint (mid turn 14)", run: (s) => s.forceEndpoint() },
  ];
  const { r, metrics } = await dialogRun("tuning", params, { schedule });
  const fe = r.actions.find((a) => a.label.startsWith("ForceEndpoint"));
  const afterFe = fe ? r.finals.find((f) => f.wallMs >= fe.wallMs) : undefined;
  const heartbeats = r.events.filter((e) => (e.msg as { type?: string }).type === "Heartbeat");
  const status: Status = r.begin && r.errors.length === 0 && metrics.finals > 0 ? "PASS" : r.begin ? "PARTIAL" : "FAIL";
  return finish("tuning", logger("tuning-result"), status, {
    cite: ["C14", "C15", "§5.4", "§11", "§12"],
    request: { params, schedule: schedule.map((s) => ({ atAudioMs: s.atAudioMs, label: s.label })) },
    ...digest(r),
    metrics,
    forceEndpoint: fe ? { sentWallMs: fe.wallMs, nextFinalWallMs: afterFe?.wallMs, latencyMs: afterFe ? Math.round(afterFe.wallMs - fe.wallMs) : undefined, finalTranscript: afterFe?.turn.transcript } : undefined,
    heartbeat: { count: heartbeats.length, first: heartbeats[0]?.msg, last: heartbeats.at(-1)?.msg },
  });
}

// =============================================================================================
// Modes: Begin.configuration per mode (C14) + misspelled params
// =============================================================================================
async function testModes(): Promise<Status> {
  const cases: Record<string, unknown> = {};
  const variants: [string, Record<string, unknown>][] = [
    ["mode-min_latency", { ...BASE, mode: "min_latency" }],
    ["mode-balanced", { ...BASE, mode: "balanced" }],
    ["mode-max_accuracy", { ...BASE, mode: "max_accuracy" }],
    ["typo-params", { sample_rate: 16000, speechModel: "universal-streaming-english", min_turn_silense: 999, speaker_lables: true }],
    ["us-streaming-english-explicit", { ...BASE, speech_model: "universal-streaming-english", format_turns: true, end_of_turn_confidence_threshold: 0.6 }],
  ];
  for (const [name, params] of variants) {
    const log = logger(`modes-${name}`);
    const r = await runSession({ log, params, idleMs: 300 });
    bill("modes", r);
    cases[name] = digest(r);
    log.close();
  }
  return finish("modes", logger("modes"), "PASS", { cite: ["C14"], cases });
}

// =============================================================================================
// LLM Gateway in-stream (T11 / C28)
// =============================================================================================
const LLM_CFG = {
  model: "gemini-2.5-flash-lite",
  messages: [{ role: "user", content: "Classify the caller's intent in at most four words.\n\nCaller said: {{turn}}" }],
  max_tokens: 20,
};
async function testLlm(): Promise<Status> {
  const log = logger("llm");
  const params = { ...BASE, llm_gateway: LLM_CFG };
  const r = await runSession({ log, params, fixture: loadFixture("question_16k.wav"), tailMs: 6000 });
  bill("llm", r);
  log.close();
  const llm = r.events.filter((e) => (e.msg as { type?: string }).type === "LLMGatewayResponse");
  const lat = llm.map((e) => {
    const t = (e.msg as { turn_order: number }).turn_order;
    const fin = r.finals.find((f) => f.turn.turn_order === t);
    return { turn_order: t, finalWallMs: fin?.wallMs, llmWallMs: e.wallMs, afterFinalMs: fin ? Math.round(e.wallMs - fin.wallMs) : undefined };
  });
  const status: Status = llm.length > 0 ? "PASS" : r.begin ? "FAIL" : "FAIL";
  return finish("llm", logger("llm-result"), status, { cite: ["T11", "C28"], request: { params: { ...params, llm_gateway: LLM_CFG }, urlParamEncoding: "JSON.stringify(llm_gateway)" }, ...digest(r), llmResponses: llm.map((e) => ({ wallMs: e.wallMs, msg: e.msg })), llmLatency: lat });
}

async function testLlmStress(): Promise<Status> {
  // ForceEndpoint every 1.4 s of audio -> ~45 forced turns in ~70 s (> 30 req/min/model)
  const schedule: RunOptions["schedule"] = [];
  for (let t = 1400; t < 69000; t += 1400) schedule.push({ atAudioMs: t, label: `ForceEndpoint@${t}`, run: (s) => s.forceEndpoint() });
  const params = { ...BASE, llm_gateway: LLM_CFG };
  const { r, metrics } = await dialogRun("llm-stress", params, { schedule, tailMs: 8000 });
  const llm = r.events.filter((e) => (e.msg as { type?: string }).type === "LLMGatewayResponse");
  const perMinute = (() => {
    const w = llm.map((e) => e.wallMs);
    let best = 0;
    for (let i = 0; i < w.length; i++) best = Math.max(best, w.filter((x) => x >= w[i]! && x < w[i]! + 60000).length);
    return best;
  })();
  const llmErrors = llm.filter((e) => JSON.stringify(e.msg).toLowerCase().includes("error") || JSON.stringify(e.msg).includes("429"));
  const status: Status = llm.length === 0 ? "FAIL" : llm.length >= metrics.finals ? "PASS" : "PARTIAL";
  return finish("llm-stress", logger("llm-stress-result"), status, {
    cite: ["T11", "C28"],
    request: { params, forceEndpointEveryMs: 1400 },
    ...digest(r),
    metrics: { ...metrics, latencyRows: undefined },
    llm: { finals: metrics.finals, responses: llm.length, maxResponsesIn60s: perMinute, responsesMentioningError: llmErrors.map((e) => e.msg), sample: llm.slice(0, 2).map((e) => e.msg) },
  });
}

// =============================================================================================
// Multilingual code-switch
// =============================================================================================
async function testMultilingual(which: "multilingual" | "multilingual2" | "multilingual3" = "multilingual"): Promise<Status> {
  const fx = loadFixture("codeswitch_16k.wav");
  const cases: Record<string, unknown> = {};
  const variants: [string, Record<string, unknown>][] =
    which === "multilingual"
      ? [
          ["u35-detect", { ...BASE, language_detection: true }],
          ["multilingual-detect", { ...BASE, speech_model: "universal-streaming-multilingual", language_detection: true }],
          ["u35-codes-hi-en", { ...BASE, language_codes: ["hi", "en"], language_detection: true }],
        ]
      : which === "multilingual3"
        ? [["u35-codes-en-hi", { ...BASE, language_codes: ["en", "hi"], language_detection: true }]]
        : [
          ["u35-prompt-hinglish", { ...BASE, language_detection: true, prompt: "Customer support call in Hinglish. The caller mixes Hindi and English words in the same sentence and reads an order number digit by digit." }],
          ["u35-codes-en", { ...BASE, language_codes: ["en"], language_detection: true }],
          ["u35-codes-hi", { ...BASE, language_codes: ["hi"], language_detection: true }],
        ];
  for (const [name, params] of variants) {
    const log = logger(`${which}-${name}`);
    const r = await runSession({ log, params, fixture: fx, tailMs: 2500 });
    bill(which, r);
    const text = r.finals.map((f) => f.turn.transcript).join(" ");
    cases[name] = digest(r, { transcript: text, orderNumberOk: text.replace(/\D/g, "").includes("481529"), devanagari: /[ऀ-ॿ]/.test(text), languages: r.finals.map((f) => [f.turn.language_code, f.turn.language_confidence]) });
    log.close();
  }
  return finish(which, logger(which), "PASS", { cite: ["C17"], cases });
}

// =============================================================================================
// Telephony mu-law 8 kHz
// =============================================================================================
async function testMulaw(): Promise<Status> {
  const log = logger("mulaw");
  const params = { ...BASE, encoding: "pcm_mulaw" as const, sample_rate: 8000 };
  const r = await runSession({ log, params, fixture: loadFixture("question_8k.mulaw"), chunkMs: 100, tailMs: 2000 });
  bill("mulaw", r);
  log.close();
  const text = r.finals.map((f) => f.turn.transcript).join(" ");
  const status: Status = text.replace(/\D/g, "").includes("481529") ? "PASS" : r.finals.length ? "PARTIAL" : "FAIL";
  return finish("mulaw", logger("mulaw-result"), status, { request: { params, chunkMs: 100, bytesPerFrame: 800 }, ...digest(r, { transcript: text }) });
}

// =============================================================================================
// Error cases (C12 close codes)
// =============================================================================================
async function testErrors(): Promise<Status> {
  const q = loadFixture("question_16k.wav");
  const cases: Record<string, unknown> = {};
  const run = async (name: string, o: Partial<RunOptions>) => {
    const log = logger(`errors-${name}`);
    const r = await runSession({ log, params: BASE, tailMs: 1500, ...o });
    bill("errors", r);
    cases[name] = digest(r);
    log.close();
    return r;
  };
  // 20 ms frames -> 3007; stop at the first Error
  await run("chunk-20ms", { fixture: q, chunkMs: 20 });
  // one 1200 ms frame
  await run("chunk-1200ms", {
    customSend: async (s) => {
      await sleep(1200);
      s.sendAudio(q.bytes.subarray(0, 1200 * 32));
      await sleep(3000);
    },
  });
  // 2000 ms frame after correct frames? (keep it simple: one frame of exactly 1000 ms is legal)
  await run("chunk-1000ms-ok", {
    customSend: async (s) => {
      for (let i = 0; i < 3 && s.isOpen; i++) {
        await sleep(1000);
        s.sendAudio(q.bytes.subarray(i * 32000, (i + 1) * 32000));
      }
      await sleep(1500);
    },
  });
  await run("invalid-json", {
    customSend: async (s) => {
      s.sendRaw("{not json");
      await sleep(3000);
    },
  });
  await run("unknown-type", {
    customSend: async (s) => {
      s.sendRaw(JSON.stringify({ type: "Bogus" }));
      await sleep(3000);
    },
  });
  await run("inactivity-5s", { params: { ...BASE, inactivity_timeout: 5 }, idleMs: 9000, noTerminate: true });
  await run("sample-rate-7000", { params: { ...BASE, sample_rate: 7000 } });
  await run("encoding-bogus", { params: { ...BASE, encoding: "flac" } });
  await run("burst-10x", { fixture: q, chunkMs: 100, speed: 10, tailMs: 6000 });
  await run("terminate-immediately", { idleMs: 0 });
  return finish("errors", logger("errors"), "PASS", { cite: ["C12"], cases });
}


// =============================================================================================
// Follow-ups discovered while testing
// =============================================================================================

/** Dialog with an explicit mode, to compare SpeechStarted / final latency against balanced (core). */
async function testLatencyMode(mode: "min_latency" | "max_accuracy"): Promise<Status> {
  const name = mode === "min_latency" ? "latency-min" : "latency-max";
  const params = { ...BASE, mode };
  const { r, metrics } = await dialogRun(name, params);
  // word-anchored lags (robust to merged turns)
  const firstMsg = new Map<number, number>();
  const lagsFirst: number[] = [];
  for (const e of r.turns) {
    const t = e.msg as TurnMessage;
    if (!firstMsg.has(t.turn_order) && t.words?.length) {
      firstMsg.set(t.turn_order, e.wallMs);
      lagsFirst.push(Math.round(e.wallMs - t.words[0]!.start));
    }
  }
  const ss = r.events.filter((e) => (e.msg as { type?: string }).type === "SpeechStarted").map((e) => Math.round(e.wallMs - (e.msg as { timestamp: number }).timestamp));
  return finish(name, logger(`${name}-result`), r.begin && metrics.finals ? "PASS" : "FAIL", {
    cite: ["C13", "C14"],
    request: { params },
    ...digest(r),
    metrics: { ...metrics, latencyRows: undefined },
    wordAnchored: { firstMessageLagFromFirstWordStart: stats(lagsFirst), speechStartedLagFromTimestamp: stats(ss), finalLagFromLastWordEnd: metrics.eotLatencyVsLastWord },
  });
}

/** One session per channel (research-recommended alternative to diarization for 2-party calls). */
async function testStereo(): Promise<Status> {
  const { readWav } = await import("../lib/wav.ts");
  const { deinterleave, pcm16ToBytes } = await import("../lib/audio.ts");
  const { FIXTURES_DIR } = await import("../lib/env.ts");
  const w = readWav(`${FIXTURES_DIR}/dialog_stereo_16k.wav`);
  const [L, R] = deinterleave(w.samples, 2);
  const mk = (name: string, s: Int16Array) => ({ name, bytes: pcm16ToBytes(s), sampleRate: 16000, bytesPerSample: 2 as const, durationMs: w.durationMs });
  const logL = logger("stereo-left-adjuster");
  const logR = logger("stereo-right-claimant");
  const [rl, rr] = await Promise.all([
    runSession({ log: logL, params: BASE, fixture: mk("L", L!), tailMs: 2500 }),
    runSession({ log: logR, params: BASE, fixture: mk("R", R!), tailMs: 2500 }),
  ]);
  bill("stereo", rl);
  bill("stereo", rr);
  const script = dialogScript();
  const merged = [
    ...rl.finals.map((f) => ({ ch: "adjuster", t: f.turn, wallMs: f.wallMs })),
    ...rr.finals.map((f) => ({ ch: "claimant", t: f.turn, wallMs: f.wallMs })),
  ]
    .filter((x) => x.t.words?.length)
    .sort((a, b) => a.t.words[0]!.start - b.t.words[0]!.start);
  const hyp = merged.map((x) => x.t.transcript).join(" ");
  const ref = script.turns.map((t) => t.text).join(" ");
  // each final should sit inside exactly one script turn of its own speaker
  const rows = merged.map((x) => {
    // anchor on the LAST word end: a turn-initial word's start timestamp runs ~1 s early after silence
    const st = scriptTurnAt(script.turns, x.t.words.at(-1)!.end - 1);
    return { ch: x.ch, scriptTurn: st?.index, scriptSpeaker: st?.speaker, ok: st?.speaker === x.ch, lagFromLastWordEnd: Math.round(x.wallMs - x.t.words.at(-1)!.end), transcript: x.t.transcript };
  });
  const lags = rows.map((r) => r.lagFromLastWordEnd);
  return finish("stereo", logger("stereo-result"), rows.every((r) => r.ok) ? "PASS" : "PARTIAL", {
    request: { params: BASE, sessions: 2, fixture: "dialog_stereo_16k.wav (L=adjuster, R=claimant)" },
    left: digest(rl),
    right: digest(rr),
    merged: { wer: wer(ref, hyp), entities: entityHits(hyp), finals: rows.length, speakerCorrect: rows.filter((r) => r.ok).length, finalLag: stats(lags), rows },
  });
}

/** Is a token single-use when a session using it is still open? */
async function testAuthConcurrent(): Promise<Status> {
  const tlog = logger("auth2-token-http");
  await rateGuard(tlog);
  const r = await loggedFetch<{ token?: string }>(tlog, `${STREAMING_TOKEN_URL}?expires_in_seconds=60`, { label: "mint", headers: { Authorization: API_KEY } });
  const token = r.json?.token;
  tlog.close();
  if (!token) return finish("auth2", logger("auth2"), "FAIL", { error: r.text.slice(0, 300) });
  const logA = logger("auth2-A");
  const logB = logger("auth2-B");
  const pA = runSession({ log: logA, params: BASE, auth: { token }, impl: "global", skipRateGuard: true, idleMs: 6000 });
  await sleep(2500); // A is open and idle
  const rB = await runSession({ log: logB, params: BASE, auth: { token }, impl: "global", skipRateGuard: true, idleMs: 500 });
  const rA = await pA;
  bill("auth2", rA);
  bill("auth2", rB);
  return finish("auth2", logger("auth2"), "PASS", { cite: ["§2.2 single-use tokens"], A: digest(rA), B: digest(rB), concurrentReuseAccepted: !!rB.begin });
}

/** File streaming: does the last turn finalize without Terminate if we append silence? */
async function testTailSilence(): Promise<Status> {
  const q = loadFixture("question_16k.wav");
  const withSilence = { ...q, name: "question_16k+2s", bytes: Buffer.concat([Buffer.from(q.bytes), Buffer.alloc(2000 * 32)]), durationMs: q.durationMs + 2000 };
  const log = logger("tail-silence");
  const r = await runSession({ log, params: BASE, fixture: withSilence, tailMs: 500 });
  bill("tail-silence", r);
  const lastFinal = r.finals.at(-1);
  const beforeTerminate = lastFinal && r.terminateSentWall !== undefined ? lastFinal.wallMs < r.terminateSentWall : false;
  return finish("tail-silence", logger("tail-silence-result"), beforeTerminate ? "PASS" : "FAIL", {
    request: { params: BASE, fixture: "question_16k.wav + 2000 ms digital silence", chunkMs: 50 },
    ...digest(r),
    lastFinalBeforeTerminate: beforeTerminate,
    lastFinalLagFromLastWordEnd: lastFinal ? Math.round(lastFinal.wallMs - lastFinal.turn.words.at(-1)!.end) : undefined,
  });
}


/** Documented limits: agent_context (C15), prompt, keyterms count, language_codes incl. Catalan (C17). */
async function testLimits(): Promise<Status> {
  const cases: Record<string, unknown> = {};
  const long = (n: number) => "The agent asked the caller for the policy number and the date of the accident. ".repeat(Math.ceil(n / 80)).slice(0, n);
  const run = async (name: string, o: Partial<RunOptions>) => {
    const log = logger(`limits-${name}`);
    const r = await runSession({ log, params: BASE, idleMs: 1500, ...o });
    bill("limits", r);
    cases[name] = digest(r);
    log.close();
  };
  await run("agent_context-url-1800", { params: { ...BASE, agent_context: long(1800) } });
  await run("agent_context-update-2500", {
    customSend: async (s) => {
      s.updateConfiguration({ agent_context: long(2500) });
      await sleep(2500);
    },
  });
  await run("prompt-url-1800", { params: { ...BASE, prompt: long(1800) } });
  await run("keyterms-101", { params: { ...BASE, keyterms_prompt: Array.from({ length: 101 }, (_, i) => `Term${i}`) } });
  await run("keyterm-60-chars", { params: { ...BASE, keyterms_prompt: ["x".repeat(60), "Harbor Point"] } });
  await run("language_codes-ca", { params: { ...BASE, language_codes: ["ca"] } });
  await run("language_codes-xx", { params: { ...BASE, language_codes: ["xx"] } });
  return finish("limits", logger("limits"), "PASS", { cite: ["C15", "C17"], cases });
}

// =============================================================================================

const TESTS: Record<string, () => Promise<Status>> = {
  models: () => testModels("models"),
  models2: () => testModels("models2"),
  auth: testAuth,
  core: testCore,
  diarization: testDiarization,
  pii: testPii,
  "pii-hash": testPiiHash,
  tuning: testTuning,
  modes: testModes,
  llm: testLlm,
  "llm-stress": testLlmStress,
  multilingual: () => testMultilingual("multilingual"),
  multilingual2: () => testMultilingual("multilingual2"),
  multilingual3: () => testMultilingual("multilingual3"),
  mulaw: testMulaw,
  errors: testErrors,
  "latency-min": () => testLatencyMode("min_latency"),
  "latency-max": () => testLatencyMode("max_accuracy"),
  stereo: testStereo,
  auth2: testAuthConcurrent,
  "tail-silence": testTailSilence,
  limits: testLimits,
};

const want = process.argv.slice(2);
if (!want.length || want.some((w) => !TESTS[w])) {
  console.error(`usage: tsx streaming/smoke.ts <${Object.keys(TESTS).join("|")}> ...`);
  process.exit(2);
}
const results: Record<string, Status> = {};
for (const w of want) {
  try {
    results[w] = await TESTS[w]!();
  } catch (e) {
    console.error(`${w} crashed:`, e);
    results[w] = "FAIL";
    const l = logger(`${w}-crash`);
    l.error(e);
  }
}
for (const l of loggers) l.close();
console.log("\nRESULTS", results, "\nBILLING", billing);
