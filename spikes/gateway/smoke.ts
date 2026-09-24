/**
 * gateway/smoke.ts - AssemblyAI LLM Gateway smoke tests (T7, C9, C10, C26, C27).
 *
 *   npx tsx gateway/smoke.ts                        # all
 *   npx tsx gateway/smoke.ts --only=chat,stream
 *
 * Reality on this account (see gateway/access.ts): only `qwen3.5-4b-32k-fast` is callable, at
 * 2 requests/min; all 44 other models return 400 "Your account does not have access to this LLM
 * Gateway model". So every test makes ONE call per paid model to record the exact access error
 * (denials are free and do not consume the rate limit) and runs the capability check itself on
 * qwen fast, pacing on 429 + retry-after (other agents share the key's budget).
 *
 * Tests -> out/gateway-<test>.jsonl, summary -> out/gateway-summary.json:
 *   auth, chat, structured, tools, stream, transcript, region, fallback
 * `transcript` needs transcript ids from out/async-state.json (run async/smoke.ts first).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type OpenAI from "openai";
import { ASSEMBLYAI_API_KEY, OUT_DIR } from "../lib/env.ts";
import { createLogger, type JsonlLogger } from "../lib/log.ts";
import { loggingFetch } from "../async/http-log.ts";
import {
  GATEWAY_BASE_EU,
  GATEWAY_BASE_US,
  TRANSCRIPT_TAG,
  completionText,
  createGatewayClient,
  gatewayChat,
  gatewayStream,
  jsonSchemaFormat,
  normalizeFinishReason,
  type GatewayCallResult,
  type GatewayChatParams,
} from "./client.ts";

type Status = "PASS" | "FAIL" | "PARTIAL" | "SKIPPED";

const argv = process.argv.slice(2);
const only = argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const want = (n: string): boolean => !only || only.includes(n);

const OPENAI_CHEAP = "gpt-5-nano"; // cheapest OpenAI with tools+response_format+stream in /v1/models
const CLAUDE = "claude-sonnet-4-6";
const FAST = "qwen3.5-4b-32k-fast"; // AssemblyAI self-hosted; params: max_tokens, temperature, stream

const SUMMARY_PATH = resolve(OUT_DIR, "gateway-summary.json");
const summary: Record<string, unknown> = existsSync(SUMMARY_PATH) ? (JSON.parse(readFileSync(SUMMARY_PATH, "utf8")) as Record<string, unknown>) : {};
const asyncState = existsSync(resolve(OUT_DIR, "async-state.json"))
  ? (JSON.parse(readFileSync(resolve(OUT_DIR, "async-state.json"), "utf8")) as { transcripts: Record<string, string> })
  : { transcripts: {} as Record<string, string> };

/** Latency samples of successful qwen calls across all tests. */
const qwenLatency: number[] = [];

function trunc(s: unknown, n = 300): unknown {
  if (typeof s !== "string") return s;
  return s.length > n ? `${s.slice(0, n)}...[+${s.length - n}]` : s;
}

function sdkErr(e: unknown): Record<string, unknown> {
  const x = e as { status?: number; error?: unknown; message?: string; headers?: unknown; name?: string };
  let headers: Record<string, string> | undefined;
  if (x?.headers instanceof Headers) headers = Object.fromEntries([...x.headers.entries()].filter(([k]) => /ratelimit|retry/i.test(k)));
  return { name: x?.name, status: x?.status ?? null, body: x?.error ?? null, message: trunc(x?.message, 300), ...(headers && Object.keys(headers).length ? { headers } : {}) };
}

