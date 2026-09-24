/**
 * async/smoke.ts - AssemblyAI async transcription + Speech Understanding smoke tests.
 *
 *   npx tsx async/smoke.ts                      # everything
 *   npx tsx async/smoke.ts --only=full,su-posthoc
 *   npx tsx async/smoke.ts --reuse              # reuse uploads/transcript ids from out/async-state.json
 *
 * Tests (each logs to out/async-<test>.jsonl, full responses to out/async-<test>.*.json):
 *   upload, negative, full, su-inline, golden, su-posthoc, sentences, multichannel, su-multichannel, fallback
 * Summary: out/async-summary.json.   Transcripts are NOT deleted (permanent delete; they expire on
 * AssemblyAI's default 30-day TTL). Their ids are listed in the summary.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ASSEMBLYAI_API_KEY, FIXTURES_DIR, OUT_DIR } from "../lib/env.ts";
import { createLogger, type JsonlLogger } from "../lib/log.ts";
import {
  AssemblyAIAsyncClient,
  AssemblyAIHttpError,
  billableSeconds,
  formatUtterances,
  type SpeechUnderstandingFeatureRequests,
  type Transcript,
  type TranscriptParams,
  type UnderstandingResult,
} from "./client.ts";
import { compareWordTimings, entitySummary, factsFound, loadDialogScript, redactionReport, sentimentReport, speakerAccuracy, utteranceAlignment } from "./compare.ts";
import { loggingFetch } from "./http-log.ts";

type Status = "PASS" | "FAIL" | "PARTIAL" | "SKIPPED";

const argv = process.argv.slice(2);
const only = argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const reuse = argv.includes("--reuse");
const want = (name: string): boolean => !only || only.includes(name);

const STATE_PATH = resolve(OUT_DIR, "async-state.json");
interface State {
  uploads: Record<string, string>;
  transcripts: Record<string, string>;
  updated_at?: string;
}
const state: State = existsSync(STATE_PATH) ? (JSON.parse(readFileSync(STATE_PATH, "utf8")) as State) : { uploads: {}, transcripts: {} };
const saveState = (): void => {
  state.updated_at = new Date().toISOString();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
};

const SUMMARY_PATH = resolve(OUT_DIR, "async-summary.json");
const summary: Record<string, unknown> = existsSync(SUMMARY_PATH) ? (JSON.parse(readFileSync(SUMMARY_PATH, "utf8")) as Record<string, unknown>) : {};
const script = loadDialogScript();

const KEYTERMS = ["Harbor Point", "Daniel Reyes", "Priya Shah", "Mark Donnelly", "Lakeside Auto Body", "Birchwood Lane", "Maple Avenue", "Springfield", "deductible", "appraiser"];
const PII_POLICIES_USED = [
  "person_name",
  "phone_number",
  "location",
  "location_address",
  "location_address_street",
  "location_city",
  "account_number",
  "number_sequence",
  "money_amount",
  "date",
  "organization",
] as const;

function saveJson(name: string, data: unknown): string {
  const p = resolve(OUT_DIR, name);
  writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}

/** Keys + types of an object (one level), for "response shape" records. */
function shapeOf(o: unknown): Record<string, string> {
  if (!o || typeof o !== "object") return { value: typeof o };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    out[k] = v === null ? "null" : Array.isArray(v) ? `array(${v.length})` : typeof v === "object" ? `object{${Object.keys(v as object).join(",")}}` : typeof v === "string" ? `string(${(v as string).length})` : typeof v;
  }
  return out;
}

function trunc(s: string | null | undefined, n = 400): string | null {
  if (s == null) return null;
  return s.length > n ? `${s.slice(0, n)}...[+${s.length - n}]` : s;
}

async function withTest(name: string, fn: (log: JsonlLogger, client: AssemblyAIAsyncClient) => Promise<{ status: Status; details: Record<string, unknown> }>): Promise<void> {
  if (!want(name)) return;
  const log = createLogger(`async-${name}`);
  const client = new AssemblyAIAsyncClient({
    apiKey: ASSEMBLYAI_API_KEY,
    fetch: loggingFetch(log),
    onRateLimit: (i) => log.note("rate-limited (waiting retry-after)", { url: i.url, waitMs: i.waitMs, attempt: i.attempt, limit: i.headers["x-ratelimit-limit"], service: i.headers["x-ratelimit-service"] }),
  });
  const t0 = performance.now();
  let status: Status = "FAIL";
  let details: Record<string, unknown> = {};
  try {
    ({ status, details } = await fn(log, client));
  } catch (err) {
    log.error(err);
    details = { error: err instanceof AssemblyAIHttpError ? { status: err.status, body: err.body } : String(err) };
  }
  const wallMs = Math.round(performance.now() - t0);
  log.result(status, { wallMs, ...details });
  log.close();
  summary[name] = { status, wallMs, ...details };
  writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  console.log(`[async-${name}] ${status} (${wallMs} ms)`);
}

