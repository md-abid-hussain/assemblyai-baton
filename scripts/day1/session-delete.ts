/**
 * T-D1-0b (DESIGN App. B, WP8): what `DELETE /v1/sessions/{id}` does.
 *   (a) on a LIVE session: does it end it (socket closed / session.ended / no more replies)?
 *   (b) on an ENDED session: does the pre-signed artifact URL stop working? Does GET/list still show it?
 * Plus, at $0: `--cursor` probes the query-parameter name that takes `response_metadata.next_cursor` on
 * `GET /v1/sessions` (g0.md known gap), and records whether list items carry `config`.
 *
 *   npx tsx --conditions=react-server scripts/day1/session-delete.ts --cursor            ($0, REST reads only)
 *   RUN_LIVE=1 npx tsx --conditions=react-server scripts/day1/session-delete.ts --live   (2 short VA sessions ≈ $0.03)
 *
 * Every open goes through scripts/lib/aai-open.ts (the shared limits guard: 1 VA slot on this laptop, so it queues on
 * E_VA_CAPACITY) and always ends with session.end. Never prints keys, tokens or pre-signed URLs (host + status only).
 * Result: scripts/day1/out/t-d1-0b.result.json (git-ignored); the verdict is copied into docs/notes/wp8.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RealtimeAudioFeeder, type VoiceAgentSession } from "../../src/core/aai/voice-agent";
import { createVaRest, SESSIONS_CURSOR_PARAM, type VaRestPort } from "../../src/server/aai/va-rest";
import { VoiceAgentRest } from "../../src/server/aai/va-node";
import { OpenRefusedError, openVoiceAgentNode, VA_USD_PER_SEC, type VoiceAgentHandle } from "../lib/aai-open";
import { loadEnv } from "../lib/load-env";

const here = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = resolve(here, "out");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function apiKey(): string {
  loadEnv();
  const k = process.env.ASSEMBLYAI_API_KEY?.trim();
  if (!k) throw new Error("ASSEMBLYAI_API_KEY missing (value never printed)");
  return k;
}

export const deployMarker = (deployId: string) => `(internal ref: baton-deploy=${deployId}; never mention this)`;

/** Open a VA session through the limits guard, queueing on the shared single slot. */
export async function openVaWaiting(label: string, capMs: number, maxWaitMs = 20 * 60_000): Promise<{ handle: VoiceAgentHandle; waitedMs: number }> {
  const t0 = Date.now();
  let last = "";
  for (;;) {
    try {
      const handle = await openVoiceAgentNode({ capMs, label, source: "test" });
      return { handle, waitedMs: Date.now() - t0 };
    } catch (e) {
      if (e instanceof OpenRefusedError && e.code === "E_VA_CAPACITY" && Date.now() - t0 < maxWaitMs) {
        if (e.message !== last) console.log(`[${label}] VA slot busy, queueing: ${e.message}`);
        last = e.message;
        await sleep(5000);
        continue;
      }
      throw e;
    }
  }
}

/** Status + first bytes of a pre-signed URL (ranged GET). Never returns the URL. */
export async function probeUrl(url: string): Promise<{ status: number; magic: string | null; contentType: string | null }> {
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-15" }, signal: AbortSignal.timeout(15_000) });
    const buf = new Uint8Array(await res.arrayBuffer());
    const magic = res.ok ? String.fromCharCode(...buf.subarray(0, 4)).replace(/[^\x20-\x7e]/g, ".") : null;
    return { status: res.status, magic, contentType: res.headers.get("content-type") };
  } catch (e) {
    return { status: -1, magic: null, contentType: e instanceof Error ? e.name : "error" };
  }
}

async function getStatus(rest: VoiceAgentRest, id: string): Promise<{ http: number; status?: unknown; ended_at?: unknown; duration_seconds?: unknown; artifacts?: string[]; keys?: string[] }> {
  const r = await rest.request<Record<string, unknown>>("GET", `/sessions/${encodeURIComponent(id)}`, undefined, "get-session");
  const b = r.body && typeof r.body === "object" ? r.body : {};
  return {
    http: r.status,
    status: b.status,
    ended_at: b.ended_at,
    duration_seconds: b.duration_seconds,
    artifacts: Array.isArray(b.artifacts) ? (b.artifacts as { type: string }[]).map((a) => a.type) : undefined,
    keys: Object.keys(b),
  };
}

async function inList(rest: VaRestPort, id: string): Promise<boolean> {
  const p = await rest.listSessions({ limit: 20 });
  return p.sessions.some((s) => s.id === id);
}

