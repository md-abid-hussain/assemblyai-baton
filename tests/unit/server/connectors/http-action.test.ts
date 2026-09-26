/**
 * WP16 acceptance 1–4 at the `executeHttpAction` level, over a real local socket (the transport rewrites the
 * pinned https://host:443 request to a plain-HTTP 127.0.0.1 server and records the options it got):
 * request shape (POST body, GET query, fixed headers, no Accept-Encoding, header allowlist), HMAC with the documented
 * algorithm, anti-rebinding (one resolution, the pinned address is what is dialled), redirects, compression, size,
 * time and content-type limits, non-2xx, responsePick flattening under `data`, the production allowlist, and
 * secret redaction (an echo that reflects the Authorization header cannot leak it to the agent).
 */
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { CHANGEOVER_DEMO_ECHO_SECRET, CONNECTOR_USER_AGENT } from "@/core/contracts/v2/api";
import { destinationPolicy, type DestinationPolicy } from "@/server/connectors/destination";
import { hmacHex, verifyHmac } from "@/server/connectors/hmac";
import { executeHttpAction, type HttpActionInput } from "@/server/connectors/http";
import { localTransport, PUBLIC_V4, startServer, tableResolver, type CapturedCall, type LocalServer } from "./helpers";

const DEV: DestinationPolicy = { enforceAllowlist: false, hosts: [] };
const RUN = { relay: "dental-deposit", version: 3, case: "case_1", mode: "test" as const };

function input(over: Partial<HttpActionInput> = {}): HttpActionInput {
  return {
    url: "https://api.example.com/hooks/deposit?src=co",
    method: "POST",
    toolName: "check_deposit",
    args: { patient: "Ana", amount: 120 },
    run: RUN,
    headers: [],
    hmac: null,
    timeoutMs: 2000,
    responsePick: ["ok", "json.amount", "json.patient", "items.0.name", "deep.a.b.c"],
    ...over,
  };
}

let server: LocalServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function run(
  handle: Parameters<typeof startServer>[0],
  over: Partial<HttpActionInput> = {},
  policy: DestinationPolicy = DEV,
  resolverTable: Parameters<typeof tableResolver>[0] = { "api.example.com": { v4: [PUBLIC_V4] } },
) {
  server = await startServer(handle);
  const calls: CapturedCall[] = [];
  const resolver = tableResolver(resolverTable);
  const report = await executeHttpAction(input(over), {
    policy, resolver, request: localTransport(server.port, calls), uuid: () => "11111111-2222-4333-8444-555555555555",
  });
  return { report, calls, resolver, seen: server.seen };
}

const jsonReply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  (_req: unknown, res: import("node:http").ServerResponse) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