/** submit + poll with timing info logged. */
async function transcribeTimed(log: JsonlLogger, client: AssemblyAIAsyncClient, params: TranscriptParams) {
  const t0 = performance.now();
  const queued = await client.submit(params);
  const submitMs = Math.round(performance.now() - t0);
  log.note("queued", { id: queued.id, status: queued.status, submitMs, queuedShape: shapeOf(queued) });
  const statuses: Array<{ status: string; atMs: number }> = [];
  const done = await client.waitForCompletion(queued.id, {
    onPoll: (p) => {
      if (statuses.at(-1)?.status !== p.status) statuses.push({ status: p.status, atMs: Math.round(performance.now() - t0) });
    },
  });
  const totalMs = Math.round(performance.now() - t0);
  const timing = { submitMs, totalMs, statuses, audioSec: done.audio_duration, rtf: done.audio_duration ? Math.round((totalMs / 1000 / done.audio_duration) * 100) / 100 : null };
  log.note("completed", { id: done.id, timing });
  return { t: done, timing };
}

async function uploadFixture(log: JsonlLogger, client: AssemblyAIAsyncClient, key: string, file: string): Promise<{ url: string; ms: number; bytes: number }> {
  if (reuse && state.uploads[key]) return { url: state.uploads[key], ms: 0, bytes: 0 };
  const bytes = readFileSync(resolve(FIXTURES_DIR, file));
  const t0 = performance.now();
  const url = await client.upload(bytes);
  const ms = Math.round(performance.now() - t0);
  state.uploads[key] = url;
  saveState();
  log.note("uploaded", { key, file, bytes: bytes.length, ms, upload_url_shape: url.replace(/\/[0-9a-f-]{16,}/g, "/<id>") });
  return { url, ms, bytes: bytes.length };
}

async function ensureUpload(log: JsonlLogger, client: AssemblyAIAsyncClient, key: string, file: string): Promise<string> {
  if (state.uploads[key]) return state.uploads[key];
  return (await uploadFixture(log, client, key, file)).url;
}

function wordSpeakerLabels(t: Transcript): string[] {
  return [...new Set((t.words ?? []).map((w) => String(w.speaker)))];
}

// =============================================================================================
// 1. upload
// =============================================================================================
await withTest("upload", async (log, client) => {
  const results: Record<string, unknown> = {};
  for (const [key, file] of [
    ["mono", "dialog_mono_16k.wav"],
    ["stereo", "dialog_stereo_16k.wav"],
    ["question", "question_16k.wav"],
    ["codeswitch", "codeswitch_16k.wav"],
  ] as const) {
    const r = await uploadFixture(log, client, key, file);
    results[key] = { ms: r.ms, bytes: r.bytes, upload_url: r.url.replace(/\/[0-9a-f-]{16,}/g, "/<id>") };
  }
  return { status: "PASS", details: { request: "POST https://api.assemblyai.com/v2/upload (application/octet-stream, raw WAV bytes, Authorization: <key>)", results } };
});

// =============================================================================================
// 2. negative - request validation (400s are free; anything accepted is a 7 s clip)
// =============================================================================================
await withTest("negative", async (log, client) => {
  const audio_url = await ensureUpload(log, client, "question", "question_16k.wav");
  const cases: Array<{ name: string; params: Record<string, unknown> }> = [
    { name: "retired model universal-3-pro", params: { audio_url, speech_models: ["universal-3-pro"], language_code: "en" } },
    { name: "fabricated PII policy 'gender'", params: { audio_url, speech_models: ["universal-3-5-pro"], language_code: "en", redact_pii: true, redact_pii_policies: ["person_name", "gender"] } },
    { name: "language_detection:false without language_code", params: { audio_url, speech_models: ["universal-3-5-pro"], language_detection: false } },
    { name: "redact_pii_return_unredacted without redact_pii", params: { audio_url, speech_models: ["universal-3-5-pro"], language_code: "en", redact_pii_return_unredacted: true } },
    { name: "speakers_expected + speaker_options", params: { audio_url, speech_models: ["universal-3-5-pro"], language_code: "en", speaker_labels: true, speakers_expected: 2, speaker_options: { min_speakers_expected: 1, max_speakers_expected: 3 } } },
    { name: "speaker_identification without speaker_labels", params: { audio_url, speech_models: ["universal-3-5-pro"], language_code: "en", speech_understanding: { request: { speaker_identification: { speaker_type: "role", known_values: ["Agent", "Customer"] } } } } },
    { name: "language_code 'en_us' on universal-3-5-pro", params: { audio_url, speech_models: ["universal-3-5-pro"], language_detection: false, language_code: "en_us" } },
  ];
  const out: Array<Record<string, unknown>> = [];
  for (const c of cases) {
    try {
      const q = await client.submit(c.params as unknown as TranscriptParams);
      // accepted: wait so we also see processing-time errors (cheap: 7.3 s clip)
      let final: Transcript | undefined;
      let finalErr: string | undefined;
      try {
        final = await client.waitForCompletion(q.id, { timeoutMs: 180_000 });
      } catch (e) {
        finalErr = e instanceof Error ? e.message : String(e);
      }
      out.push({ case: c.name, accepted: true, id: q.id, finalStatus: final?.status ?? "error", finalError: finalErr ?? null, speech_model_used: final?.speech_model_used ?? null, language_code: final?.language_code ?? null, text: trunc(final?.text, 120) });
    } catch (e) {
      out.push({ case: c.name, accepted: false, httpStatus: e instanceof AssemblyAIHttpError ? e.status : null, body: e instanceof AssemblyAIHttpError ? e.body : String(e) });
    }
  }
  for (const o of out) log.note("case", o);
  return { status: "PASS", details: { cases: out } };
});

