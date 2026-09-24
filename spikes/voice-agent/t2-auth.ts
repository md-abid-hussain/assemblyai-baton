/**
 * T2 / C4 / C23 - Voice Agent auth: token endpoint header styles, `product` param, ?token= connect,
 * token single-use, expired redemption window, and server-side Authorization-header connect.
 *
 *   npx tsx voice-agent/t2-auth.ts
 * Log: spikes/out/va-t2-auth.jsonl
 */
import { ASSEMBLYAI_API_KEY } from "../lib/env.ts";
import { loggedFetch } from "../lib/log.ts";
import { UpgradeRejectedError, VA_REST_BASE, errorCode, type VoiceAgentSession } from "./client.ts";
import { brief, open, sleep, vaLogger } from "./harness.ts";

const log = vaLogger("t2-auth");
const results: Record<string, unknown> = {};

const MIN_SESSION = { system_prompt: "You are a test agent. Say nothing unless asked.", output: { voice: "alba" } };

async function tokenReq(label: string, auth: "raw" | "bearer" | "none" | "bad", params: Record<string, string>) {
  const q = new URLSearchParams(params);
  const headers: Record<string, string> = {};
  if (auth === "raw") headers.Authorization = ASSEMBLYAI_API_KEY;
  if (auth === "bearer") headers.Authorization = `Bearer ${ASSEMBLYAI_API_KEY}`;
  if (auth === "bad") headers.Authorization = "not-a-real-key-000000000000";
  const r = await loggedFetch<{ token?: string; expires_in_seconds?: number }>(log, `${VA_REST_BASE}/token?${q}`, { headers, label });
  const summary = {
    status: r.status,
    ms: r.ms,
    bodyKeys: r.json && typeof r.json === "object" ? Object.keys(r.json) : undefined,
    body: r.json && typeof r.json === "object" ? { ...r.json, ...(r.json.token ? { token: `<${r.json.token.length} chars>` } : {}) } : r.text.slice(0, 300),
  };
  results[label] = summary;
  console.log(label, brief(summary, 400));
  return r.json?.token;
}

/** Connect, optionally wait for unsolicited frames, send a minimal session.update, wait for ready, end. */
async function tryConnect(label: string, o: { token?: string; apiKey?: string; authStyle?: "raw" | "bearer" }, waitBeforeUpdateMs = 0) {
  const t0 = log.elapsed();
  let s: VoiceAgentSession | undefined;
  const out: Record<string, unknown> = {};
  try {
    s = await open(log, o);
    out.openMs = Math.round(log.elapsed() - t0);
    if (waitBeforeUpdateMs) {
      const before = s.timeline.length;
      await sleep(waitBeforeUpdateMs);
      out.unsolicitedBeforeUpdate = s.timeline.slice(before).map((e) => e.type);
    }
    const tU = log.elapsed();
    try {
      const ready = await s.start(MIN_SESSION, 15000);
      out.readyMs = Math.round(log.elapsed() - tU);
      out.session_id = ready.session_id;
      out.readyKeys = Object.keys(ready);
      if (ready.expires_at) out.expiresInSecFromNow = Math.round(ready.expires_at - Date.now() / 1000);
      out.status = "ready";
    } catch (e) {
      out.status = "no-ready";
      out.error = e instanceof Error ? e.message : String(e);
      const err = (e as { event?: { code?: string; error_code?: string } }).event;
      if (err) out.errorEvent = err;
      if (err) out.errorCodeNormalised = errorCode(err);
    }
    const ended = await s.end(5000);
    out.sessionEnded = ended ?? null;
    out.close = s.closed ?? null;
  } catch (e) {
    out.status = "connect-failed";
    if (e instanceof UpgradeRejectedError) {
      out.upgradeStatus = e.status;
      out.upgradeBody = e.body.slice(0, 500);
    } else out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    if (s?.closed) out.close = s.closed;
  }
  log.note(`connect result ${label}`, out);
  results[label] = out;
  console.log(label, brief(out, 600));
  return out;
}

async function main() {
  // --- token endpoint variants -----------------------------------------------------------------
  const base = { expires_in_seconds: "60", max_session_duration_seconds: "180" };
  const tokRaw = await tokenReq("token raw", "raw", base);
  const tokBearer = await tokenReq("token bearer", "bearer", base);
  const tokRawProduct = await tokenReq("token raw +product", "raw", { ...base, product: "voice_agent" });
  const tokBearerProduct = await tokenReq("token bearer +product", "bearer", { ...base, product: "voice_agent" });
  await tokenReq("token no-auth", "none", base);
  await tokenReq("token bad key", "bad", base);
  await tokenReq("token max_session 30 (below min 60)", "raw", { expires_in_seconds: "60", max_session_duration_seconds: "30" });
  await tokenReq("token expires 0 (below min 1)", "raw", { expires_in_seconds: "0", max_session_duration_seconds: "180" });
  await tokenReq("token no expires_in_seconds", "raw", { max_session_duration_seconds: "180" });
  const tokShort = await tokenReq("token expires 1s", "raw", { expires_in_seconds: "1", max_session_duration_seconds: "60" });

  // --- WS connects -------------------------------------------------------------------------------
  if (tokRaw) await tryConnect("ws ?token (raw-minted), wait 1.5s before update", { token: tokRaw }, 1500);
  if (tokRaw) await tryConnect("ws ?token REUSED (single-use check)", { token: tokRaw });
  if (tokBearerProduct) await tryConnect("ws ?token (bearer+product minted)", { token: tokBearerProduct });
  if (tokShort) {
    await sleep(3000);
    await tryConnect("ws ?token after redemption window expired (1s token, 3s later)", { token: tokShort });
  }
  await tryConnect("ws Authorization raw key", { apiKey: ASSEMBLYAI_API_KEY, authStyle: "raw" });
  await tryConnect("ws Authorization Bearer key", { apiKey: ASSEMBLYAI_API_KEY, authStyle: "bearer" });
  await tryConnect("ws Authorization bad key", { apiKey: "not-a-real-key-000000000000", authStyle: "raw" });
  await tryConnect("ws no auth at all", {});
  void tokBearer;
  void tokRawProduct;

  log.result("PASS", { results });
  log.close();
  console.log("done ->", log.path);
}

main().catch((e) => {
  log.error(e);
  log.close();
  console.error(e);
  process.exit(1);
});
