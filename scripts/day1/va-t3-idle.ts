/**
 * T-D1-3: idle WebSocket before the first session.update (DESIGN App. B; the "WS pre-open" question). WP5b.
 *
 * Part A (runs now): open the socket (API-key header through aai-open), send NOTHING for IDLE_MS (default 12 s),
 *   then send the exact first update (confirm fixture). Pass: session.ready after the idle; record whether the
 *   server closed the idle socket, and how session_duration_seconds counts the idle time (billing).
 * Part B (`--auth token`, WP12·0): the browser flow. aai-open mints a temp token (`--token-ttl-s`, default 5 s),
 *   connects with `?token=` right away, idles `--idle-ms` (8 s) so the token EXPIRES during the idle, then sends the
 *   first update. Pass: session.ready (auth is checked at the upgrade only) → the product's 10 s VA token window
 *   stays. Fail (unauthorized / close 1008 after the idle) → mint with 20–30 s.
 *
 *   RUN_LIVE=1 npx tsx --conditions=react-server scripts/day1/va-t3-idle.ts [--idle-ms 12000]
 *   RUN_LIVE=1 npx tsx --conditions=react-server scripts/day1/va-t3-idle.ts --auth token --idle-ms 8000 [--token-ttl-s 5]
 */
import { SessionError, type InlineSessionConfig } from "../../src/core/aai/voice-agent";
import { closeVa, openVaQueued, readFixture, requireLive, sleep, writeResult } from "./va-lib";

async function main(): Promise<void> {
  requireLive();
  const i = process.argv.indexOf("--idle-ms");
  const idleMs = i > 0 ? Number(process.argv[i + 1]) : 12_000;
  const a = process.argv.indexOf("--auth");
  const partB = a > 0 && process.argv[a + 1] === "token";
  const t = process.argv.indexOf("--token-ttl-s");
  const tokenTtlS = t > 0 ? Number(process.argv[t + 1]) : 5;
  const fx = readFixture("first-update-confirm.json");
  const out: Record<string, unknown> = { idleMs, auth: partB ? "token" : "header", ...(partB ? { tokenTtlS } : {}) };
  const tMint = performance.now();
  const v = await openVaQueued({
    name: partB ? "t-d1-3b-token-idle" : "t-d1-3-idle",
    capMs: 60_000,
    ...(partB ? { auth: { kind: "token" as const, expiresInSeconds: tokenTtlS } } : {}),
  });
  if (partB) out.openMs = Math.round(performance.now() - tMint); // slot wait + mint + connect
  const tOpen = performance.now();
  try {
    await sleep(idleMs);
    out.closedDuringIdle = v.session.closed ?? null;
    out.eventsDuringIdle = v.session.timeline.map((e) => e.type);
    if (!v.session.closed) {
      const t0 = performance.now();
      try {
        const ready = await v.session.start(fx.session as InlineSessionConfig, 10_000);
        out.ready = true;
        out.readyMs = Math.round(performance.now() - t0);
        out.sessionId = ready.session_id;
      } catch (e) {
        out.ready = false;
        out.error = e instanceof SessionError ? { code: e.code, message: e.event.message } : String(e);
      }
      await sleep(1500);
    }
  } finally {
    const c = await closeVa(v);
    out.wallSecondsSinceOpen = Math.round((performance.now() - tOpen) / 100) / 10;
    out.sessionSeconds = c.sessionSeconds;
    out.usd = c.usd;
  }
  if (partB) {
    // The token is minted before the connect and the idle starts after it, so idle > TTL guarantees it expired.
    out.tokenExpiredBeforeFirstUpdate = idleMs > tokenTtlS * 1000;
    out.verdictPartB = out.ready === true && out.tokenExpiredBeforeFirstUpdate === true ? "PASS" : out.ready === true ? "INCONCLUSIVE" : "FAIL";
  } else {
    out.verdictPartA = out.ready === true ? "PASS" : "FAIL";
  }
  const path = writeResult(partB ? "t-d1-3b" : "t-d1-3", out);
  console.log(JSON.stringify(out, null, 1));
  console.log(path);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