// =============================================================================================
// 3. full - all transcription-level features on the mono dialog
// =============================================================================================
await withTest("full", async (log, client) => {
  const audio_url = await ensureUpload(log, client, "mono", "dialog_mono_16k.wav");
  const params: TranscriptParams = {
    audio_url,
    speech_models: ["universal-3-5-pro"],
    language_detection: false,
    language_code: "en",
    speaker_labels: true,
    speakers_expected: 2,
    entity_detection: true,
    sentiment_analysis: true,
    keyterms_prompt: KEYTERMS,
    redact_pii: true,
    redact_pii_policies: [...PII_POLICIES_USED],
    redact_pii_sub: "entity_name",
    redact_pii_return_unredacted: true,
    redact_pii_audio: true,
    redact_pii_audio_quality: "mp3",
  };
  let t: Transcript;
  let timing: unknown;
  if (reuse && state.transcripts.full) {
    t = await client.get(state.transcripts.full);
    timing = "reused";
  } else {
    ({ t, timing } = await transcribeTimed(log, client, params));
    state.transcripts.full = t.id;
    saveState();
  }
  saveJson("async-full.transcript.json", t);

  // redacted audio
  let redacted: Record<string, unknown> = {};
  try {
    const t0 = performance.now();
    const r = await client.waitForRedactedAudio(t.id, { timeoutMs: 180_000 });
    const readyMs = Math.round(performance.now() - t0);
    let head: Record<string, unknown> = {};
    let probe: Record<string, unknown> = {};
    if (r.redacted_audio_url) {
      // HEAD is rejected (403) by the GET-signed S3 URL; probe with a 16-byte ranged GET (nothing is saved).
      const h = await fetch(r.redacted_audio_url, { method: "HEAD", signal: AbortSignal.timeout(20_000) });
      head = { status: h.status, contentType: h.headers.get("content-type") };
      const g = await fetch(r.redacted_audio_url, { headers: { range: "bytes=0-15" }, signal: AbortSignal.timeout(20_000) });
      const buf = Buffer.from(await g.arrayBuffer());
      probe = {
        status: g.status,
        contentType: g.headers.get("content-type"),
        contentRange: g.headers.get("content-range"),
        firstBytesHex: buf.subarray(0, 4).toString("hex"),
        looksLike: buf.subarray(0, 3).toString("latin1") === "ID3" ? "mp3 (ID3 tag)" : buf[0] === 0xff && ((buf[1] ?? 0) & 0xe0) === 0xe0 ? "mp3 (frame sync)" : buf.subarray(0, 4).toString("latin1") === "RIFF" ? "wav" : "unknown",
      };
    }
    head = { ...head, rangedGet: probe };
    const u = r.redacted_audio_url ? new URL(r.redacted_audio_url) : null;
    redacted = { status: r.status, readyMs, url_host: u?.host, url_path_shape: u?.pathname.replace(/[0-9a-f-]{36}/g, "<uuid>"), url_query_keys: u ? [...u.searchParams.keys()] : [], head };
  } catch (e) {
    redacted = { error: e instanceof AssemblyAIHttpError ? { status: e.status, body: e.body } : String(e) };
  }
  log.note("redacted-audio", redacted);

  const ents = entitySummary(t.entities);
  const sentiments = t.sentiment_analysis_results ?? [];
  const sentimentCounts: Record<string, number> = {};
  for (const s of sentiments) sentimentCounts[`${s.speaker}:${s.sentiment}`] = (sentimentCounts[`${s.speaker}:${s.sentiment}`] ?? 0) + 1;
  const report = {
    speech_model_used: t.speech_model_used,
    language_code: t.language_code,
    audio_duration: t.audio_duration,
    confidence: t.confidence,
    topLevelShape: shapeOf(t),
    text_redacted: trunc(t.text, 1200),
    unredacted_text: trunc(t.unredacted_text, 1200),
    utterances: (t.utterances ?? []).map((u) => ({ speaker: u.speaker, start: u.start, end: u.end, text: trunc(u.text, 140) })),
    utteranceShape: shapeOf(t.utterances?.[0]),
    wordShape: shapeOf(t.words?.[0]),
    sampleWord: t.words?.[0],
    wordSpeakerLabels: wordSpeakerLabels(t),
    unredactedUtterancesCount: t.unredacted_utterances?.length ?? null,
    unredactedWordsCount: t.unredacted_words?.length ?? null,
    entities: ents,
    sentimentCount: sentiments.length,
    sentimentCounts,
    sentimentShape: shapeOf(sentiments[0]),
    sampleSentiments: sentiments.slice(0, 4),
    factsUnredacted: factsFound(t.unredacted_text),
    redaction: redactionReport(t),
    sentiment: sentimentReport(t, script),
    entityPiiLeak: Object.entries(ents.factsInEntities).filter(([, v]) => v).map(([k]) => k),
    wordParity: { words: t.words?.length ?? 0, unredacted_words: t.unredacted_words?.length ?? 0, utterances: t.utterances?.length ?? 0, unredacted_utterances: t.unredacted_utterances?.length ?? 0 },
    languageCodeEcho: t.language_code,
    speakerOptionsEcho: t.speaker_options ?? null,
    speakerAccuracy: speakerAccuracy(t.unredacted_words ?? t.words, script),
    alignment: utteranceAlignment(t.unredacted_utterances ?? t.utterances, script),
    redactedAudio: redacted,
  };
  saveJson("async-full.report.json", report);
  log.note("report", report);
  const ok =
    t.status === "completed" &&
    (t.utterances?.length ?? 0) > 0 &&
    wordSpeakerLabels(t).length === 2 &&
    (t.entities?.length ?? 0) > 0 &&
    sentiments.length > 0 &&
    typeof t.unredacted_text === "string" &&
    redacted.status === "redacted_audio_ready";
  return {
    status: ok ? "PASS" : "PARTIAL",
    details: {
      id: t.id,
      request: { ...params, audio_url: "<upload_url>" },
      timing,
      speech_model_used: t.speech_model_used,
      speakerAccuracy: report.speakerAccuracy.accuracy,
      speakerMapping: report.speakerAccuracy.mapping,
      utterances: report.utterances.length,
      alignmentMeanAbsStartMs: report.alignment.meanAbsStartMs,
      entitiesByType: ents.byType,
      sentimentCounts,
      redactionTags: report.redaction.tags,
      notRedacted: report.redaction.rows.filter((x) => !x.redacted).map((x) => x.fact),
      redactedAudio: redacted,
      factsUnredacted: report.factsUnredacted,
      sentiment: report.sentiment,
      entityPiiLeak: report.entityPiiLeak,
      wordParity: report.wordParity,
      languageCodeEcho: report.languageCodeEcho,
      speakerOptionsEcho: report.speakerOptionsEcho,
    },
  };
});