describe("request shape", () => {
  it("POSTs {tool, args, run} as JSON with only the fixed headers; no Accept-Encoding; picks under data", async () => {
    const { report, calls, seen } = await run(
      jsonReply(200, { ok: true, json: { amount: 120, patient: "Ana", secretish: "x" }, items: [{ name: "cleaning" }], deep: { a: { b: { c: "d" } } } }),
    );
    expect(report).toMatchObject({ status: "ok", errorCode: null, httpStatus: 200, address: PUBLIC_V4 });
    expect(report.agentResult).toEqual({
      data: { ok: true, "json.amount": 120, "json.patient": "Ana", "items.0.name": "cleaning", "deep.a.b.c": "d" },
      http_status: 200,
    });
    const got = seen[0]!;
    expect(got.method).toBe("POST");
    expect(got.url).toBe("/hooks/deposit?src=co");
    expect(JSON.parse(got.body)).toEqual({ tool: "check_deposit", args: { patient: "Ana", amount: 120 }, run: RUN });
    expect(got.headers["content-type"]).toBe("application/json");
    expect(got.headers["user-agent"]).toBe(CONNECTOR_USER_AGENT);
    expect(got.headers["x-changeover-delivery"]).toBe("11111111-2222-4333-8444-555555555555");
    expect(got.headers["accept-encoding"]).toBeUndefined();
    expect(got.headers["x-changeover-signature"]).toBeUndefined();
    expect(report.reqBytes).toBe(Buffer.byteLength(got.body));
    // TLS/pinning options handed to https.request
    const o = calls[0]!.options;
    expect(o).toMatchObject({ hostname: "api.example.com", port: 443, servername: "api.example.com", autoSelectFamily: false, agent: false });
    expect(calls[0]!.pinned.plain).toEqual([PUBLIC_V4, 4]);
    expect(calls[0]!.pinned.all).toEqual([{ address: PUBLIC_V4, family: 4 }]);
  });

  it("GET puts the args in the query and sends no body", async () => {
    const { report, seen } = await run(jsonReply(200, { ok: true }), { method: "GET", args: { q: "a b", n: 2, yes: true } });
    expect(report.status).toBe("ok");
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe("/hooks/deposit?src=co&q=a+b&n=2&yes=true");
    expect(seen[0]!.body).toBe("");
    expect(seen[0]!.headers["content-type"]).toBeUndefined();
  });

  it("keeps declared headers (Authorization allowed) and drops Host, Cookie, Accept-Encoding, hop-by-hop and X-Changeover-*", async () => {
    const { report, seen } = await run(jsonReply(200, {}), {
      headers: [
        { name: "Authorization", value: "Bearer tok_demo_123456", secretName: "demo_token" },
        { name: "X-Api-Version", value: "2" },
        { name: "Host", value: "internal.local" },
        { name: "Cookie", value: "a=b" },
        { name: "Accept-Encoding", value: "gzip" },
        { name: "Connection", value: "upgrade" },
        { name: "Transfer-Encoding", value: "chunked" },
        { name: "X-Changeover-Signature", value: "v1=forged" },
        { name: "User-Agent", value: "spoof" },
        { name: "X-Bad", value: "a\r\nInjected: 1" },
      ],
    });
    const h = seen[0]!.headers;
    expect(h.authorization).toBe("Bearer tok_demo_123456");
    expect(h["x-api-version"]).toBe("2");
    expect(h.cookie).toBeUndefined();
    expect(h["accept-encoding"]).toBeUndefined();
    expect(h["x-changeover-signature"]).toBeUndefined();
    expect(h["user-agent"]).toBe(CONNECTOR_USER_AGENT);
    expect(h.injected).toBeUndefined();
    expect(report.droppedHeaders).toEqual(["Host", "Cookie", "Accept-Encoding", "Connection", "Transfer-Encoding", "X-Changeover-Signature", "User-Agent", "X-Bad"]);
    // the console view shows the secret-backed value as a marker
    expect(report.request!.headers).toContainEqual({ name: "Authorization", value: "‹secret:demo_token›" });
    expect(JSON.stringify(report)).not.toContain("tok_demo_123456");
  });

  it("refuses a request body over 8 KiB before any DNS or socket", async () => {
    const { report, resolver, seen } = await run(jsonReply(200, {}), { args: { blob: "x".repeat(9000) } });
    expect(report).toMatchObject({ status: "refused", errorCode: "E_CONN_REQUEST_TOO_LARGE" });
    expect(resolver.calls).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("HMAC", () => {
  it("signs v1=HMAC-SHA256(secret, `${ts}.${rawBody}`) and a receiver verifies it", async () => {
    const t = 1_790_000_000_000;
    server = await startServer(jsonReply(200, {}));
    const calls: CapturedCall[] = [];
    const report = await executeHttpAction(input({ hmac: { name: "echo_demo", value: CHANGEOVER_DEMO_ECHO_SECRET } }), {
      policy: DEV, resolver: tableResolver({ "api.example.com": { v4: [PUBLIC_V4] } }), request: localTransport(server.port, calls), now: () => t,
    });
    const h = server.seen[0]!.headers;
    const ts = String(Math.floor(t / 1000));
    expect(h["x-changeover-timestamp"]).toBe(ts);
    expect(h["x-changeover-signature"]).toBe(`v1=${hmacHex(CHANGEOVER_DEMO_ECHO_SECRET, ts, server.seen[0]!.body)}`);
    expect(report.signature).toBe(h["x-changeover-signature"]);
    expect(verifyHmac({ secret: CHANGEOVER_DEMO_ECHO_SECRET, signature: String(h["x-changeover-signature"]), timestamp: ts, rawBody: server.seen[0]!.body, nowSec: Number(ts) + 10 })).toBe("valid");
  });

  it("signs the empty body for GET", async () => {
    const { seen } = await run(jsonReply(200, {}), { method: "GET", hmac: { name: "k", value: "s3cret-value-for-test" } });
    const ts = String(seen[0]!.headers["x-changeover-timestamp"]);
    expect(seen[0]!.headers["x-changeover-signature"]).toBe(`v1=${hmacHex("s3cret-value-for-test", ts, "")}`);
  });
});

describe("anti-rebinding and destinations", () => {
  it("resolves once and dials the pinned address even if the name would now resolve elsewhere", async () => {
    let n = 0;
    const flipping = {
      calls: [] as string[],
      async resolve4(host: string) {
        flipping.calls.push(host);
        return n++ === 0 ? [PUBLIC_V4] : ["127.0.0.1"];
      },
      async resolve6() {
        throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
      },
    };
    server = await startServer(jsonReply(200, { ok: true }));
    const calls: CapturedCall[] = [];
    const report = await executeHttpAction(input(), { policy: DEV, resolver: flipping, request: localTransport(server.port, calls) });
    expect(report.status).toBe("ok");
    expect(flipping.calls).toEqual(["api.example.com"]);
    expect(calls[0]!.pinned.plain).toEqual([PUBLIC_V4, 4]);
    expect(calls[0]!.pinned.all).toEqual([{ address: PUBLIC_V4, family: 4 }]);
  });

  it.each([
    ["https://127.0.0.1/x", "E_CONN_ADDRESS", "blocked"],
    ["https://169.254.169.254/latest/meta-data/", "E_CONN_ADDRESS", "blocked"],
    ["https://[::ffff:10.0.0.1]/", "E_CONN_ADDRESS", "blocked"],
    ["http://api.example.com/", "E_CONN_URL", "refused"],
    ["https://api.example.com:8443/", "E_CONN_URL", "refused"],
    ["https://private.example.com/", "E_CONN_ADDRESS", "blocked"],
    ["https://missing.example.com/", "E_CONN_DNS", "error"],
  ])("%s → %s, and nothing is sent", async (url, code, status) => {
    const { report, seen } = await run(jsonReply(200, {}), { url }, DEV, {
      "api.example.com": { v4: [PUBLIC_V4] }, "private.example.com": { v4: ["10.9.8.7"] },
    });
    expect(report).toMatchObject({ status, errorCode: code, httpStatus: null });
    expect(report.agentResult).toMatchObject({ status: "failed" });
    expect(seen).toEqual([]);
  });

  it("production: a non-allowlisted host is blocked before DNS; an allowlisted one goes through", async () => {
    const prod = destinationPolicy({ APP_ENV: "production", APP_URL: "https://app.example.com" });
    const blocked = await run(jsonReply(200, {}), {}, prod);
    expect(blocked.report).toMatchObject({ status: "blocked", errorCode: "E_CONN_HOST_NOT_ALLOWED" });
    expect(blocked.resolver.calls).toEqual([]);
    await server!.close();
    server = null;
    const ok = await run(jsonReply(200, { ok: true }), { url: "https://postman-echo.com/post" }, prod, { "postman-echo.com": { v4: [PUBLIC_V4] } });
    expect(ok.report.status).toBe("ok");
  });
});

describe("response limits", () => {
  it("3xx → E_CONN_REDIRECT, never followed", async () => {
    const { report, seen } = await run((_q, res) => {
      res.writeHead(302, { location: "http://127.0.0.1/admin" });
      res.end();
    });
    expect(report).toMatchObject({ status: "error", errorCode: "E_CONN_REDIRECT" });
    expect(seen).toHaveLength(1);
  });

  it("a gzip response (Content-Encoding) → E_CONN_ENCODING, not decompressed", async () => {
    const { report } = await run((_q, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gzipSync(JSON.stringify({ ok: true })));
    });
    expect(report).toMatchObject({ status: "error", errorCode: "E_CONN_ENCODING" });
    expect(report.raw).toBeNull();
  });

  it("gzip bytes without the header → E_CONN_ENCODING", async () => {
    const { report } = await run((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(gzipSync(JSON.stringify({ ok: true })));
    });
    expect(report.errorCode).toBe("E_CONN_ENCODING");
  });

  it("Content-Length over 8192 → E_CONN_TOO_LARGE", async () => {
    const { report } = await run(jsonReply(200, { pad: "x".repeat(9000) }));
    expect(report).toMatchObject({ status: "error", errorCode: "E_CONN_TOO_LARGE" });
  });

  it("a chunked body that grows past 8192 is aborted mid-stream", async () => {
    const { report } = await run((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("[");
      const tick = setInterval(() => {
        if (res.destroyed || res.writableEnded) return clearInterval(tick);
        res.write(`"${"y".repeat(1000)}",`);
      }, 1);
    });
    expect(report.errorCode).toBe("E_CONN_TOO_LARGE");
    expect(report.resBytes).toBeGreaterThan(8192);
  });

  it("exactly 8192 bytes is accepted", async () => {
    const body = JSON.stringify({ ok: true, pad: "" });
    const padded = JSON.stringify({ ok: true, pad: "z".repeat(8192 - body.length) });
    expect(Buffer.byteLength(padded)).toBe(8192);
    const { report } = await run(jsonReply(200, padded));
    expect(report).toMatchObject({ status: "ok", resBytes: 8192 });
  });

  it("a server that never answers → E_CONN_TIMEOUT at timeoutMs", async () => {
    const t0 = Date.now();
    const { report } = await run(() => { /* never respond */ }, { timeoutMs: 600 });
    expect(report).toMatchObject({ status: "timeout", errorCode: "E_CONN_TIMEOUT" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(report.agentResult).toEqual({ status: "failed", reason: "timeout" });
  });

  it("a slow drip body is cut by the same deadline (it spans the body, not just the headers)", async () => {
    const { report } = await run((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      const tick = setInterval(() => {
        if (res.destroyed || res.writableEnded) return clearInterval(tick);
        res.write(" ");
      }, 100);
    }, { timeoutMs: 600 });
    expect(report.errorCode).toBe("E_CONN_TIMEOUT");
  });

  it("timeoutMs is clamped to 500–5000", async () => {
    const t0 = Date.now();
    const { report } = await run(() => {}, { timeoutMs: 1 });
    expect(report.errorCode).toBe("E_CONN_TIMEOUT");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450);
  });

  it("non-2xx → {status:'failed', http_status} for the agent", async () => {
    const { report } = await run(jsonReply(503, { error: "down" }));
    expect(report).toMatchObject({ status: "error", errorCode: "E_CONN_HTTP", httpStatus: 503 });
    expect(report.agentResult).toEqual({ status: "failed", http_status: 503 });
    expect(report.raw).toBe(JSON.stringify({ error: "down" }));
  });

  it("only JSON or text/plain; HTML → E_CONN_CONTENT_TYPE; text/plain → empty data", async () => {
    const html = await run((_q, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<h1>hi</h1>");
    });
    expect(html.report.errorCode).toBe("E_CONN_CONTENT_TYPE");
    await server!.close();
    server = null;
    const text = await run((_q, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("accepted");
    });
    expect(text.report).toMatchObject({ status: "ok", agentResult: { data: {}, http_status: 200 }, raw: "accepted" });
  });

  it("JSON that does not parse → E_CONN_BAD_RESPONSE; +json types are JSON; 204 → empty data", async () => {
    const bad = await run(jsonReply(200, "{not json"));
    expect(bad.report.errorCode).toBe("E_CONN_BAD_RESPONSE");
    await server!.close();
    server = null;
    const problem = await run((_q, res) => {
      res.writeHead(200, { "content-type": "application/vnd.api+json" });
      res.end(JSON.stringify({ ok: true }));
    });
    expect(problem.report.agentResult).toEqual({ data: { ok: true }, http_status: 200 });
    await server!.close();
    server = null;
    const empty = await run((_q, res) => {
      res.writeHead(204);
      res.end();
    });
    expect(empty.report).toMatchObject({ status: "ok", agentResult: { data: {}, http_status: 204 } });
  });
});

describe("responsePick and redaction", () => {
  it("flattens only strings (≤ 200 chars), finite numbers and booleans; ignores objects, arrays, nulls, prototype keys", async () => {
    const { report } = await run(jsonReply(200, { a: "x".repeat(300), n: 1.5, b: false, o: { k: 1 }, arr: [1], z: null }), {
      responsePick: ["a", "n", "b", "o", "arr", "z", "missing.path", "__proto__", "constructor", "arr.5"],
    });
    const data = (report.agentResult as { data: Record<string, unknown> }).data;
    expect(data).toEqual({ a: "x".repeat(200), n: 1.5, b: false });
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
  });

  it("an upstream that reflects a secret header cannot leak it to the agent, the raw view or the report", async () => {
    const SECRET = "demo-reflected-secret-0123456789";
    const { report } = await run(
      (req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ headers: { authorization: req.headers.authorization }, note: `got ${req.headers.authorization}` }));
      },
      { headers: [{ name: "Authorization", value: `Bearer ${SECRET}`, secretName: "api_key" }], responsePick: ["headers.authorization", "note"] },
    );
    expect(report.status).toBe("ok");
    const dump = JSON.stringify(report);
    expect(dump).not.toContain(SECRET);
    expect((report.agentResult as { data: Record<string, string> }).data["headers.authorization"]).toBe("‹secret:api_key›");
    expect(report.raw).toContain("‹secret:api_key›");
  });
});