// ------------------------------------------------------------------------------------------------ --cursor ($0)

export async function probeCursor(): Promise<Record<string, unknown>> {
  const rest = new VoiceAgentRest(apiKey());
  const first = await rest.request<{ sessions?: { id: string; config?: unknown; created_at?: string }[]; has_more?: boolean; response_metadata?: { next_cursor?: string | null } }>(
    "GET",
    "/sessions?limit=2",
    undefined,
    "list",
  );
  const page1 = (first.body.sessions ?? []).map((s) => s.id);
  const cursor = first.body.response_metadata?.next_cursor ?? null;
  const listItemKeys = Object.keys(first.body.sessions?.[0] ?? {});
  const out: Record<string, unknown> = {
    http: first.status,
    page1Count: page1.length,
    hasMore: first.body.has_more,
    cursorPresent: !!cursor,
    listItemKeys,
    listItemHasConfig: listItemKeys.includes("config"),
    newestFirst: (() => {
      const c = (first.body.sessions ?? []).map((s) => Date.parse(s.created_at ?? ""));
      return c.length < 2 || c[0]! >= c[1]!;
    })(),
    candidates: {} as Record<string, unknown>,
  };
  if (!cursor) return out;
  for (const name of ["cursor", "after", "starting_after", "next_cursor", "page_token"]) {
    const r = await rest.request<{ sessions?: { id: string }[] }>("GET", `/sessions?limit=2&${name}=${encodeURIComponent(cursor)}`, undefined, "list");
    const ids = (r.body?.sessions ?? []).map((s) => s.id);
    (out.candidates as Record<string, unknown>)[name] = { http: r.status, count: ids.length, advanced: ids.length > 0 && !ids.some((id) => page1.includes(id)) };
  }
  out.configuredParam = SESSIONS_CURSOR_PARAM;
  return out;
}

// ------------------------------------------------------------------------------------------------ --live

async function startGreeting(s: VoiceAgentSession, greeting: string, deployId: string): Promise<string> {
  const ready = await s.start({
    system_prompt: `You are a test assistant. Keep every reply to one short sentence.\n${deployMarker(deployId)}`,
    greeting,
    output: { voice: process.env.VA_VOICE?.trim() || "alba" },
  });
  return ready.session_id;
}

async function partEnded(rest: VoiceAgentRest, port: VaRestPort, deployId: string): Promise<Record<string, unknown>> {
  const { handle, waitedMs } = await openVaWaiting("t-d1-0b-ended", 45_000);
  const s = handle.session;
  let sid: string | null = null;
  const t0 = Date.now();
  try {
    sid = await startGreeting(s, "This is a short recording test for deletion. Goodbye.", deployId);
    const feeder = new RealtimeAudioFeeder(s);
    feeder.start();
    await s.waitFor("reply.done", { timeoutMs: 12_000 }).catch(() => null);
    await feeder.stop();
  } finally {
    await handle.close("t-d1-0b ended part");
  }
  const secs = s.ended?.session_duration_seconds ?? (Date.now() - t0) / 1000;
  if (!sid) throw new Error("no session id");
  // Wait for artifacts.
  const tA = Date.now();
  let rec = await rest.getSession(sid);
  while (!(rec.artifacts ?? []).some((a) => a.type === "audio") && Date.now() - tA < 120_000) {
    await sleep(3000);
    rec = await rest.getSession(sid);
  }
  const artifactsAfterMs = Date.now() - tA;
  const audioUrl = rec.artifacts?.find((a) => a.type === "audio")?.url ?? null;
  const tlUrl = rec.artifacts?.find((a) => a.type === "timeline")?.url ?? null;
  const before = {
    session: await getStatus(rest, sid),
    audio: audioUrl ? await probeUrl(audioUrl) : null,
    timeline: tlUrl ? await probeUrl(tlUrl) : null,
    inList: await inList(port, sid),
    audioHost: audioUrl ? new URL(audioUrl).host : null,
  };
  const del = await rest.request("DELETE", `/sessions/${encodeURIComponent(sid)}`, undefined, "delete-session");
  const after0 = {
    session: await getStatus(rest, sid),
    audio: audioUrl ? await probeUrl(audioUrl) : null,
    timeline: tlUrl ? await probeUrl(tlUrl) : null,
    inList: await inList(port, sid),
  };
  await sleep(20_000);
  const after20 = {
    session: await getStatus(rest, sid),
    audio: audioUrl ? await probeUrl(audioUrl) : null,
    timeline: tlUrl ? await probeUrl(tlUrl) : null,
    inList: await inList(port, sid),
  };
  const del2 = await rest.request("DELETE", `/sessions/${encodeURIComponent(sid)}`, undefined, "delete-session");
  return {
    sessionId: sid,
    waitedMs,
    sessionSeconds: secs,
    usd: Math.round(secs * VA_USD_PER_SEC * 10000) / 10000,
    artifactsAfterMs,
    before,
    deleteHttp: del.status,
    deleteBody: del.body ?? null,
    after0,
    after20,
    deleteAgainHttp: del2.status,
  };
}