// =============================================================================================
// 4. su-inline - Speech Understanding inside POST /v2/transcript
// =============================================================================================
const ROLE_SPEAKERS = [
  { role: "Adjuster", description: "Insurance claims adjuster at Harbor Point who answers the call and asks the questions" },
  { role: "Claimant", description: "Driver reporting a car accident and filing the claim" },
];
const TRANSLATION = { target_languages: ["es"], match_original_utterance: true };
const FORMATTING = { date: "mm/dd/yyyy", phone_number: "(xxx)xxx-xxxx", email: "username@domain.com", format_utterances: true };

function suReport(t: Transcript | UnderstandingResult) {
  const su = t.speech_understanding ?? null;
  const words = t.words ?? (t.utterances ?? []).flatMap((u) => u.words ?? []);
  const roleMap = (label: string): string | undefined => (/adjuster/i.test(label) ? "adjuster" : /claimant/i.test(label) ? "claimant" : /daniel|reyes/i.test(label) ? "adjuster" : /priya|shah/i.test(label) ? "claimant" : undefined);
  return {
    topLevelShape: shapeOf(t),
    speech_understanding: su ? { request: su.request, responseShape: shapeOf(su.response), response: su.response ? Object.fromEntries(Object.entries(su.response).map(([k, v]) => [k, k === "custom_formatting" ? { ...(v as object), formatted_utterances: `<${((v as { formatted_utterances?: unknown[] }).formatted_utterances ?? []).length} utterances>`, formatted_text: trunc((v as { formatted_text?: string }).formatted_text, 600) } : v])) : null } : null,
    utteranceSpeakers: [...new Set((t.utterances ?? []).map((u) => u.speaker))],
    wordSpeakers: [...new Set(words.map((w) => String(w.speaker)))],
    speakerAccuracyByRole: speakerAccuracy(words, script, roleMap),
    translated_texts: t.translated_texts ? Object.fromEntries(Object.entries(t.translated_texts).map(([k, v]) => [k, trunc(v, 500)])) : null,
    utteranceTranslatedSample: (t.utterances ?? []).slice(0, 3).map((u) => ({ speaker: u.speaker, text: trunc(u.text, 100), translated_texts: u.translated_texts ?? null })),
    textSample: trunc(t.text, 600),
    formattedMapping: t.speech_understanding?.response?.custom_formatting?.mapping ?? null,
    formattedUtteranceSample: (t.speech_understanding?.response?.custom_formatting?.formatted_utterances ?? []).slice(9, 12).map((u) => ({ speaker: u.speaker, text: u.text })),
  };
}