function rec(r: GatewayCallResult): Record<string, unknown> {
  const c = r.completion;
  const choice = c.choices?.[0];
  return {
    ms: r.ms,
    model: (c as { model?: string }).model ?? null,
    finish_reason: choice?.finish_reason ?? null,
    normalized_finish: normalizeFinishReason(choice?.finish_reason),
    content: trunc(completionText(c), 400),
    tool_calls: choice?.message?.tool_calls ?? null,
    usage: c.usage ?? null,
    response_time_ns: c.response_time ?? null,
    http_status_code: c.http_status_code ?? null,
    llm_status_code: c.llm_status_code ?? null,
    request_id: c.request_id ?? null,
    request_echo: c.request ?? null,
    top_level_keys: Object.keys(c),
    message_keys: choice?.message ? Object.keys(choice.message) : null,
    rate_headers: r.headers,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** SDK call with 429 pacing (reads retry-after from the APIError headers). */
async function sdkPaced<T>(log: JsonlLogger, label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const x = e as { status?: number; headers?: Headers };
      if (x?.status !== 429 || attempt >= 5) throw e;
      const ra = Number(x.headers?.get?.("retry-after") ?? 30);
      const wait = (Number.isFinite(ra) && ra > 0 ? ra : 30) * 1000 + 750;
      log.note("rate-limited; waiting retry-after", { label, waitMs: wait, attempt: attempt + 1, remaining: x.headers?.get?.("x-ratelimit-remaining"), limit: x.headers?.get?.("x-ratelimit-limit") });
      await sleep(wait);
    }
  }
}

async function withTest(name: string, fn: (log: JsonlLogger, client: OpenAI, raw: RawChat) => Promise<{ status: Status; details: Record<string, unknown> }>): Promise<void> {
  if (!want(name)) return;
  const log = createLogger(`gateway-${name}`);
  const lf = loggingFetch(log);
  const client = createGatewayClient({ apiKey: ASSEMBLYAI_API_KEY, fetch: lf, maxRetries: 0 });
  const raw = makeRawChat(log, lf);
  const t0 = performance.now();
  let status: Status = "FAIL";
  let details: Record<string, unknown> = {};
  try {
    ({ status, details } = await fn(log, client, raw));
  } catch (err) {
    log.error(err);
    details = { error: sdkErr(err) };
  }
  const wallMs = Math.round(performance.now() - t0);
  log.result(status, { wallMs, ...details });
  log.close();
  summary[name] = { status, wallMs, ...details };
  writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  console.log(`[gateway-${name}] ${status} (${wallMs} ms)`);
}

interface RawResult {
  status: number;
  ms: number;
  json: unknown;
  rate: Record<string, string>;
  rateLimitedWaits: number;
}
type RawChat = (body: Record<string, unknown>, opts?: { auth?: "raw" | "bearer" | "none" | "bad"; base?: string; pace?: boolean }) => Promise<RawResult>;