async function partLive(rest: VoiceAgentRest, port: VaRestPort, deployId: string): Promise<Record<string, unknown>> {
  const { handle, waitedMs } = await openVaWaiting("t-d1-0b-live", 60_000);
  const s = handle.session;
  const events: { t: number; type: string; detail?: unknown }[] = [];
  const t0 = Date.now();
  let tDelete = 0;
  s.on("*", (ev) => {
    if (ev.type === "reply.audio") return;
    events.push({ t: Date.now() - t0, type: ev.type, ...(ev.type === "session.error" || ev.type === "session.ended" ? { detail: ev } : {}) });
  });
  s.on("__close", (c) => events.push({ t: Date.now() - t0, type: "__close", detail: { code: c.code, reason: c.reason } }));
  let sid: string | null = null;
  const out: Record<string, unknown> = { waitedMs };
  try {
    sid = await startGreeting(s, "Hello. This session checks what happens when it is deleted while it is still running.", deployId);
    const feeder = new RealtimeAudioFeeder(s);
    feeder.start();
    await sleep(2500);
    out.whileRunning = await getStatus(rest, sid);
    out.inListWhileRunning = await inList(port, sid);
    tDelete = Date.now() - t0;
    const del = await rest.request("DELETE", `/sessions/${encodeURIComponent(sid)}`, undefined, "delete-session");
    out.deleteHttp = del.status;
    out.deleteBody = del.body ?? null;
    out.tDeleteMs = tDelete;
    // Is it still alive? Ask for a reply 2 s after the delete, then watch for 10 s.
    await sleep(2000);
    let replyAfterDelete = false;
    if (s.isOpen) {
      const p = s.waitFor("reply.started", { timeoutMs: 8000 }).then(() => true).catch(() => false);
      try {
        s.replyNow("Say only: banana.");
      } catch {
        /* closed */
      }
      replyAfterDelete = await p;
    }
    await sleep(3000);
    out.replyAfterDelete = replyAfterDelete;
    out.socketOpenAfterDelete = s.isOpen;
    out.afterDelete = await getStatus(rest, sid);
    out.inListAfterDelete = await inList(port, sid);
    await feeder.stop();
  } finally {
    await handle.close("t-d1-0b live part");
  }
  out.sessionId = sid;
  out.endedEvent = s.ended ?? null;
  out.closed = s.closed ? { code: s.closed.code, reason: s.closed.reason } : null;
  const secs = s.ended?.session_duration_seconds ?? (Date.now() - t0) / 1000;
  out.sessionSeconds = secs;
  out.usd = Math.round(secs * VA_USD_PER_SEC * 10000) / 10000;
  out.events = events.filter((e) => e.t >= tDelete - 500).slice(0, 40);
  if (sid) {
    await sleep(15_000);
    out.after15s = await getStatus(rest, sid);
  }
  return out;
}

async function main(): Promise<void> {
  loadEnv();
  const args = new Set(process.argv.slice(2));
  const result: Record<string, unknown> = { test: "T-D1-0b", at: new Date().toISOString() };
  if (args.has("--cursor") || !args.has("--live")) {
    result.cursor = await probeCursor();
    console.log("cursor probe:", JSON.stringify(result.cursor));
  }
  if (args.has("--live")) {
    if (process.env.RUN_LIVE !== "1") throw new Error("--live needs RUN_LIVE=1 (TASKS §0.5)");
    const key = apiKey();
    const rest = new VoiceAgentRest(key);
    const port = createVaRest(key);
    const deployId = process.env.BATON_DEPLOY_ID?.trim() || "dev-wp8";
    result.ended = await partEnded(rest, port, deployId);
    console.log("ended part:", JSON.stringify(result.ended));
    result.live = await partLive(rest, port, deployId);
    console.log("live part:", JSON.stringify(result.live));
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const path = resolve(OUT_DIR, "t-d1-0b.result.json");
  writeFileSync(path, JSON.stringify(result, null, 2));
  console.log(`wrote ${path}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