await withTest("su-inline", async (log, client) => {
  const audio_url = await ensureUpload(log, client, "mono", "dialog_mono_16k.wav");
  const base: TranscriptParams = { audio_url, speech_models: ["universal-3-5-pro"], language_detection: false, language_code: "en", speaker_labels: true, speakers_expected: 2, keyterms_prompt: KEYTERMS };
  const attempts: Array<{ name: string; request: SpeechUnderstandingFeatureRequests }> = [
    { name: "all three (speakers[] role + translation + custom_formatting)", request: { speaker_identification: { speaker_type: "role", speakers: ROLE_SPEAKERS }, translation: TRANSLATION, custom_formatting: FORMATTING } },
  ];
  const results: Array<Record<string, unknown>> = [];
  let status: Status = "FAIL";
  for (const a of attempts) {
    try {
      let t: Transcript;
      let timing: unknown = "reused";
      if (reuse && state.transcripts.suInline) t = await client.get(state.transcripts.suInline);
      else {
        ({ t, timing } = await transcribeTimed(log, client, { ...base, speech_understanding: { request: a.request } }));
        state.transcripts.suInline = t.id;
        saveState();
      }
      saveJson("async-su-inline.transcript.json", t);
      const rep = suReport(t);
      log.note("su-inline report", rep);
      results.push({ attempt: a.name, id: t.id, timing, ...rep });
      const r = t.speech_understanding?.response;
      const allOk = r?.speaker_identification?.status === "success" && r?.translation?.status === "success" && r?.custom_formatting?.status === "success";
      status = allOk ? "PASS" : "PARTIAL";
    } catch (e) {
      results.push({ attempt: a.name, error: e instanceof AssemblyAIHttpError ? { status: e.status, body: e.body } : String(e) });
    }
  }
  return { status, details: { request: { ...base, audio_url: "<upload_url>", speech_understanding: { request: attempts[0]?.request } }, results } };
});

