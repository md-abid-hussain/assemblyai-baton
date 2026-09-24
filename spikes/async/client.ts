/**
 * async/client.ts - AssemblyAI pre-recorded (async) transcription + Speech Understanding client.
 *
 * Dependency-free (global fetch). Runs in Node 18+ and Vercel Node/edge functions. Server-side only:
 * never ship the key to a browser.
 *
 * Covers: POST /v2/upload, POST /v2/transcript, GET /v2/transcript/{id} (poll), /sentences,
 * /paragraphs, /redacted-audio, /word-search, /srt|/vtt, DELETE, plus the Speech Understanding
 * endpoint POST https://llm-gateway.assemblyai.com/v1/understanding, and webhook helpers.
 *
 * Shapes are typed from live responses captured 2026-09-24 (research/10c-async-gateway-smoke.md).
 * Auth: `Authorization: <key>` (raw key, no "Bearer").
 */

export const AAI_API_US = "https://api.assemblyai.com";
export const AAI_API_EU = "https://api.eu.assemblyai.com";
export const AAI_GATEWAY_US = "https://llm-gateway.assemblyai.com";
export const AAI_GATEWAY_EU = "https://llm-gateway.eu.assemblyai.com";

// ---------------------------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------------------------

export type SpeechModel = "universal-3-5-pro" | "universal-2";
export type TranscriptStatus = "queued" | "processing" | "completed" | "error";

/** The 51 PII policies documented on /docs/guardrails/redact-pii-from-transcripts (2026-09-24). */
export const PII_POLICIES = [
  "account_number", "banking_information", "blood_type", "credit_card_cvv", "credit_card_expiration",
  "credit_card_number", "date", "date_interval", "date_of_birth", "drivers_license", "drug", "duration",
  "email_address", "event", "filename", "gender_sexuality", "healthcare_number", "injury", "ip_address",
  "language", "location", "location_address", "location_address_street", "location_city",
  "location_coordinate", "location_country", "location_state", "location_zip", "marital_status",
  "medical_condition", "medical_process", "money_amount", "nationality", "number_sequence", "occupation",
  "organization", "passport_number", "password", "person_age", "person_name", "phone_number",
  "physical_attribute", "political_affiliation", "religion", "statistics", "time", "url",
  "us_social_security_number", "username", "vehicle_id", "zodiac_sign",
] as const;
export type PiiPolicy = (typeof PII_POLICIES)[number];

export type SpeechUnderstandingEffort = "low" | "medium";

export interface SpeakerIdentificationRequest {
  speaker_type: "role" | "name";
  /** Array-of-objects form from the Speaker Identification docs page (C29 "speakers"). */
  speakers?: Array<{ name?: string; role?: string; description?: string; [k: string]: unknown }>;
  /** Flat string form from the diarization page + JS SDK types (C29 "known_values"). */
  known_values?: string[];
  effort?: SpeechUnderstandingEffort;
}

export interface TranslationRequest {
  target_languages: string[];
  formal?: boolean;
  /** Adds per-utterance `translated_texts` (needs speaker_labels). */
  match_original_utterance?: boolean;
  force_translation?: boolean;
  effort?: SpeechUnderstandingEffort;
}

export interface CustomFormattingRequest {
  /** e.g. "mm/dd/yyyy" or "yyyy-mm-dd,mm-dd" */
  date?: string;
  /** e.g. "(xxx)xxx-xxxx" */
  phone_number?: string;
  /** e.g. "username@domain.com" */
  email?: string;
  format_utterances?: boolean;
  effort?: SpeechUnderstandingEffort;
}

export interface SummarizationRequest {
  summary_type: "bullets" | "paragraph";
  effort?: SpeechUnderstandingEffort;
}

export interface SpeechUnderstandingFeatureRequests {
  speaker_identification?: SpeakerIdentificationRequest;
  translation?: TranslationRequest;
  custom_formatting?: CustomFormattingRequest;
  summarization?: SummarizationRequest;
}

