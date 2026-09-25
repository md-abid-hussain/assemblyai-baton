/**
 * WP18·0: the pure analysis behind scripts/probes/publish-p1-p3.ts (P-1/P-2/P-3, PLATFORM §8.3). $0.
 */
import { describe, expect, it } from "vitest";

import {
  PROBE_NEXT_STEP, analyzeEchoResult, followsNextStep, greetingSimilarity, p1RunPass, p2RunPass, parseArgs, redactHeaders, summarizeTurns,
  toolCallsNamed,
} from "../../../../scripts/probes/p1p3-analyze";

const KEY = "probe-key-abcdefghijklmnopqrstuvwxyz012345";
const GREETING = "Hi Jordan, this is Brightside Dental's automated assistant. Your cleaning is on Tuesday at three, and a twenty-five dollar deposit holds it.";

const echo = (o: { headers?: Record<string, string>; json?: unknown; args?: Record<string, string> } = {}) =>
  JSON.stringify({
    args: o.args ?? { next_step: PROBE_NEXT_STEP },
    data: o.json ?? "",
    files: {},
    form: {},
    headers: o.headers ?? {
      host: "postman-echo.com",
      "x-forwarded-proto": "https",
      "x-amzn-trace-id": "Root=1-abc",
      "content-type": "application/json",
      "user-agent": "Python/3.13 aiohttp/3.14.3",
      "x-changeover-key": KEY,
    },
    json: o.json ?? { patient_name: "Jordan Lee", amount_usd: 25 },
    url: `https://postman-echo.com/post?next_step=${encodeURIComponent(PROBE_NEXT_STEP)}`,
  });

describe("P-1 greeting", () => {
  it("scores a verbatim greeting 1 and a paraphrase lower; spelled and digit numbers are equal", () => {
    expect(greetingSimilarity(GREETING, GREETING)).toBe(1);
    expect(greetingSimilarity(GREETING, GREETING.replace("twenty-five dollar", "$25"))).toBeGreaterThanOrEqual(0.95);
    expect(greetingSimilarity(GREETING, "Hello Jordan, I'm calling from the dentist about your deposit.")!).toBeLessThan(0.6);
    expect(greetingSimilarity(GREETING, null)).toBeNull();
  });
  it("passes only with similarity ≥ 0.95 and first audible ≤ 2.5 s", () => {
    expect(p1RunPass({ similarity: 0.96, firstAudibleMs: 2400 })).toBe(true);
    expect(p1RunPass({ similarity: 0.94, firstAudibleMs: 900 })).toBe(false);
    expect(p1RunPass({ similarity: 1, firstAudibleMs: 2600 })).toBe(false);
    expect(p1RunPass({ similarity: null, firstAudibleMs: 900 })).toBe(false);
    expect(p1RunPass({ similarity: 1, firstAudibleMs: null })).toBe(false);
  });
});

describe("P-2 echo analysis", () => {
  it("finds the JSON body, the key header (never its value) and every header name", () => {
    const a = analyzeEchoResult(echo(), { patient_name: "Jordan Lee", amount_usd: 25 }, KEY);
    expect(a).toMatchObject({ parsed: true, argsInBody: true, argsInQuery: false, nextStepEchoed: true, contentType: "application/json" });
    expect(a.headers.keyMatched).toBe(true);
    expect(a.headers.headers["x-changeover-key"]).toBe("[probe key: matched]");
    expect(a.headers.names).toEqual(["content-type", "host", "user-agent", "x-amzn-trace-id", "x-changeover-key", "x-forwarded-proto"]);
    expect(a.idLikeHeaders).toEqual(["x-amzn-trace-id"]);
    expect(JSON.stringify(a)).not.toContain(KEY);
    expect(p2RunPass(a, true)).toBe(true);
    expect(p2RunPass(a, false)).toBe(false);
  });
  it("numbers compare by value (the model may send 25 or \"25\")", () => {
    expect(analyzeEchoResult(echo({ json: { patient_name: "Jordan Lee", amount_usd: "25" } }), { patient_name: "Jordan Lee", amount_usd: 25 }, KEY).argsInBody).toBe(true);
  });
  it("reports args merged into the query (the T4 GET shape) and a missing or wrong key", () => {
    const a = analyzeEchoResult(
      echo({ args: { next_step: PROBE_NEXT_STEP, patient_name: "Jordan Lee", amount_usd: "25" }, json: {}, headers: { "x-changeover-key": "other" } }),
      { patient_name: "Jordan Lee", amount_usd: 25 },
      KEY,
    );
    expect(a).toMatchObject({ argsInBody: false, argsInQuery: true });
    expect(a.headers).toMatchObject({ keyPresent: true, keyMatched: false });
    expect(p2RunPass(a, true)).toBe(false);
    expect(analyzeEchoResult(echo({ headers: { host: "x" } }), { a: 1 }, KEY).headers.keyPresent).toBe(false);
  });
  it("redacts secret-looking headers and any value containing the probe key", () => {
    const r = redactHeaders({ Authorization: "Bearer zzz", "X-Api-Key": "k", "X-Trace": `a${KEY}b`, "X-Session-Id": "sess_1" }, KEY);
    expect(r.headers).toEqual({ authorization: "[redacted: 10 chars]", "x-api-key": "[redacted: 1 chars]", "x-trace": expect.stringMatching(/^\[redacted/), "x-session-id": "sess_1" });
  });
  it("survives a non-JSON result", () => {
    expect(analyzeEchoResult("<html>502</html>", { a: 1 }, KEY)).toMatchObject({ parsed: false, argsInBody: false });
    expect(analyzeEchoResult(undefined, { a: 1 }, KEY).parsed).toBe(false);
  });
});

describe("P-3 and timeline helpers", () => {
  it("a reply follows the in-band step when it asks for a colour", () => {
    expect(followsNextStep("Done! By the way, what's your favourite colour?")).toBe(true);
    expect(followsNextStep("What is your favorite color?")).toBe(true);
    expect(followsNextStep("I've sent the link. Anything else?")).toBe(false);
    expect(followsNextStep(null)).toBe(false);
  });
  it("finds tool calls by name, parses string args and scrubs the key from summaries", () => {
    const turns = [
      { trigger: "reply_create", agent_text: "Hi" },
      { trigger: "user_speech", agent_text: `ok ${KEY}`, tool_calls: [{ name: "send_deposit_link", arguments: '{"amount_usd":25}', duration_ms: 180 }] },
    ];
    const calls = toolCallsNamed(turns, "send_deposit_link");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.turnIndex).toBe(1);
    expect(parseArgs(calls[0]!.call.arguments)).toEqual({ amount_usd: 25 });
    expect(parseArgs("not json")).toEqual({});
    const sum = summarizeTurns(turns, KEY);
    expect(JSON.stringify(sum)).not.toContain(KEY);
    expect(sum[1]).toMatchObject({ trigger: "user_speech", tools: [{ name: "send_deposit_link", ms: 180, isError: false, timedOut: false }] });
  });
});