// =============================================================================================
// 4b. golden - the recommended product request in ONE call: redaction + unredacted + inline SU
// =============================================================================================
await withTest("golden", async (log, client) => {
  const audio_url = await ensureUpload(log, client, "mono", "dialog_mono_16k.wav");
  const params: TranscriptParams = {
    audio_url,
    speech_models: ["universal-3-5-pro", "universal-2"],
    language_detection: false,
    language_code: "en",
    speaker_labels: true,
    speakers_expected: 2,
    keyterms_prompt: KEYTERMS,
    entity_detection: true,
    redact_pii: true,
    redact_pii_policies: ["person_name", "phone_number", "location", "location_address", "location_address_street", "location_city", "account_number", "number_sequence", "date", "email_address", "us_social_security_number", "credit_card_number", "date_of_birth"],
    redact_pii_sub: "entity_name",
    redact_pii_return_unredacted: true,
    redact_pii_audio: true,
    speech_understanding: {
      request: {
        speaker_identification: { speaker_type: "role", known_values: ["Adjuster", "Claimant"] },
        translation: { target_languages: ["es"], match_original_utterance: true },
        custom_formatting: { date: "mm/dd/yyyy", phone_number: "(xxx)xxx-xxxx", format_utterances: true },
      },
    },
  };
  let t: Transcript;
  let timing: unknown = "reused";
  let conflict: unknown = null;
  if (reuse && state.transcripts.golden) {
    t = await client.get(state.transcripts.golden);
    conflict = "see earlier run";
  } else {
    try {
      ({ t, timing } = await transcribeTimed(log, client, params));
    } catch (e) {
      // Observed: 400 "redact pii phone_number not compatible with formatting phone_number; redact pii date not compatible with formatting date"
      if (!(e instanceof AssemblyAIHttpError) || e.status !== 400) throw e;
      conflict = { status: e.status, body: e.body };
      log.note("redaction + custom_formatting conflict; retrying without custom_formatting", conflict);
      const { custom_formatting: _drop, ...rest } = params.speech_understanding!.request;
      params.speech_understanding = { request: rest };
      ({ t, timing } = await transcribeTimed(log, client, params));
    }
    state.transcripts.golden = t.id;
    saveState();
  }
  saveJson("async-golden.transcript.json", t);
  const r = t.speech_understanding?.response;
  const es = t.translated_texts?.es ?? "";
  const fmt = r?.custom_formatting;
  const rep = {
    speech_model_used: t.speech_model_used,
    suStatuses: Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k, (v as { status?: string }).status])),
    mapping: r?.speaker_identification?.mapping ?? null,
    utteranceSpeakers: [...new Set((t.utterances ?? []).map((u) => u.speaker))],
    unredactedUtteranceSpeakers: [...new Set((t.unredacted_utterances ?? []).map((u) => u.speaker))],
    wordSpeakers: wordSpeakerLabels(t),
    unredactedWordSpeakers: [...new Set((t.unredacted_words ?? []).map((w) => String(w.speaker)))],
    roleAccuracy: speakerAccuracy(t.unredacted_words ?? t.words, script, (l) => (/adjuster/i.test(l) ? "adjuster" : /claimant/i.test(l) ? "claimant" : undefined)).accuracy,
    textIsRedacted: /\[PERSON_NAME\]/.test(t.text ?? ""),
    translationIsRedacted: /\[PERSON_NAME\]|PERSON_NAME|\[NOMBRE/i.test(es),
    translationHasRawPII: /Priya|Shah|415/.test(es),
    translationSample: trunc(es, 300),
    utteranceTranslationSample: (t.utterances ?? [])[1]?.translated_texts ?? null,
    formattedTextIsRedacted: /\[PERSON_NAME\]/.test(fmt?.formatted_text ?? ""),
    formattedHasRawPhone: /\(415\)555-0137|415-555-0137/.test(fmt?.formatted_text ?? ""),
    formattedMapping: fmt?.mapping ?? null,
    formattedSample: trunc(fmt?.formatted_text, 300),
    entitiesCount: t.entities?.length ?? 0,
    redactionTags: redactionReport(t).tags,
    factsUnredacted: Object.values(factsFound(t.unredacted_text)).filter(Boolean).length,
  };
  log.note("golden report", rep);
  const ok = Object.values(rep.suStatuses).every((s) => s === "success") && rep.textIsRedacted && (rep.roleAccuracy ?? 0) > 0.95;
  return { status: ok ? "PASS" : "PARTIAL", details: { id: t.id, firstAttemptConflict: conflict, finalRequest: { ...params, audio_url: "<upload_url>" }, timing, ...rep } };
});

// =============================================================================================
// 5. su-posthoc - POST https://llm-gateway.assemblyai.com/v1/understanding on a finished transcript
// =============================================================================================
await withTest("su-posthoc", async (log, client) => {
  const audio_url = await ensureUpload(log, client, "mono", "dialog_mono_16k.wav");
  const baseParams: TranscriptParams = { audio_url, speech_models: ["universal-3-5-pro"], language_detection: false, language_code: "en", speaker_labels: true, speakers_expected: 2, keyterms_prompt: KEYTERMS };
  let base: Transcript;
  let baseTiming: unknown = "reused";
  if (reuse && state.transcripts.base) base = await client.get(state.transcripts.base);
  else {
    ({ t: base, timing: baseTiming } = await transcribeTimed(log, client, baseParams));
    state.transcripts.base = base.id;
    saveState();
  }
  saveJson("async-base.transcript.json", base);
  const baseSpeakers = speakerAccuracy(base.words, script);
  log.note("base", { id: base.id, speakers: wordSpeakerLabels(base), accuracy: baseSpeakers.accuracy, mapping: baseSpeakers.mapping });

  const tasks: Array<{ name: string; claim?: string; request: SpeechUnderstandingFeatureRequests }> = [
    { name: "speaker_id role speakers[] (C29 A)", claim: "C29", request: { speaker_identification: { speaker_type: "role", speakers: ROLE_SPEAKERS } } },
    { name: "speaker_id role known_values (C29 B)", claim: "C29", request: { speaker_identification: { speaker_type: "role", known_values: ["Adjuster", "Claimant"] } } },
    { name: "speaker_id name speakers[]", request: { speaker_identification: { speaker_type: "name", speakers: [{ name: "Daniel Reyes", description: "claims adjuster" }, { name: "Priya Shah", description: "claimant" }] } } },
    { name: "translation es (match_original_utterance)", request: { translation: TRANSLATION } },
    { name: "custom_formatting", request: { custom_formatting: FORMATTING } },
    { name: "all three in one request", request: { speaker_identification: { speaker_type: "role", speakers: ROLE_SPEAKERS }, translation: TRANSLATION, custom_formatting: FORMATTING } },
  ];
  const results: Array<Record<string, unknown>> = [];
  let okCount = 0;
  for (const task of tasks) {
    const t0 = performance.now();
    try {
      const t = await client.understanding(base.id, task.request);
      const ms = Math.round(performance.now() - t0);
      const rep = suReport(t);
      const statuses = Object.fromEntries(Object.entries(t.speech_understanding?.response ?? {}).map(([k, v]) => [k, (v as { status?: string })?.status]));
      const ok = Object.values(statuses).length > 0 && Object.values(statuses).every((s) => s === "success");
      if (ok) okCount++;
      results.push({ task: task.name, claim: task.claim, ms, statuses, sameId: t.id === base.id, ...rep });
      saveJson(`async-su-posthoc.${task.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}.json`, t);
    } catch (e) {
      results.push({ task: task.name, claim: task.claim, ms: Math.round(performance.now() - t0), error: e instanceof AssemblyAIHttpError ? { status: e.status, body: e.body } : String(e) });
    }
  }
  for (const r of results) log.note("task", r);
  // Did post-hoc SU persist onto the stored transcript?
  const after = await client.get(base.id);
  const persisted = { hasSpeechUnderstanding: !!after.speech_understanding, utteranceSpeakers: [...new Set((after.utterances ?? []).map((u) => u.speaker))], hasTranslatedTexts: !!after.translated_texts };
  log.note("persisted?", persisted);
  return {
    status: okCount === tasks.length ? "PASS" : okCount > 0 ? "PARTIAL" : "FAIL",
    details: { baseId: base.id, baseTiming, baseSpeakerAccuracy: baseSpeakers.accuracy, request: "POST https://llm-gateway.assemblyai.com/v1/understanding {transcript_id, speech_understanding:{request:{...}}}", results, persistedAfterPosthoc: persisted },
  };
});

