/**
 * WP16 acceptance 4: HMAC verifies with the documented algorithm; `/api/connectors/echo` accepts unsigned and valid
 * requests and rejects a tampered signature or a stale timestamp (401 E_ECHO_SIGNATURE). Also the full loop:
 * `executeHttpAction` → the echo handler (served locally) → `signature:"valid"`.
 */
import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { CHANGEOVER_DEMO_ECHO_SECRET, EchoResponseSchema } from "@/core/contracts/v2/api";
import { handleEcho } from "@/server/connectors/echo";
import { hmacHex, signatureHeader, verifyHmac } from "@/server/connectors/hmac";
import { executeHttpAction } from "@/server/connectors/http";
import { localTransport, PUBLIC_V4, startServer, tableResolver, type CapturedCall, type LocalServer } from "./helpers";

const NOW = 1_790_000_000;

describe("HMAC (documented algorithm)", () => {
  it("is hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`), prefixed v1=", () => {
    const body = '{"tool":"t","args":{}}';
    const expected = createHmac("sha256", "k3y").update(`${NOW}.${body}`).digest("hex");
    expect(hmacHex("k3y", NOW, body)).toBe(expected);
    expect(signatureHeader("k3y", NOW, body)).toBe(`v1=${expected}`);
    // a fixed vector, so a change of algorithm cannot pass silently
    expect(hmacHex(CHANGEOVER_DEMO_ECHO_SECRET, 1700000000, "{}")).toBe(
      createHmac("sha256", "changeover-demo-echo-not-secret").update("1700000000.{}").digest("hex"),
    );
  });

  it("verifies valid, tampered, stale, malformed and absent", () => {
    const body = "payload";
    const sig = signatureHeader("s", NOW, body);
    const v = (o: Partial<Parameters<typeof verifyHmac>[0]>) =>
      verifyHmac({ secret: "s", signature: sig, timestamp: String(NOW), rawBody: body, nowSec: NOW, ...o });
    expect(v({})).toBe("valid");
    expect(v({ nowSec: NOW + 300 })).toBe("valid");
    expect(v({ nowSec: NOW - 300 })).toBe("valid");
    expect(v({ nowSec: NOW + 301 })).toBe("stale");
    expect(v({ nowSec: NOW - 301 })).toBe("stale");
    expect(v({ rawBody: "payload!" })).toBe("tampered");
    expect(v({ secret: "other" })).toBe("tampered");
    expect(v({ signature: sig.replace(/.$/, (c) => (c === "0" ? "1" : "0")) })).toBe("tampered");
    expect(v({ signature: "v0=" + sig.slice(3) })).toBe("tampered");
    expect(v({ signature: `v1=deadbeef, ${sig}` })).toBe("valid");
    expect(v({ timestamp: null })).toBe("malformed");
    expect(v({ signature: null })).toBe("malformed");
    expect(v({ timestamp: "12.5" })).toBe("malformed");
    expect(v({ signature: null, timestamp: null })).toBe("absent");
  });
});

function echoRequest(o: { method?: string; body?: string; headers?: Record<string, string>; query?: string }): Request {
  return new Request(`https://app.example.com/api/connectors/echo${o.query ?? ""}`, {
    method: o.method ?? "POST",
    headers: { "content-type": "application/json", ...o.headers },
    ...(o.body !== undefined ? { body: o.body } : {}),
  });
}