export interface TranscriptParams {
  audio_url: string;
  speech_models?: SpeechModel[];
  /** Set `language_detection:false` + `language_code` to pin the language. */
  language_code?: string;
  language_detection?: boolean;
  language_detection_options?: {
    expected_languages?: string[];
    fallback_language?: string;
    code_switching?: boolean;
    code_switching_confidence_threshold?: number;
    on_no_speech_detected?: "fallback";
    localization?: string[];
  };
  language_confidence_threshold?: number;
  prompt?: string;
  keyterms_prompt?: string[];
  temperature?: number;
  punctuate?: boolean;
  format_text?: boolean;
  disfluencies?: boolean;
  speaker_labels?: boolean;
  speakers_expected?: number;
  speaker_options?: { min_speakers_expected?: number; max_speakers_expected?: number; include_speaker_confidence?: boolean };
  multichannel?: boolean;
  entity_detection?: boolean;
  sentiment_analysis?: boolean;
  auto_highlights?: boolean;
  iab_categories?: boolean;
  content_safety?: boolean;
  filter_profanity?: boolean;
  custom_spelling?: Array<{ from: string[]; to: string }>;
  redact_pii?: boolean;
  redact_pii_policies?: PiiPolicy[];
  redact_pii_sub?: "entity_name" | "hash";
  redact_pii_return_unredacted?: boolean;
  redact_pii_audio?: boolean;
  redact_pii_audio_quality?: "mp3" | "wav";
  redact_pii_audio_options?: { override_audio_redaction_method?: "silence"; return_redacted_no_speech_audio?: boolean };
  redact_static_entities?: Record<string, string[]>;
  audio_start_from?: number;
  audio_end_at?: number;
  speech_threshold?: number;
  webhook_url?: string;
  webhook_auth_header_name?: string;
  webhook_auth_header_value?: string;
  speech_understanding?: { request: SpeechUnderstandingFeatureRequests };
}

// ---------------------------------------------------------------------------------------------
// Response types (observed)
// ---------------------------------------------------------------------------------------------

export interface Word {
  text: string;
  start: number;
  end: number;
  confidence: number;
  /** Diarization label ("A"), channel number as string with multichannel ("1"), or identified role/name after Speaker ID. */
  speaker: string | null;
  channel?: string | null;
}

export interface Utterance {
  speaker: string;
  text: string;
  start: number;
  end: number;
  confidence: number;
  words: Word[];
  channel?: string | null;
  /** Present when translation ran with match_original_utterance:true. */
  translated_texts?: Record<string, string>;
}

export interface Entity {
  entity_type: string;
  text: string;
  start: number;
  end: number;
}

export interface SentimentResult {
  text: string;
  start: number;
  end: number;
  sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE";
  confidence: number;
  speaker: string | null;
  channel?: string | null;
}