// =============================================================================================
// 6. sentences / paragraphs
// =============================================================================================
await withTest("sentences", async (log, client) => {
  const ids = { base: state.transcripts.base, full_redacted: state.transcripts.full };
  const out: Record<string, unknown> = {};
  let ok = true;
  for (const [key, id] of Object.entries(ids)) {
    if (!id) {
      out[key] = "no transcript id (run su-posthoc/full first)";
      ok = false;
      continue;
    }
    const s = await client.sentences(id);
    const p = await client.paragraphs(id);
    saveJson(`async-sentences.${key}.json`, { sentences: s, paragraphs: p });
    out[key] = {
      id,
      sentencesShape: shapeOf(s),
      sentenceShape: shapeOf(s.sentences?.[0]),
      sentenceCount: s.sentences?.length,
      sentenceSample: (s.sentences ?? []).slice(0, 4).map((x) => ({ speaker: x.speaker, start: x.start, end: x.end, text: x.text })),
      sentenceSpeakerAccuracy: speakerAccuracy((s.sentences ?? []).flatMap((x) => x.words ?? []), script).accuracy,
      paragraphsShape: shapeOf(p),
      paragraphShape: shapeOf(p.paragraphs?.[0]),
      paragraphCount: p.paragraphs?.length,
      paragraphSample: (p.paragraphs ?? []).slice(0, 3).map((x) => ({ start: x.start, end: x.end, text: trunc(x.text, 200), speaker: (x as { speaker?: unknown }).speaker ?? "<absent>" })),
    };
    if (!s.sentences?.length || !p.paragraphs?.length) ok = false;
  }
  log.note("sentences/paragraphs", out);
  return { status: ok ? "PASS" : "PARTIAL", details: out };
});

