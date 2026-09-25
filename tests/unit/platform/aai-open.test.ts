/**
 * aai-open against local fake AssemblyAI servers ($0, no network): acquire → ledger → connect → report →
 * always close, all through an injected LocalOpenGuard over a temp directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { OpenRefusedError, openStreamingPair, openVoiceAgentNode, withStreaming } from "../../../scripts/lib/aai-open";
import { LocalOpenGuard } from "../../../scripts/lib/local-open-guard";

let stt: WebSocketServer;
let va: WebSocketServer;
let rest: Server;
let sttUrl = "";
let vaUrl = "";
let restBase = "";
let dir = "";
/** What the fake VA socket and the fake token endpoint saw (G1 token-auth open). */
const vaUpgrades: { url: string; headers: IncomingHttpHeaders }[] = [];
const mints: { url: string; auth: string | undefined }[] = [];

beforeAll(async () => {
  process.env.ASSEMBLYAI_API_KEY = "test-key-not-real-0000000000"; // shell value wins over any .env
  dir = mkdtempSync(join(tmpdir(), "baton-aai-open-"));
  stt = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  stt.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "Begin", id: `fake-${Math.random().toString(36).slice(2)}`, expires_at: Math.floor(Date.now() / 1000) + 600 }));
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(String(raw)) as { type?: string };
      if (msg.type === "Terminate") {
        ws.send(JSON.stringify({ type: "Termination", audio_duration_seconds: 1, session_duration_seconds: 2 }));
        ws.close(1000);
      }
    });
  });
  va = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  va.on("connection", (ws, req) => {
    vaUpgrades.push({ url: req.url ?? "", headers: req.headers });
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type?: string };
      if (msg.type === "session.end") {
        ws.send(JSON.stringify({ type: "session.ended", reason: "client" }));
        ws.close(1000);
      }
    });
  });
  rest = createServer((req, res) => {
    mints.push({ url: req.url ?? "", auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ token: "fake-temp-token", expires_in_seconds: 5 }));
  });
  rest.listen(0, "127.0.0.1");
  await Promise.all([
    new Promise((r) => stt.once("listening", r)),
    new Promise((r) => va.once("listening", r)),
    new Promise((r) => rest.once("listening", r)),
  ]);
  sttUrl = `ws://127.0.0.1:${(stt.address() as AddressInfo).port}/v3/ws`;
  vaUrl = `ws://127.0.0.1:${(va.address() as AddressInfo).port}/v1/ws`;
  restBase = `http://127.0.0.1:${(rest.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await Promise.all([new Promise((r) => stt.close(r)), new Promise((r) => va.close(r)), new Promise((r) => rest.close(r))]);
  rmSync(dir, { recursive: true, force: true });
});

describe("aai-open (through the limits authority)", () => {
  it("withStreaming acquires, reports opened/closed and settles billed seconds", async () => {
    const guard = new LocalOpenGuard({ dir: join(dir, "a"), sttOpensPerMin: 4, vaMax: 1, dailyCapUsd: 5 });
    const term = await withStreaming(
      { authority: guard, params: { sample_rate: 16000 }, connect: { baseUrl: sttUrl }, maxDurationMs: 60_000, maxWaitMs: 0 },
      async (h) => {
        expect(h.session.begin.id).toMatch(/^fake-/);
        return null;
      },
    );
    expect(term).toBeNull();
    const s = await guard.snapshot();
    expect(s.sttOpens.reduce((a, o) => a + o.n, 0)).toBe(1);
    expect(s.reports.map((r) => `${r.kind}:${r.event}`)).toEqual(["stt:opened", "stt:closed"]);
    expect(s.reports[1]?.billedSeconds).toBe(2);
    expect(s.ledger[0]).toMatchObject({ provider: "aai_stt", status: "settled" });
    expect(s.ledger[0]?.actualUsd).toBeCloseTo((2 * 0.45) / 3600, 8);
  });

  it("openStreamingPair takes one n=2 grant and closes both sessions", async () => {
    const guard = new LocalOpenGuard({ dir: join(dir, "b"), sttOpensPerMin: 4, vaMax: 1, dailyCapUsd: 5 });
    const pair = await openStreamingPair({ authority: guard, rep: { sample_rate: 8000 }, customer: { sample_rate: 8000 }, connect: { baseUrl: sttUrl }, maxWaitMs: 0 });
    // G0: the ids come from SlotResult.sessionIds ([rep, customer]), not from a suffixed grant id.
    expect(pair.rep.sessionId).toMatch(/^lg_ss_/);
    expect(pair.customer.sessionId).toMatch(/^lg_ss_/);
    expect(pair.rep.sessionId).not.toBe(pair.customer.sessionId);
    await pair.close();
    const s = await guard.snapshot();
    expect(s.sttOpens).toHaveLength(1);
    expect(s.sttOpens[0]?.n).toBe(2);
    expect(s.reports.filter((r) => r.event === "closed")).toHaveLength(2);
    expect(new Set(s.reports.map((r) => r.sessionId))).toEqual(new Set([pair.rep.sessionId, pair.customer.sessionId]));
  });

  it("refuses a 5th open in the window instead of connecting", async () => {
    const guard = new LocalOpenGuard({ dir: join(dir, "c"), sttOpensPerMin: 4, vaMax: 1, dailyCapUsd: 5 });
    for (let i = 0; i < 2; i++) {
      const p = await openStreamingPair({ authority: guard, rep: {}, customer: {}, connect: { baseUrl: sttUrl }, maxWaitMs: 0 });
      await p.close();
    }
    await expect(withStreaming({ authority: guard, params: {}, connect: { baseUrl: sttUrl }, maxWaitMs: 0 }, async () => null)).rejects.toBeInstanceOf(
      OpenRefusedError,
    );
  });

  it("openVoiceAgentNode holds the single VA slot until close, then releases and settles", async () => {
    const guard = new LocalOpenGuard({ dir: join(dir, "d"), sttOpensPerMin: 4, vaMax: 1, dailyCapUsd: 5 });
    const h = await openVoiceAgentNode({ authority: guard, capMs: 30_000, connect: { url: vaUrl } });
    await expect(openVoiceAgentNode({ authority: guard, capMs: 30_000, connect: { url: vaUrl } })).rejects.toMatchObject({ code: "E_VA_CAPACITY" });
    await h.close();
    const s = await guard.snapshot();
    expect(s.va).toHaveLength(0);
    expect(s.reports.map((r) => `${r.kind}:${r.event}`)).toEqual(["va:opened", "va:closed"]);
    expect(s.ledger[0]).toMatchObject({ provider: "aai_va", status: "settled" });
    // The slot is free again.
    const again = await openVoiceAgentNode({ authority: guard, capMs: 30_000, connect: { url: vaUrl } });
    await again.close();
  });

  it("openVoiceAgentNode defaults to the API-key header (no token in the URL)", async () => {
    const guard = new LocalOpenGuard({ dir: join(dir, "e"), sttOpensPerMin: 4, vaMax: 1, dailyCapUsd: 5 });
    vaUpgrades.length = 0;
    await (await openVoiceAgentNode({ authority: guard, capMs: 30_000, connect: { url: vaUrl } })).close();
    expect(vaUpgrades).toHaveLength(1);
    expect(vaUpgrades[0]?.headers.authorization).toBe(process.env.ASSEMBLYAI_API_KEY);
    expect(vaUpgrades[0]?.url).not.toContain("token=");
  });

  it("auth:token mints a temp token and connects with ?token= and no Authorization header (T-D1-3 part B)", async () => {
    const guard = new LocalOpenGuard({ dir: join(dir, "f"), sttOpensPerMin: 4, vaMax: 1, dailyCapUsd: 5 });
    vaUpgrades.length = 0;
    mints.length = 0;
    const h = await openVoiceAgentNode({
      authority: guard,
      capMs: 30_000,
      connect: { url: vaUrl },
      auth: { kind: "token", expiresInSeconds: 5, connectDelayMs: 10, restBase },
    });
    await h.close();
    expect(mints).toHaveLength(1);
    expect(mints[0]?.url).toMatch(/^\/v1\/token\?/);
    expect(new URLSearchParams(mints[0]?.url.split("?")[1]).get("expires_in_seconds")).toBe("5");
    expect(new URLSearchParams(mints[0]?.url.split("?")[1]).get("max_session_duration_seconds")).toBe("60");
    expect(mints[0]?.auth).toBe(process.env.ASSEMBLYAI_API_KEY); // the mint uses the key; the socket does not
    expect(vaUpgrades).toHaveLength(1);
    expect(vaUpgrades[0]?.url).toContain("token=fake-temp-token");
    expect(vaUpgrades[0]?.headers.authorization).toBeUndefined();
    const s = await guard.snapshot();
    expect(s.reports.map((r) => `${r.kind}:${r.event}`)).toEqual(["va:opened", "va:closed"]);
    expect(s.ledger[0]).toMatchObject({ provider: "aai_va", status: "settled" });
    expect(s.va).toHaveLength(0);
  });
});