export interface SpeechUnderstandingResponse {
  request?: { request?: SpeechUnderstandingFeatureRequests } & Record<string, unknown>;
  response?: {
    speaker_identification?: { status: string; mapping?: Record<string, string>; [k: string]: unknown };
    translation?: { status: string; [k: string]: unknown };
    custom_formatting?: { status: string; mapping?: Record<string, string>; formatted_text?: string; formatted_utterances?: Utterance[]; [k: string]: unknown };
    summarization?: { status: string; [k: string]: unknown };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface Transcript {
  id: string;
  status: TranscriptStatus;
  error?: string | null;
  audio_url: string;
  audio_duration?: number | null;
  audio_channels?: number | null;
  text?: string | null;
  words?: Word[] | null;
  utterances?: Utterance[] | null;
  confidence?: number | null;
  language_code?: string | null;
  language_confidence?: number | null;
  language_detection_results?: { code_switching_languages?: Array<{ language: string; confidence: number }> } & Record<string, unknown>;
  speech_models?: string[] | null;
  speech_model_used?: string | null;
  entities?: Entity[] | null;
  sentiment_analysis_results?: SentimentResult[] | null;
  unredacted_text?: string | null;
  unredacted_words?: Word[] | null;
  unredacted_utterances?: Utterance[] | null;
  translated_texts?: Record<string, string> | null;
  speech_understanding?: SpeechUnderstandingResponse | null;
  webhook_status_code?: number | null;
  metadata?: Record<string, unknown> | null;
  [k: string]: unknown;
}

/** Response of POST /v1/understanding (post-hoc). Keys vary by task; see research/10c. */
export interface UnderstandingResult {
  request_id?: string;
  speech_understanding: SpeechUnderstandingResponse;
  /** Speaker ID / translation(match_original_utterance) / formatting(format_utterances): relabelled utterances. */
  utterances?: Utterance[];
  translated_texts?: Record<string, string>;
  text?: string;
  words?: Word[];
  [k: string]: unknown;
}

export interface Sentence {
  text: string;
  start: number;
  end: number;
  confidence: number;
  words: Word[];
  speaker: string | null;
  channel?: string | null;
}
export interface SentencesResponse {
  sentences: Sentence[];
  id?: string;
  confidence?: number;
  audio_duration?: number;
}
export interface Paragraph {
  text: string;
  start: number;
  end: number;
  confidence: number;
  words: Word[];
}
export interface ParagraphsResponse {
  paragraphs: Paragraph[];
  id?: string;
  confidence?: number;
  audio_duration?: number;
}
export interface RedactedAudioResponse {
  status: "redacted_audio_ready" | string;
  redacted_audio_url?: string;
}
export interface WordSearchResponse {
  id: string;
  total_count: number;
  matches: Array<{ text: string; count: number; timestamps: Array<[number, number]>; indexes: number[] }>;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export class AssemblyAIHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly method: string;
  readonly url: string;
  constructor(method: string, url: string, status: number, body: unknown) {
    const msg = typeof body === "object" && body && "error" in body ? String((body as { error: unknown }).error) : typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300);
    super(`${method} ${url} -> ${status}: ${msg}`);
    this.name = "AssemblyAIHttpError";
    this.status = status;
    this.body = body;
    this.method = method;
    this.url = url;
  }
}

export class TranscriptFailedError extends Error {
  readonly transcript: Transcript;
  constructor(t: Transcript) {
    super(`transcript ${t.id} failed: ${t.error ?? "unknown error"}`);
    this.name = "TranscriptFailedError";
    this.transcript = t;
  }
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

export interface AsyncClientOptions {
  apiKey: string;
  region?: "us" | "eu";
  /** Override (e.g. a logging wrapper). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Per-request timeout (ms). Default 60 s; uploads get 5 min. */
  timeoutMs?: number;
  /** Retries for idempotent GETs on 5xx/network errors. Default 3. */
  getRetries?: number;
  /** Retries on HTTP 429 (any method), waiting `retry-after` (<= 65 s). Default 2. */
  rateLimitRetries?: number;
  /** Observe rate-limit waits (e.g. to log them). */
  onRateLimit?: (info: { url: string; waitMs: number; attempt: number; headers: Record<string, string> }) => void;
}

export interface WaitOptions {
  /** First poll delay (ms). Default 1000. */
  initialIntervalMs?: number;
  /** Max poll delay (ms). Default 5000. */
  maxIntervalMs?: number;
  /** Give up after (ms). Default 15 min. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onPoll?: (info: { status: TranscriptStatus; polls: number; elapsedMs: number }) => void;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

export class AssemblyAIAsyncClient {
  readonly apiBase: string;
  readonly gatewayBase: string;
  private readonly apiKey: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  private readonly getRetries: number;
  private readonly rateLimitRetries: number;
  private readonly onRateLimit: AsyncClientOptions["onRateLimit"];

  constructor(opts: AsyncClientOptions) {
    if (!opts.apiKey) throw new Error("AssemblyAIAsyncClient: apiKey is required");
    this.apiKey = opts.apiKey;
    this.apiBase = opts.region === "eu" ? AAI_API_EU : AAI_API_US;
    this.gatewayBase = opts.region === "eu" ? AAI_GATEWAY_EU : AAI_GATEWAY_US;
    this.f = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.getRetries = opts.getRetries ?? 3;
    this.rateLimitRetries = opts.rateLimitRetries ?? 2;
    this.onRateLimit = opts.onRateLimit;
  }

  /**
   * Low-level JSON request. Throws AssemblyAIHttpError on non-2xx.
   * Retries: 429 on any method (the request was rejected, so it is safe) honoring `retry-after`
   * (Speech Understanding is limited to 2 req / 60 s!); 5xx + network errors on GET only.
   */
  async request<T>(method: string, url: string, body?: unknown, opts: { timeoutMs?: number; signal?: AbortSignal; raw?: boolean; rateLimitRetries?: number; maxRetryAfterMs?: number } = {}): Promise<T> {
    const isGet = method === "GET";
    const maxRateLimitRetries = opts.rateLimitRetries ?? this.rateLimitRetries;
    const maxRetryAfterMs = opts.maxRetryAfterMs ?? 65_000;
    let rateLimited = 0;
    let transient = 0;
    for (;;) {
      let res: Response;
      try {
        res = await this.f(url, {
          method,
          headers: { authorization: this.apiKey, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
        });
      } catch (err) {
        if (!isGet || transient >= this.getRetries) throw err;
        await sleep(500 * 2 ** transient++, opts.signal);
        continue;
      }
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON (srt/vtt) */
      }
      if (res.ok) return (opts.raw ? text : parsed) as T;
      const err = new AssemblyAIHttpError(method, url, res.status, parsed);
      if (res.status === 429 && rateLimited < maxRateLimitRetries) {
        const ra = Number(res.headers.get("retry-after") ?? res.headers.get("x-ratelimit-reset")) * 1000;
        const wait = Number.isFinite(ra) && ra > 0 ? ra + 250 : 1000 * 2 ** rateLimited;
        if (wait > maxRetryAfterMs) throw err;
        rateLimited++;
        this.onRateLimit?.({ url, waitMs: wait, attempt: rateLimited, headers: Object.fromEntries(res.headers.entries()) });
        await sleep(wait, opts.signal);
        continue;
      }
      if (isGet && res.status >= 500 && transient < this.getRetries) {
        await sleep(500 * 2 ** transient++, opts.signal);
        continue;
      }
      throw err;
    }
  }