// =============================================================================================
// 7. multichannel - stereo dialog (L = adjuster, R = claimant)
// =============================================================================================
await withTest("multichannel", async (log, client) => {
  const audio_url = await ensureUpload(log, client, "stereo", "dialog_stereo_16k.wav");
  const params: TranscriptParams = { audio_url, speech_models: ["universal-3-5-pro"], language_detection: false, language_code: "en", multichannel: true, keyterms_prompt: KEYTERMS };
  let t: Transcript;
  let timing: unknown = "reused";
  if (reuse && state.transcripts.multichannel) t = await client.get(state.transcripts.multichannel);
  else {
    ({ t, timing } = await transcribeTimed(log, client, params));
    state.transcripts.multichannel = t.id;
    saveState();
  }
  saveJson("async-multichannel.transcript.json", t);
  const chanMap = (label: string): string | undefined => (label === "1" ? "adjuster" : label === "2" ? "claimant" : undefined);
  const perChannel: Record<string, number> = {};
  for (const u of t.utterances ?? []) perChannel[`${u.speaker}|channel=${u.channel ?? "<none>"}`] = (perChannel[`${u.speaker}|channel=${u.channel ?? "<none>"}`] ?? 0) + 1;
  const acc = speakerAccuracy(t.words, script, chanMap);
  const rep = {
    audio_channels: t.audio_channels,
    audio_duration: t.audio_duration,
    speech_model_used: t.speech_model_used,
    topLevelShape: shapeOf(t),
    utteranceShape: shapeOf(t.utterances?.[0]),
    wordShape: shapeOf(t.words?.[0]),
    sampleWord: t.words?.[0],
    perChannel,
    utterances: (t.utterances ?? []).map((u) => ({ speaker: u.speaker, channel: u.channel, start: u.start, end: u.end, text: trunc(u.text, 120) })),
    channelAccuracy: acc,
    alignment: utteranceAlignment(t.utterances, script),
    facts: factsFound(t.text),
    billing: { audio_duration_s: t.audio_duration, channels: t.audio_channels, billable_s: billableSeconds(t, true), formula: "duration x channels x rate (docs)" },
    wordTimingVsMono: existsSync(resolve(OUT_DIR, "async-base.transcript.json"))
      ? compareWordTimings(t.words ?? [], (JSON.parse(readFileSync(resolve(OUT_DIR, "async-base.transcript.json"), "utf8")) as Transcript).words ?? [])
      : "run su-posthoc first (needs the mono base transcript)",
    textSample: trunc(t.text, 500),
    transcriptPreview: trunc(formatUtterances(t, { label: (s) => (s === "1" ? "Adjuster(L)" : s === "2" ? "Claimant(R)" : s) }), 900),
  };
  log.note("report", rep);
  const ok = t.audio_channels === 2 && Object.keys(perChannel).length >= 2 && (acc.accuracy ?? 0) > 0.95;
  return { status: ok ? "PASS" : "PARTIAL", details: { id: t.id, request: { ...params, audio_url: "<upload_url>" }, timing, ...rep, utterances: rep.utterances.slice(0, 6) } };
});

// =============================================================================================
// 7b. su-multichannel - role Speaker ID on a multichannel transcript (400 text says "speaker_labels or multichannel required")
// =============================================================================================
await withTest("su-multichannel", async (log, client) => {
  const id = state.transcripts.multichannel;
  if (!id) return { status: "SKIPPED", details: { reason: "run multichannel first" } };
  const request: SpeechUnderstandingFeatureRequests = { speaker_identification: { speaker_type: "role", known_values: ["Adjuster", "Claimant"] } };
  const t0 = performance.now();
  const r = await client.understanding(id, request);
  const ms = Math.round(performance.now() - t0);
  saveJson("async-su-multichannel.json", r);
  const rep = suReport(r);
  const channels = [...new Set((r.utterances ?? []).map((u) => `${u.speaker}|channel=${u.channel ?? "<none>"}`))];
  log.note("report", { ms, channels, ...rep });
  const ok = r.speech_understanding?.response?.speaker_identification?.status === "success" && (rep.speakerAccuracyByRole.accuracy ?? 0) > 0.95;
  return { status: ok ? "PASS" : "PARTIAL", details: { id, request, ms, mapping: r.speech_understanding?.response?.speaker_identification?.mapping ?? null, speakerChannelPairs: channels, accuracyByRole: rep.speakerAccuracyByRole.accuracy, topLevelShape: rep.topLevelShape } };
});

// =============================================================================================
// 8. fallback - speech_models ["universal-3-5-pro","universal-2"] + language detection on Hinglish
// =============================================================================================
await withTest("fallback", async (log, client) => {
  const audio_url = await ensureUpload(log, client, "codeswitch", "codeswitch_16k.wav");
  const params: TranscriptParams = { audio_url, speech_models: ["universal-3-5-pro", "universal-2"], language_detection: true };
  let t: Transcript;
  let timing: unknown = "reused";
  if (reuse && state.transcripts.fallback) t = await client.get(state.transcripts.fallback);
  else {
    ({ t, timing } = await transcribeTimed(log, client, params));
    state.transcripts.fallback = t.id;
    saveState();
  }
  saveJson("async-fallback.transcript.json", t);
  const digits = (t.text ?? "").replace(/[^0-9]/g, "");
  const rep = {
    speech_models: t.speech_models,
    speech_model_used: t.speech_model_used,
    language_code: t.language_code,
    language_confidence: t.language_confidence,
    language_detection_results: t.language_detection_results ?? null,
    text: t.text,
    digitsInText: digits,
    orderNumberCorrect: digits.includes("481529"),
    truth: "Mera order abhi tak nahi aaya, can you please check the status? Order number hai 4 8 1 5 2 9. Aur haan, delivery kal tak ho jayegi kya?",
    metadata: t.metadata ?? null,
  };
  log.note("report", rep);
  return { status: t.speech_model_used ? "PASS" : "PARTIAL", details: { id: t.id, request: { ...params, audio_url: "<upload_url>" }, timing, ...rep } };
});

console.log(`summary -> ${SUMMARY_PATH}`);
