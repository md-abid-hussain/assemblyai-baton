/**
 * gateway/selftest.ts - offline checks of gateway/client.ts and async/client.ts with a mock fetch
 * (no network, no keys used). Covers what the live account cannot reach (tool loop on OpenAI- and
 * Claude-style finish reasons) plus header hygiene, webhooks, polling and 429 handling.
 *
 *   npx tsx gateway/selftest.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { loadDialogScript, sentimentReport } from "../async/compare.ts";
import {
  unsupportedParams,
  type GatewayModel,
  createGatewayClient,
  extractToolCalls,
  gatewayChat,
  gatewayStream,
  normalizeFinishReason,
  parseJsonContent,
  runToolLoop,
  usageTokens,
  type GatewayChatCompletion,
} from "./client.ts";
import {
  AssemblyAIAsyncClient,
  AssemblyAIHttpError,
  TranscriptFailedError,
  applySpeakerMapping,
  billableSeconds,
  formatUtterances,
  parseWebhook,
  reattributeSentiment,
  stripSpeakerTags,
  verifyWebhookHeader,
  webhookParams,
  type Transcript,
} from "../async/client.ts";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const json = (b: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });

function mockFetch(handler: Handler, seen: Array<{ url: string; headers: Headers; body: unknown }>): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    let body: unknown = init.body;
    if (typeof body === "string") body = JSON.parse(body);
    seen.push({ url, headers, body });
    return handler(url, init);
  }) as typeof fetch;
}

const results: Array<{ name: string; ok: boolean; err?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, err: e instanceof Error ? e.message : String(e) });
  }
}

const completion = (message: Record<string, unknown>, finish: string, usage: Record<string, number> = { input_tokens: 10, output_tokens: 5, total_tokens: 15 }) => ({
  request_id: "r1",
  choices: [{ message: { role: "assistant", ...message }, finish_reason: finish }],
  request: { model: "m", max_tokens: 100 },
  usage,
  http_status_code: 200,
  response_time: 123456789,
  llm_status_code: 200,
});

// ---------------------------------------------------------------------------------------------
await check("normalizeFinishReason covers OpenAI + Claude families", () => {
  assert.equal(normalizeFinishReason("stop"), "stop");
  assert.equal(normalizeFinishReason("end_turn"), "stop");
  assert.equal(normalizeFinishReason("tool_calls"), "tool_calls");
  assert.equal(normalizeFinishReason("tool_use"), "tool_calls");
  assert.equal(normalizeFinishReason("length"), "length");
  assert.equal(normalizeFinishReason("max_tokens"), "length");
  assert.equal(normalizeFinishReason(undefined), "other");
});

await check("parseJsonContent strips ```json fences", () => {
  const c = completion({ content: '```json\n{"a":1}\n```' }, "stop") as unknown as GatewayChatCompletion;
  assert.deepEqual(parseJsonContent(c), { a: 1 });
});

await check("usageTokens reads Gateway (input/output) and OpenAI (prompt/completion) names", () => {
  assert.deepEqual(usageTokens({ input_tokens: 3, output_tokens: 4 }), { input: 3, output: 4 });
  assert.deepEqual(usageTokens({ prompt_tokens: 5, completion_tokens: 6 }), { input: 5, output: 6 });
});

await check("SDK client: Bearer AssemblyAI key, gateway baseURL, no OpenAI org/project headers, extras pass through", async () => {
  const seen: Array<{ url: string; headers: Headers; body: unknown }> = [];
  process.env.OPENAI_ORG_ID = "org-should-not-leak";
  process.env.OPENAI_PROJECT_ID = "proj-should-not-leak";
  const client = createGatewayClient({ apiKey: "aai-test-key-1234567890", fetch: mockFetch(() => json(completion({ content: "Paris." }, "stop")), seen), maxRetries: 0 });
  const r = await gatewayChat(client, { model: "qwen3.5-4b-32k-fast", messages: [{ role: "user", content: "hi {{ transcript }}" }], max_tokens: 10, transcript_id: "t-123", model_region: "global", post_processing_steps: [{ type: "json-repair" }] });
  delete process.env.OPENAI_ORG_ID;
  delete process.env.OPENAI_PROJECT_ID;
  const req = seen[0]!;
  assert.equal(req.url, "https://llm-gateway.assemblyai.com/v1/chat/completions");
  assert.equal(req.headers.get("authorization"), "Bearer aai-test-key-1234567890");
  assert.equal(req.headers.get("openai-organization"), null);
  assert.equal(req.headers.get("openai-project"), null);
  const b = req.body as Record<string, unknown>;
  assert.equal(b.transcript_id, "t-123");
  assert.equal(b.model_region, "global");
  assert.deepEqual(b.post_processing_steps, [{ type: "json-repair" }]);
  assert.equal(b.stream, false);
  assert.equal(r.completion.response_time, 123456789);
  assert.equal(r.completion.choices[0]?.message.content, "Paris.");
});

for (const family of [
  { name: "OpenAI-style (tool_calls -> stop)", callFinish: "tool_calls", doneFinish: "stop" },
  { name: "Claude-style (tool_use -> end_turn)", callFinish: "tool_use", doneFinish: "end_turn" },
]) {
  await check(`runToolLoop ${family.name}`, async () => {
    const seen: Array<{ url: string; headers: Headers; body: unknown }> = [];
    let n = 0;
    const client = createGatewayClient({
      apiKey: "k-000000000000000000",
      maxRetries: 0,
      fetch: mockFetch(() => {
        n++;
        if (n === 1) return json(completion({ content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup_policy", arguments: '{"policy_number":"HP7740391"}' } }] }, family.callFinish));
        return json(completion({ content: "The deductible is $500." }, family.doneFinish));
      }, seen),
    });
    const got: unknown[] = [];
    const { final, iterations, messages } = await runToolLoop(
      client,
      { model: "m", messages: [{ role: "user", content: "deductible?" }], tools: [{ type: "function", function: { name: "lookup_policy", parameters: { type: "object", properties: {} } } }] },
      { lookup_policy: (a) => (got.push(a), { deductible_usd: 500 }) },
    );
    assert.equal(iterations, 2);
    assert.deepEqual(got, [{ policy_number: "HP7740391" }]);
    assert.equal(normalizeFinishReason(final.completion.choices[0]?.finish_reason), "stop");
    const second = seen[1]!.body as { messages: Array<{ role: string; tool_call_id?: string; content?: string; tool_calls?: unknown[] }> };
    assert.equal(second.messages[1]?.role, "assistant");
    assert.equal(second.messages[1]?.tool_calls?.length, 1);
    assert.equal(second.messages[2]?.role, "tool");
    assert.equal(second.messages[2]?.tool_call_id, "call_1");
    assert.equal(second.messages[2]?.content, '{"deductible_usd":500}');
    assert.equal(messages.length, 3);
    assert.equal(extractToolCalls(completion({ content: null, tool_calls: [{ id: "x", type: "function", function: { name: "f", arguments: "{}" } }] }, "tool_use") as unknown as GatewayChatCompletion).length, 1);
  });
}

await check("gatewayStream assembles SSE deltas, TTFT, finish_reason, usage", async () => {
  const chunks = [
    { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "one, " }, finish_reason: null }] },
    { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "two" }, finish_reason: "stop" }] },
    { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  ];
  const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  const client = createGatewayClient({ apiKey: "k-000000000000000000", maxRetries: 0, fetch: mockFetch(() => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }), []) });
  const deltas: string[] = [];
  const s = await gatewayStream(client, { model: "m", messages: [{ role: "user", content: "count" }] }, (d) => deltas.push(d));
  assert.equal(s.text, "one, two");
  assert.deepEqual(deltas, ["one, ", "two"]);
  assert.equal(s.finishReason, "stop");
  assert.ok(s.ttftMs !== null);
  assert.deepEqual(s.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
});

// ---------------------------------------------------------------------------------------------
// async client
// ---------------------------------------------------------------------------------------------
await check("async: raw Authorization (no Bearer), submit + poll to completed", async () => {
  const seen: Array<{ url: string; headers: Headers; body: unknown }> = [];
  let polls = 0;
  const c = new AssemblyAIAsyncClient({
    apiKey: "aai-raw-key-00000000",
    fetch: mockFetch((url, init) => {
      if (init.method === "POST") return json({ id: "t1", status: "queued" });
      polls++;
      return json({ id: "t1", status: polls < 3 ? "processing" : "completed", text: "hello", audio_duration: 70 });
    }, seen),
  });
  const t = await c.transcribe({ audio_url: "https://cdn.assemblyai.com/upload/x", speech_models: ["universal-3-5-pro"] }, { initialIntervalMs: 5, maxIntervalMs: 10 });
  assert.equal(t.status, "completed");
  assert.equal(polls, 3);
  assert.equal(seen[0]!.headers.get("authorization"), "aai-raw-key-00000000");
  assert.equal(seen[0]!.url, "https://api.assemblyai.com/v2/transcript");
});

await check("async: status=error throws TranscriptFailedError with the transcript", async () => {
  const c = new AssemblyAIAsyncClient({ apiKey: "aai-raw-key-00000000", fetch: mockFetch(() => json({ id: "t2", status: "error", error: "Transcoding failed" }), []) });
  await assert.rejects(c.waitForCompletion("t2", { initialIntervalMs: 1 }), (e: unknown) => e instanceof TranscriptFailedError && e.transcript.error === "Transcoding failed");
});

await check("async: 400 -> AssemblyAIHttpError with body.error in message (no retry on POST)", async () => {
  let calls = 0;
  const c = new AssemblyAIAsyncClient({ apiKey: "aai-raw-key-00000000", fetch: mockFetch(() => (calls++, json({ error: "speaker_labels or multichannel required" }, 400)), []) });
  await assert.rejects(c.submit({ audio_url: "u" }), (e: unknown) => e instanceof AssemblyAIHttpError && e.status === 400 && /speaker_labels/.test(e.message));
  assert.equal(calls, 1);
});

await check("async: understanding() retries 429 honoring retry-after, hits the gateway host", async () => {
  const seen: Array<{ url: string; headers: Headers; body: unknown }> = [];
  let n = 0;
  const waits: number[] = [];
  const c = new AssemblyAIAsyncClient({
    apiKey: "aai-raw-key-00000000",
    onRateLimit: (i) => waits.push(i.waitMs),
    fetch: mockFetch(() => (++n === 1 ? json({ message: "too many requests for this action", code: 429 }, 429, { "retry-after": "1", "x-ratelimit-limit": "2" }) : json({ request_id: "r", speech_understanding: { response: { translation: { status: "success" } } }, translated_texts: { es: "hola" } })), seen),
  });
  const r = await c.understanding("t1", { translation: { target_languages: ["es"] } });
  assert.equal(n, 2);
  assert.equal(waits[0], 1250);
  assert.equal(r.translated_texts?.es, "hola");
  assert.equal(seen[0]!.url, "https://llm-gateway.assemblyai.com/v1/understanding");
  assert.deepEqual(seen[0]!.body, { transcript_id: "t1", speech_understanding: { request: { translation: { target_languages: ["es"] } } } });
});

await check("async: webhook helpers", () => {
  assert.deepEqual(webhookParams("https://x/hook?claim=1", { headerName: "X-Hook-Secret", headerValue: "s3cret" }), { webhook_url: "https://x/hook?claim=1", webhook_auth_header_name: "X-Hook-Secret", webhook_auth_header_value: "s3cret" });
  assert.equal(verifyWebhookHeader(new Headers({ "x-hook-secret": "s3cret" }), "X-Hook-Secret", "s3cret"), true);
  assert.equal(verifyWebhookHeader({ "x-hook-secret": "nope" }, "X-Hook-Secret", "s3cret"), false);
  assert.equal(verifyWebhookHeader({}, "X-Hook-Secret", "s3cret"), false);
  assert.deepEqual(parseWebhook('{"transcript_id":"t1","status":"completed"}'), { transcript_id: "t1", status: "completed" });
  assert.deepEqual(parseWebhook('{"status":"redacted_audio_ready","redacted_audio_url":"https://s3/x.mp3"}'), { status: "redacted_audio_ready", redacted_audio_url: "https://s3/x.mp3" });
  assert.throws(() => parseWebhook('{"foo":1}'));
});

await check("async: formatUtterances + billableSeconds", () => {
  const t = { utterances: [{ speaker: "1", text: "Hi", start: 65_000, end: 66_000, confidence: 1, words: [] }], audio_duration: 70, audio_channels: 2 };
  assert.equal(formatUtterances(t, { label: (s) => (s === "1" ? "Adjuster" : s) }), "[01:05] Adjuster: Hi");
  assert.equal(billableSeconds(t, true), 140);
  assert.equal(billableSeconds(t, false), 70);
});

// ---------------------------------------------------------------------------------------------
// helpers validated against saved LIVE responses (skipped if the spike outputs are absent)
// ---------------------------------------------------------------------------------------------
const OUT = new URL("../out/", import.meta.url);
const load = (f: string): unknown => (existsSync(new URL(f, OUT)) ? JSON.parse(readFileSync(new URL(f, OUT), "utf8")) : null);

await check("unsupportedParams flags response_format/tools on qwen (live catalog), passes max_tokens/stream", () => {
  const cat = load("gateway_models.json") as { raw: { data: GatewayModel[] } } | null;
  if (!cat) return;
  const qwen = cat.raw.data.find((m) => m.id === "qwen3.5-4b-32k-fast");
  assert.deepEqual(unsupportedParams(qwen, { max_tokens: 10, stream: true, response_format: { type: "json_schema" }, tools: [] }), ["tools", "response_format"]);
  const sonnet = cat.raw.data.find((m) => m.id === "claude-sonnet-4-6");
  assert.deepEqual(unsupportedParams(sonnet, { max_tokens: 10, temperature: 0, tools: [], tool_choice: "auto", response_format: {} }), []);
  assert.deepEqual(unsupportedParams(undefined, {}), ["<model not in catalog>"]);
});

await check("reattributeSentiment fixes speaker labels + strips [Speaker:x] tags on the live 'full' transcript", () => {
  const t = load("async-full.transcript.json") as Transcript | null;
  if (!t) return;
  const script = loadDialogScript();
  const map: Record<string, string> = { A: "adjuster", B: "claimant" };
  const raw = t.sentiment_analysis_results ?? [];
  const fixed = reattributeSentiment(raw, t.utterances ?? []);
  // compare.ts scorer: truth = turn containing the row midpoint (nearest within 400 ms otherwise)
  const before = sentimentReport(t, script, map).speakerAccuracy ?? 0;
  const after = sentimentReport({ ...t, sentiment_analysis_results: fixed }, script, map).speakerAccuracy ?? 0;
  console.log(`   sentiment speaker accuracy: raw ${before.toFixed(3)} -> reattributed ${after.toFixed(3)} (${raw.length} rows)`);
  assert.ok(after >= 0.95, `after=${after}`);
  assert.ok(fixed.every((r) => !/\[Speaker:/.test(r.text)));
  assert.equal(stripSpeakerTags("[Speaker:Priya Shah] Perfect."), "Perfect.");
});

await check("applySpeakerMapping relabels unredacted_utterances on the live 'golden' transcript", () => {
  const t = load("async-golden.transcript.json") as Transcript | null;
  if (!t) return;
  const mapping = t.speech_understanding?.response?.speaker_identification?.mapping;
  assert.deepEqual(mapping, { A: "Adjuster", B: "Claimant" });
  const un = applySpeakerMapping(t.unredacted_utterances, mapping);
  assert.deepEqual([...new Set(un.map((u) => u.speaker))].sort(), ["Adjuster", "Claimant"]);
  assert.deepEqual(un.map((u) => u.speaker), (t.utterances ?? []).map((u) => u.speaker));
  assert.ok(un.every((u) => u.words?.every((w) => w.speaker === u.speaker)));
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.err ? ` -> ${r.err}` : ""}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