/** Raw fetch POST /chat/completions with an auth style; paces on 429 unless pace:false. */
function makeRawChat(log: JsonlLogger, lf: typeof fetch): RawChat {
  return async (body, opts = {}) => {
    const auth = opts.auth ?? "raw";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth === "raw") headers.authorization = ASSEMBLYAI_API_KEY;
    if (auth === "bearer") headers.authorization = `Bearer ${ASSEMBLYAI_API_KEY}`;
    if (auth === "bad") headers.authorization = "invalid-key-0000000000000000";
    let waits = 0;
    for (;;) {
      const t0 = performance.now();
      const res = await lf(`${opts.base ?? GATEWAY_BASE_US}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
      const text = await res.text();
      const ms = Math.round(performance.now() - t0);
      let json: unknown = text;
      try {
        json = JSON.parse(text);
      } catch {
        /* text */
      }
      const rate = Object.fromEntries([...res.headers.entries()].filter(([k]) => /ratelimit|retry-after/i.test(k)));
      if (res.status === 429 && opts.pace !== false && waits < 5) {
        const ra = Number(res.headers.get("retry-after") ?? 30);
        const wait = (Number.isFinite(ra) && ra > 0 ? ra : 30) * 1000 + 750;
        log.note("rate-limited; waiting retry-after", { model: body.model, waitMs: wait, remaining: rate["x-ratelimit-remaining"] });
        waits++;
        await sleep(wait);
        continue;
      }
      if (res.status === 200 && body.model === FAST && !body.stream) qwenLatency.push(ms);
      return { status: res.status, ms, json, rate, rateLimitedWaits: waits };
    }
  };
}

const content = (j: unknown): string => String((j as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? "");
const PING = [{ role: "user" as const, content: "In one short sentence: what is the capital of France?" }];

/** One call to a paid model, recording the exact access error (no pacing needed: denials carry no rate headers). */
async function paidProbe(raw: RawChat, model: string, extra: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await raw({ model, messages: PING, max_tokens: model.startsWith("gpt-5") ? 1500 : 100, ...extra });
  return { model, status: r.status, ms: r.ms, body: r.status === 200 ? { content: trunc(content(r.json), 120) } : r.json };
}

// =============================================================================================
// auth
// =============================================================================================
await withTest("auth", async (log, _c, raw) => {
  const body = { model: FAST, messages: PING, max_tokens: 30 };
  const out: Record<string, unknown> = {};
  for (const a of ["raw", "bearer", "none", "bad"] as const) {
    const r = await raw(body, { auth: a });
    out[a] = { status: r.status, ms: r.ms, waitsFor429: r.rateLimitedWaits, body: r.status === 200 ? { content: trunc(content(r.json), 120), keys: Object.keys(r.json as object) } : r.json, rate: r.rate };
  }
  log.note("auth matrix", out);
  const ok = (out.raw as { status: number }).status === 200 && (out.bearer as { status: number }).status === 200;
  return { status: ok ? "PASS" : "FAIL", details: { request: { url: `${GATEWAY_BASE_US}/chat/completions`, body }, results: out } };
});

// =============================================================================================
// chat - (a) cheap OpenAI, (b) claude-sonnet-4-6, (c) fast small model  [T7 / C10]
// =============================================================================================
await withTest("chat", async (log, client, raw) => {
  const runs: Array<Record<string, unknown>> = [];
  runs.push({ label: "(a) openai cheap", ...(await paidProbe(raw, OPENAI_CHEAP, {})) });
  runs.push({ label: "(b) claude-sonnet-4-6", ...(await paidProbe(raw, CLAUDE, {})) });
  for (const v of [
    { label: "(c) qwen fast via OpenAI SDK (Bearer)", params: { model: FAST, messages: PING, max_tokens: 60 } as GatewayChatParams },
    { label: "(c) qwen fast system+user via SDK", params: { model: FAST, messages: [{ role: "system", content: "Answer in exactly three words." }, ...PING], max_tokens: 60 } as GatewayChatParams },
  ]) {
    try {
      const r = await sdkPaced(log, v.label, () => gatewayChat(client, v.params));
      qwenLatency.push(r.ms);
      runs.push({ label: v.label, ok: true, ...rec(r) });
    } catch (e) {
      runs.push({ label: v.label, ok: false, error: sdkErr(e) });
    }
  }
  const p = await raw({ model: FAST, prompt: "Say hello in Spanish, one word.", max_tokens: 20 });
  runs.push({ label: "(c) qwen fast using `prompt` instead of messages (raw)", status: p.status, ms: p.ms, content: trunc(content(p.json), 100), error: p.status !== 200 ? p.json : undefined });
  const r3 = await raw({ model: FAST, messages: PING, max_tokens: 3 });
  runs.push({ label: "(c) qwen fast max_tokens=3 (finish_reason=length?)", status: r3.status, ms: r3.ms, finish_reason: (r3.json as { choices?: Array<{ finish_reason?: string }> })?.choices?.[0]?.finish_reason, content: content(r3.json), usage: (r3.json as { usage?: unknown })?.usage });
  for (const r of runs) log.note("run", r);
  const qOk = runs.filter((r) => String(r.label).startsWith("(c)")).every((r) => r.ok === true || r.status === 200);
  const paidOk = runs.filter((r) => String(r.label).match(/^\((a|b)\)/)).every((r) => r.status === 200);
  return { status: qOk && paidOk ? "PASS" : qOk ? "PARTIAL" : "FAIL", details: { runs } };
});

// =============================================================================================
// structured outputs
// =============================================================================================
const CLAIM_SCHEMA = {
  type: "object",
  properties: {
    claimant_name: { type: "string" },
    policy_number: { type: "string" },
    phone: { type: "string" },
    accident_times: { type: "array", items: { type: "string" } },
  },
  required: ["claimant_name", "policy_number", "phone", "accident_times"],
  additionalProperties: false,
} as const;
const SNIPPET =
  "Claimant: Hi, it's Priya Shah. Policy number H P 7 7 4 0 3 9 1. I was rear-ended around 5 p.m. " +
  "Adjuster: What time did it happen? Claimant: Around 7 p.m. My cell is 415-555-0137.";

await withTest("structured", async (log, _c, raw) => {
  const rf = jsonSchemaFormat("claim_facts", CLAIM_SCHEMA as unknown as Record<string, unknown>);
  const msgs = [
    { role: "system", content: "Extract claim facts from the call snippet as JSON." },
    { role: "user", content: SNIPPET },
  ];
  const runs: Array<Record<string, unknown>> = [];
  runs.push({ label: "claude-sonnet-4-6 json_schema", ...(await paidProbe(raw, CLAUDE, { messages: msgs, response_format: rf })) });
  runs.push({ label: "gpt-5-nano json_schema", ...(await paidProbe(raw, OPENAI_CHEAP, { messages: msgs, response_format: rf })) });
  const q = await raw({ model: FAST, messages: msgs, max_tokens: 300, temperature: 0, response_format: rf });
  const qc = content(q.json);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(qc.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, ""));
  } catch {
    parsed = null;
  }
  runs.push({ label: "qwen fast + response_format (not in its supported_parameters)", status: q.status, ms: q.ms, content: trunc(qc, 400), validJson: parsed !== null, fencesPresent: /```/.test(qc), parsed, error: q.status !== 200 ? q.json : undefined });
  for (const r of runs) log.note("run", r);
  const paidOk = runs.slice(0, 2).every((r) => r.status === 200);
  return {
    status: paidOk ? "PASS" : "FAIL",
    details: { blockedBy: paidOk ? null : "C10: no paid-model access on this account; every response_format-capable model returned 400", request_response_format: { type: "json_schema", json_schema: { name: "claim_facts", strict: true, schema: CLAIM_SCHEMA } }, runs },
  };
});