describe("handleEcho", () => {
  const body = JSON.stringify({ tool: "check_deposit", args: { amount: 120 } });
  const signed = (ts: number, b = body) => ({
    "x-changeover-timestamp": String(ts),
    "x-changeover-signature": signatureHeader(CHANGEOVER_DEMO_ECHO_SECRET, ts, b),
  });

  it("echoes an unsigned POST with signature:'absent'", async () => {
    const res = await handleEcho(echoRequest({ body }), NOW * 1000);
    expect(res.status).toBe(200);
    const j = EchoResponseSchema.parse(await res.json());
    expect(j).toMatchObject({ ok: true, signature: "absent", method: "POST", body: JSON.parse(body) });
    expect(j.receivedAt).toBe(new Date(NOW * 1000).toISOString());
  });

  it("verifies a signed POST with the demo secret", async () => {
    const res = await handleEcho(echoRequest({ body, headers: signed(NOW) }), NOW * 1000);
    expect(res.status).toBe(200);
    expect((await res.json()).signature).toBe("valid");
  });

  it("rejects a tampered body, a wrong-secret signature and a stale timestamp with 401 E_ECHO_SIGNATURE", async () => {
    const cases: Record<string, string>[] = [
      signed(NOW, body.replace("120", "1")),
      { "x-changeover-timestamp": String(NOW), "x-changeover-signature": signatureHeader("not-the-demo-secret", NOW, body) },
      signed(NOW - 301),
      signed(NOW + 301),
      { "x-changeover-signature": signatureHeader(CHANGEOVER_DEMO_ECHO_SECRET, NOW, body) },
    ];
    for (const headers of cases) {
      const res = await handleEcho(echoRequest({ body, headers }), NOW * 1000);
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("E_ECHO_SIGNATURE");
    }
  });

  it("GET: echoes the query, signs the empty body", async () => {
    const res = await handleEcho(echoRequest({ method: "GET", query: "?q=a+b&n=2", headers: signed(NOW, "") }), NOW * 1000);
    const j = await res.json();
    expect(j).toMatchObject({ signature: "valid", method: "GET", query: { q: "a b", n: "2" }, body: null });
  });

  it("redacts credential headers and leaves out proxy headers", async () => {
    const res = await handleEcho(echoRequest({
      body,
      headers: {
        authorization: "Bearer real-looking-token-123", cookie: "bvid=abc", "x-api-key": "k-123456789", "x-forwarded-for": "1.2.3.4",
        "x-custom": "visible",
      },
    }), NOW * 1000);
    const j = await res.json();
    expect(j.headers["x-custom"]).toBe("visible");
    expect(j.headers.authorization).toBe("‹redacted›");
    expect(j.headers.cookie).toBe("‹redacted›");
    expect(j.headers["x-api-key"]).toBe("‹redacted›");
    expect(j.headers["x-forwarded-for"]).toBeUndefined();
    expect(JSON.stringify(j)).not.toContain("real-looking-token-123");
  });

  it("refuses bodies over 8 KiB (400) and other methods", async () => {
    expect((await handleEcho(echoRequest({ body: "x".repeat(9000) }), NOW * 1000)).status).toBe(400);
    expect((await handleEcho(new Request("https://a.example/api/connectors/echo", { method: "PUT", body: "{}" }), NOW * 1000)).status).toBe(400);
  });
});

describe("executeHttpAction → echo (the built-in demo target)", () => {
  let server: LocalServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("a signed call to the echo comes back signature:'valid' and picks under data", async () => {
    server = await startServer(async (req, res, raw) => {
      const r = await handleEcho(new Request(`https://app.example.com${req.url}`, {
        method: req.method, headers: req.headers as Record<string, string>, ...(req.method === "POST" ? { body: raw } : {}),
      }));
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
      res.end(await r.text());
    });
    const calls: CapturedCall[] = [];
    const report = await executeHttpAction({
      url: "https://app.example.com/api/connectors/echo", method: "POST", toolName: "send_quote", args: { amount: 120 },
      run: { relay: "dental-deposit", version: 1, case: null, mode: "console" }, headers: [],
      hmac: { name: "echo_demo", value: CHANGEOVER_DEMO_ECHO_SECRET }, timeoutMs: 2000,
      responsePick: ["signature", "body.args.amount", "method"],
    }, { policy: { enforceAllowlist: true, hosts: ["app.example.com"] }, resolver: tableResolver({ "app.example.com": { v4: [PUBLIC_V4] } }), request: localTransport(server.port, calls) });
    expect(report.status).toBe("ok");
    expect(report.agentResult).toEqual({ data: { signature: "valid", "body.args.amount": 120, method: "POST" }, http_status: 200 });
  });
});