  /** POST /v2/upload with raw bytes. Returns the private `upload_url` (usable only by this project's key). */
  async upload(data: Uint8Array | ArrayBuffer | Blob, opts: { signal?: AbortSignal } = {}): Promise<string> {
    const url = `${this.apiBase}/v2/upload`;
    const res = await this.f(url, {
      method: "POST",
      headers: { authorization: this.apiKey, "content-type": "application/octet-stream" },
      body: data as NonNullable<RequestInit["body"]>,
      signal: opts.signal ?? AbortSignal.timeout(300_000),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep */
    }
    if (!res.ok) throw new AssemblyAIHttpError("POST", url, res.status, parsed);
    const uploadUrl = (parsed as { upload_url?: string }).upload_url;
    if (!uploadUrl) throw new AssemblyAIHttpError("POST", url, res.status, parsed);
    return uploadUrl;
  }

  /** POST /v2/transcript. Returns the queued transcript (status "queued"). */
  submit(params: TranscriptParams, opts: { signal?: AbortSignal } = {}): Promise<Transcript> {
    return this.request<Transcript>("POST", `${this.apiBase}/v2/transcript`, params, opts);
  }

  get(id: string, opts: { signal?: AbortSignal } = {}): Promise<Transcript> {
    return this.request<Transcript>("GET", `${this.apiBase}/v2/transcript/${encodeURIComponent(id)}`, undefined, opts);
  }

  /** Poll until completed (returns) or error (throws TranscriptFailedError). Backoff 1 s -> 5 s. */
  async waitForCompletion(id: string, opts: WaitOptions = {}): Promise<Transcript> {
    const t0 = Date.now();
    let interval = opts.initialIntervalMs ?? 1000;
    const maxInterval = opts.maxIntervalMs ?? 5000;
    const timeout = opts.timeoutMs ?? 15 * 60_000;
    for (let polls = 1; ; polls++) {
      const t = await this.get(id, { signal: opts.signal });
      opts.onPoll?.({ status: t.status, polls, elapsedMs: Date.now() - t0 });
      if (t.status === "completed") return t;
      if (t.status === "error") throw new TranscriptFailedError(t);
      if (Date.now() - t0 > timeout) throw new Error(`transcript ${id} not done after ${timeout} ms (status ${t.status})`);
      await sleep(interval, opts.signal);
      interval = Math.min(maxInterval, Math.round(interval * 1.5));
    }
  }

  /** submit + waitForCompletion. For production prefer webhooks (see webhookParams / parseWebhook). */
  async transcribe(params: TranscriptParams, opts: WaitOptions = {}): Promise<Transcript> {
    const queued = await this.submit(params, { signal: opts.signal });
    return this.waitForCompletion(queued.id, opts);
  }

  sentences(id: string): Promise<SentencesResponse> {
    return this.request<SentencesResponse>("GET", `${this.apiBase}/v2/transcript/${encodeURIComponent(id)}/sentences`);
  }

  paragraphs(id: string): Promise<ParagraphsResponse> {
    return this.request<ParagraphsResponse>("GET", `${this.apiBase}/v2/transcript/${encodeURIComponent(id)}/paragraphs`);
  }

  redactedAudio(id: string): Promise<RedactedAudioResponse> {
    return this.request<RedactedAudioResponse>("GET", `${this.apiBase}/v2/transcript/${encodeURIComponent(id)}/redacted-audio`);
  }

  /** Poll /redacted-audio until ready. The URL expires ~24 h after creation: copy it somewhere durable. */
  async waitForRedactedAudio(id: string, opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {}): Promise<RedactedAudioResponse> {
    const t0 = Date.now();
    for (;;) {
      try {
        const r = await this.redactedAudio(id);
        if (r.status === "redacted_audio_ready" && r.redacted_audio_url) return r;
      } catch (err) {
        // 400 "redacted audio not ready yet" style responses are retried until timeout
        if (!(err instanceof AssemblyAIHttpError) || err.status >= 500 || Date.now() - t0 > (opts.timeoutMs ?? 120_000)) throw err;
      }
      if (Date.now() - t0 > (opts.timeoutMs ?? 120_000)) throw new Error(`redacted audio for ${id} not ready`);
      await sleep(opts.intervalMs ?? 2000, opts.signal);
    }
  }

  wordSearch(id: string, words: string[]): Promise<WordSearchResponse> {
    const q = words.map((w) => encodeURIComponent(w)).join(",");
    return this.request<WordSearchResponse>("GET", `${this.apiBase}/v2/transcript/${encodeURIComponent(id)}/word-search?words=${q}`);
  }

  subtitles(id: string, format: "srt" | "vtt", charsPerCaption?: number): Promise<string> {
    const qs = charsPerCaption ? `?chars_per_caption=${charsPerCaption}` : "";
    return this.request<string>("GET", `${this.apiBase}/v2/transcript/${encodeURIComponent(id)}/${format}${qs}`, undefined, { raw: true });
  }

  /** DELETE /v2/transcript/{id} - permanently scrubs the transcript. */
  delete(id: string): Promise<Transcript> {
    return this.request<Transcript>("DELETE", `${this.apiBase}/v2/transcript/${encodeURIComponent(id)}`);
  }

  /**
   * Speech Understanding on a finished transcript: POST {gateway}/v1/understanding.
   * NOT a full transcript: returns {request_id, speech_understanding, utterances?, translated_texts?, ...}
   * and does not persist onto the stored transcript. Rate limit observed: 2 requests / 60 s per key.
   */
  understanding(transcriptId: string, request: SpeechUnderstandingFeatureRequests, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<UnderstandingResult> {
    return this.request<UnderstandingResult>(
      "POST",
      `${this.gatewayBase}/v1/understanding`,
      { transcript_id: transcriptId, speech_understanding: { request } },
      { timeoutMs: opts.timeoutMs ?? 180_000, signal: opts.signal },
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------

/** Completion webhook body: only id + status. Fetch the transcript to get results / the error text. */
export interface TranscriptWebhookPayload {
  transcript_id: string;
  status: "completed" | "error";
}
/** Separate callback fired when PII-redacted audio is ready (per docs). */
export interface RedactedAudioWebhookPayload {
  status: "redacted_audio_ready";
  redacted_audio_url: string;
}

/**
 * Params to add to a submit so AssemblyAI POSTs to your endpoint when done. The header you choose is
 * echoed on every delivery; verify it with `verifyWebhookHeader`. Put your own correlation ids in the
 * URL query string. Endpoint must answer 2xx within 10 s (4xx = permanent failure, no retry).
 */
export function webhookParams(url: string, auth?: { headerName: string; headerValue: string }): Pick<TranscriptParams, "webhook_url" | "webhook_auth_header_name" | "webhook_auth_header_value"> {
  return auth ? { webhook_url: url, webhook_auth_header_name: auth.headerName, webhook_auth_header_value: auth.headerValue } : { webhook_url: url };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Check the shared-secret header on an incoming webhook (Headers or a Node-style header record). */
export function verifyWebhookHeader(headers: Headers | Record<string, string | string[] | undefined>, headerName: string, expected: string): boolean {
  const raw = headers instanceof Headers ? headers.get(headerName) : (headers[headerName.toLowerCase()] ?? headers[headerName]);
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && constantTimeEqual(v, expected);
}

/** Parse + validate a webhook body (pass the raw request text). */
export function parseWebhook(rawBody: string): TranscriptWebhookPayload | RedactedAudioWebhookPayload {
  const j = JSON.parse(rawBody) as Record<string, unknown>;
  if (j.status === "redacted_audio_ready" && typeof j.redacted_audio_url === "string") {
    return { status: "redacted_audio_ready", redacted_audio_url: j.redacted_audio_url };
  }
  if (typeof j.transcript_id === "string" && (j.status === "completed" || j.status === "error")) {
    return { transcript_id: j.transcript_id, status: j.status };
  }
  throw new Error(`unrecognized AssemblyAI webhook body: ${rawBody.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------------------------
// Small helpers for consumers
// ---------------------------------------------------------------------------------------------

/** Utterances as "[mm:ss] Speaker: text" lines (the Gateway's {{ transcript }} injects plain text only). */
export function formatUtterances(t: Pick<Transcript, "utterances">, opts: { label?: (speaker: string) => string } = {}): string {
  const fmt = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  return (t.utterances ?? []).map((u) => `[${fmt(u.start)}] ${opts.label ? opts.label(u.speaker) : u.speaker}: ${u.text}`).join("\n");
}

const SPEAKER_TAG_RE = /\[Speaker:[^\]]*\]\s*/g;

/** Remove inline U3.5 Pro speaker tags ("[Speaker:1] ", "[Speaker:Priya Shah] ") that leak into sentiment rows. */
export function stripSpeakerTags(text: string): string {
  return text.replace(SPEAKER_TAG_RE, "").trim();
}

/**
 * Sentiment rows' `speaker` is unreliable (38.5% correct in our test) and their text carries inline
 * tags + UNREDACTED PII. Re-attribute each row to the utterance with the largest time overlap and strip tags.
 */
export function reattributeSentiment(rows: SentimentResult[], utterances: Utterance[]): Array<SentimentResult & { speaker_raw: string | null }> {
  return rows.map((r) => {
    let best: Utterance | undefined;
    let bestOv = 0;
    for (const u of utterances) {
      const ov = Math.min(u.end, r.end) - Math.max(u.start, r.start);
      if (ov > bestOv) {
        bestOv = ov;
        best = u;
      }
    }
    return { ...r, speaker_raw: r.speaker, speaker: best?.speaker ?? r.speaker, text: stripSpeakerTags(r.text) };
  });
}

/**
 * Speaker Identification relabels `utterances`/`words` but NOT `unredacted_utterances`/`unredacted_words`.
 * Apply `speech_understanding.response.speaker_identification.mapping` ({"A":"Adjuster"}) yourself.
 */
export function applySpeakerMapping<T extends { speaker: string | null; words?: Word[] }>(items: T[] | null | undefined, mapping: Record<string, string> | null | undefined): T[] {
  if (!items) return [];
  if (!mapping) return items;
  const m = (s: string | null): string | null => (s != null && mapping[s] ? mapping[s] : s);
  return items.map((it) => ({ ...it, speaker: m(it.speaker), ...(it.words ? { words: it.words.map((w) => ({ ...w, speaker: m(w.speaker) })) } : {}) }));
}

/** Billable audio seconds for an async job (duration x channels when multichannel). */
export function billableSeconds(t: Pick<Transcript, "audio_duration" | "audio_channels">, multichannel: boolean): number {
  return (t.audio_duration ?? 0) * (multichannel ? (t.audio_channels ?? 1) : 1);
}