// =============================================================================================
// tools
// =============================================================================================
const TOOLS = [
  {
    type: "function",
    function: {
      name: "lookup_policy",
      description: "Look up an insurance policy by number.",
      parameters: { type: "object", properties: { policy_number: { type: "string" } }, required: ["policy_number"], additionalProperties: false },
    },
  },
];
await withTest("tools", async (log, _c, raw) => {
  const msgs = [{ role: "user", content: "What is the deductible on policy HP7740391? Use the tool." }];
  const runs: Array<Record<string, unknown>> = [];
  runs.push({ label: "claude-sonnet-4-6 tools", ...(await paidProbe(raw, CLAUDE, { messages: msgs, tools: TOOLS, tool_choice: "auto" })) });
  runs.push({ label: "gpt-5-nano tools", ...(await paidProbe(raw, OPENAI_CHEAP, { messages: msgs, tools: TOOLS, tool_choice: "auto" })) });
  const q = await raw({ model: FAST, messages: msgs, tools: TOOLS, tool_choice: "auto", max_tokens: 200, temperature: 0 });
  const choice = (q.json as { choices?: Array<{ finish_reason?: string; message?: { tool_calls?: unknown; content?: string } }> })?.choices?.[0];
  runs.push({ label: "qwen fast + tools (not in its supported_parameters)", status: q.status, ms: q.ms, finish_reason: choice?.finish_reason, tool_calls: choice?.message?.tool_calls ?? null, content: trunc(choice?.message?.content, 300), error: q.status !== 200 ? q.json : undefined });
  for (const r of runs) log.note("run", r);
  const paidOk = runs.slice(0, 2).every((r) => r.status === 200);
  return { status: paidOk ? "PASS" : "FAIL", details: { blockedBy: paidOk ? null : "C10: no access to any tools-capable model", runs } };
});

// =============================================================================================
// stream
// =============================================================================================
async function rawSse(log: JsonlLogger, lf: typeof fetch, body: Record<string, unknown>) {
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    const res = await lf(`${GATEWAY_BASE_US}/chat/completions`, {
      method: "POST",
      headers: { authorization: ASSEMBLYAI_API_KEY, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const ttfbMs = Math.round(performance.now() - t0);
    const ct = res.headers.get("content-type");
    if (res.status === 429 && attempt < 5) {
      await res.text();
      const wait = Number(res.headers.get("retry-after") ?? 30) * 1000 + 750;
      log.note("rate-limited; waiting retry-after", { model: body.model, waitMs: wait });
      await sleep(wait);
      continue;
    }
    if (!res.body || !ct?.includes("event-stream")) {
      const text = await res.text();
      let j: unknown = text;
      try {
        j = JSON.parse(text);
      } catch {
        /* text */
      }
      return { status: res.status, contentType: ct, ttfbMs, totalMs: Math.round(performance.now() - t0), streamed: false, body: j };
    }
    const events: Array<{ atMs: number; data: string }> = [];
    const dec = new TextDecoder();
    let buf = "";
    let firstContentMs: number | null = null;
    let text = "";
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(part, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const ev = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const atMs = Math.round(performance.now() - t0);
        const data = ev.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
        events.push({ atMs, data: data || ev });
        if (data && data !== "[DONE]") {
          try {
            const d = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content;
            if (d) {
              if (firstContentMs === null) firstContentMs = atMs;
              text += d;
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
    return {
      status: res.status,
      contentType: ct,
      ttfbMs,
      firstContentMs,
      totalMs: Math.round(performance.now() - t0),
      streamed: events.length > 2,
      events: events.length,
      first3: events.slice(0, 3).map((e) => ({ atMs: e.atMs, data: trunc(e.data, 400) })),
      last3: events.slice(-3).map((e) => ({ atMs: e.atMs, data: trunc(e.data, 400) })),
      text: trunc(text, 300),
    };
  }
}

await withTest("stream", async (log, client) => {
  const lf = loggingFetch(log);
  const q = [{ role: "user" as const, content: "Count from 1 to 12 in words, comma separated." }];
  const out: Record<string, unknown> = {};
  out.openai_raw = await rawSse(log, lf, { model: OPENAI_CHEAP, messages: q, max_tokens: 1500, stream: true });
  out.claude_raw = await rawSse(log, lf, { model: CLAUDE, messages: q, max_tokens: 200, stream: true });
  out.qwen_raw = await rawSse(log, lf, { model: FAST, messages: q, max_tokens: 120, stream: true, stream_options: { include_usage: true } });
  try {
    out.qwen_sdk = await sdkPaced(log, "qwen sdk stream", () => gatewayStream(client, { model: FAST, messages: q, max_tokens: 120 }));
  } catch (e) {
    out.qwen_sdk = { error: sdkErr(e) };
  }
  for (const [k, v] of Object.entries(out)) log.note(k, v);
  const streamedQwen = !!(out.qwen_raw as { streamed?: boolean }).streamed;
  const streamedOpenAI = !!(out.openai_raw as { streamed?: boolean }).streamed;
  return {
    status: streamedOpenAI ? "PASS" : streamedQwen ? "PARTIAL" : "FAIL",
    details: { streamedOpenAI, streamedClaude: !!(out.claude_raw as { streamed?: boolean }).streamed, streamedQwen, note: "OpenAI/Claude blocked by C10 (400 before any SSE)", ...out },
  };
});

// =============================================================================================
// transcript_id injection
// =============================================================================================
await withTest("transcript", async (log, _c, raw) => {
  const baseId = asyncState.transcripts.base;
  const redactedId = asyncState.transcripts.full;
  if (!baseId) return { status: "SKIPPED", details: { reason: "no async transcripts; run async/smoke.ts first" } };
  const runs: Array<Record<string, unknown>> = [];
  const ASK = "From the call transcript below, list every time of day the caller gave for when the accident happened, and the policy number. One line each.";

  runs.push({ label: "claude-sonnet-4-6 + transcript_id", ...(await paidProbe(raw, CLAUDE, { transcript_id: baseId, messages: [{ role: "user", content: `${ASK}\n\n${TRANSCRIPT_TAG}` }] })) });

  for (const [label, tag] of [
    ["exact tag {{ transcript }}", "{{ transcript }}"],
    ["no-space tag {{transcript}}", "{{transcript}}"],
  ] as const) {
    const r = await raw({ model: FAST, transcript_id: baseId, messages: [{ role: "user", content: `${ASK}\n\n${tag}` }], max_tokens: 120, temperature: 0 });
    const c = content(r.json);
    runs.push({ label: `qwen fast ${label}`, status: r.status, ms: r.ms, usage: (r.json as { usage?: unknown })?.usage, content: trunc(c, 300), found5pm: /\b5\b|five/i.test(c), found7pm: /\b7\b|seven/i.test(c), foundPolicy: /HP\s*7740391/i.test(c), error: r.status !== 200 ? r.json : undefined });
  }
  if (redactedId) {
    const r = await raw({ model: FAST, transcript_id: redactedId, messages: [{ role: "user", content: `Repeat the following text exactly, nothing else:\n${TRANSCRIPT_TAG}` }], max_tokens: 400, temperature: 0 });
    const c = content(r.json);
    runs.push({ label: "qwen fast + PII-redacted transcript (which text is injected?)", status: r.status, ms: r.ms, usage: (r.json as { usage?: unknown })?.usage, injectedLooksRedacted: /\[PERSON_NAME\]|\[PHONE_NUMBER\]|\[ORGANIZATION\]/.test(c), injectedHasRawPII: /Priya|415-555|Reyes/.test(c), content: trunc(c, 400) });
  }
  const u = await raw({ model: FAST, transcript_id: "00000000-0000-0000-0000-000000000000", messages: [{ role: "user", content: `Summarize: ${TRANSCRIPT_TAG}` }], max_tokens: 20 });
  runs.push({ label: "unknown transcript_id", status: u.status, body: u.json });
  const nt = await raw({ model: FAST, transcript_id: baseId, messages: [{ role: "user", content: "Reply with the single word OK." }], max_tokens: 10 });
  runs.push({ label: "transcript_id without any tag", status: nt.status, usage: (nt.json as { usage?: unknown })?.usage, content: content(nt.json), body: nt.status !== 200 ? nt.json : undefined });
  for (const r of runs) log.note("run", r);
  const exact = runs.find((r) => String(r.label).includes("exact tag")) as { status?: number; found7pm?: boolean; foundPolicy?: boolean } | undefined;
  return { status: exact?.status === 200 && exact.found7pm && exact.foundPolicy ? "PASS" : exact?.status === 200 ? "PARTIAL" : "FAIL", details: { baseId, redactedId, runs } };
});

// =============================================================================================
// region - model_region + EU endpoint  [C26]
// =============================================================================================
await withTest("region", async (log, _c, raw) => {
  const runs: Array<Record<string, unknown>> = [];
  const cases: Array<{ label: string; base: string; body: Record<string, unknown> }> = [
    { label: "claude-sonnet-4-6 model_region=global", base: GATEWAY_BASE_US, body: { model: CLAUDE, messages: PING, max_tokens: 40, model_region: "global" } },
    { label: "qwen fast model_region=global (catalog regions: us,eu)", base: GATEWAY_BASE_US, body: { model: FAST, messages: PING, max_tokens: 40, model_region: "global" } },
    { label: "qwen fast model_region=us (only 'global' documented)", base: GATEWAY_BASE_US, body: { model: FAST, messages: PING, max_tokens: 40, model_region: "us" } },
    { label: "EU endpoint qwen fast (US catalog says eu; EU catalog omits it)", base: GATEWAY_BASE_EU, body: { model: FAST, messages: PING, max_tokens: 40 } },
    { label: "EU endpoint claude-haiku-4-5", base: GATEWAY_BASE_EU, body: { model: "claude-haiku-4-5-20251001", messages: PING, max_tokens: 40 } },
  ];
  for (const c of cases) {
    const r = await raw(c.body, { base: c.base });
    const j = r.json as { choices?: Array<{ finish_reason?: string }>; usage?: unknown };
    runs.push({ label: c.label, status: r.status, ms: r.ms, finish_reason: j?.choices?.[0]?.finish_reason, content: trunc(content(r.json), 80), usage: j?.usage, body: r.status !== 200 ? r.json : undefined, rate: r.rate });
  }
  for (const r of runs) log.note("run", r);
  return { status: runs.some((r) => r.status === 200) ? "PARTIAL" : "FAIL", details: { runs } };
});

// =============================================================================================
// fallback + json-repair
// =============================================================================================
await withTest("fallback", async (log, _c, raw) => {
  const runs: Array<Record<string, unknown>> = [];
  const SLOPPY = "Output this JS object exactly as written, no code fences, nothing else: {name: 'Priya', amounts: [3450, 125, 500,],}";
  const cases: Array<{ label: string; body: Record<string, unknown> }> = [
    { label: "unknown primary -> fallbacks:[qwen]", body: { model: "no-such-model-xyz", messages: PING, max_tokens: 40, fallbacks: [{ model: FAST }] } },
    { label: "no-access primary (claude) -> fallbacks:[qwen]", body: { model: CLAUDE, messages: PING, max_tokens: 40, fallbacks: [{ model: FAST }] } },
    { label: "unknown model, no fallback", body: { model: "no-such-model-xyz", messages: PING, max_tokens: 40 } },
    { label: "qwen + post_processing_steps json-repair", body: { model: FAST, messages: [{ role: "user", content: SLOPPY }], max_tokens: 60, temperature: 0, post_processing_steps: [{ type: "json-repair" }] } },
    { label: "qwen same prompt, no json-repair", body: { model: FAST, messages: [{ role: "user", content: SLOPPY }], max_tokens: 60, temperature: 0 } },
  ];
  for (const c of cases) {
    const r = await raw(c.body);
    const j = r.json as { choices?: Array<{ finish_reason?: string }>; usage?: unknown; model?: string; request?: unknown };
    const c2 = content(r.json);
    let validJson: boolean | null = null;
    if (r.status === 200) {
      try {
        JSON.parse(c2);
        validJson = true;
      } catch {
        validJson = false;
      }
    }
    runs.push({ label: c.label, status: r.status, ms: r.ms, model: j?.model ?? null, request_echo: j?.request ?? null, content: trunc(c2, 150), validJson, usage: j?.usage, body: r.status !== 200 ? r.json : undefined });
  }
  for (const r of runs) log.note("run", r);
  return { status: (runs[0] as { status: number }).status === 200 ? "PASS" : "PARTIAL", details: { runs } };
});

if (qwenLatency.length) {
  const s = [...qwenLatency].sort((a, b) => a - b);
  const stats = { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)], max: s.at(-1) };
  summary.qwenLatencyMs = stats;
  writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  console.log("qwen latency", JSON.stringify(stats));
}
console.log(`summary -> ${SUMMARY_PATH}`);
