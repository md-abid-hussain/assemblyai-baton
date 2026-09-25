/**
 * T-D1-3: idle WebSocket before the first session.update (DESIGN App. B; the "WS pre-open" question). WP5b.
 *
 * Part A (runs now): open the socket (API-key header through aai-open), send NOTHING for IDLE_MS (default 12 s),
 *   then send the exact first update (confirm fixture). Pass: session.ready after the idle; record whether the
 *   server closed the idle socket, and how session_duration_seconds counts the idle time (billing).
 * Part B (needs a token-auth open in scripts/lib/aai-open.ts; see docs/notes/requests/wp5b-to-integrator.md):
 *   a 5 s temp token that expires during an 8 s idle, then the first update. Skipped until aai-open can open with
 *   `?token=` (the boundaries test forbids minting tokens or connecting outside the limits helpers).
 *
 *   RUN_LIVE=1 npx tsx --conditions=react-server scripts/day1/va-t3-idle.ts [--idle-ms 12000]
 */
import { SessionError, type InlineSessionConfig } from "../../src/core/aai/voice-agent";
import { closeVa, openVaQueued, readFixture, requireLive, sleep, writeResult } from "./va-lib";

async function main(): Promise<void> {
  requireLive();
  const i = process.argv.indexOf("--idle-ms");
  const idleMs = i > 0 ? Number(process.argv[i + 1]) : 12_000;
  const fx = readFixture("first-update-confirm.json");
  const out: Record<string, unknown> = { idleMs };
  const v = await openVaQueued({ name: "t-d1-3-idle", capMs: 60_000 });
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
  out.partB = { status: "SKIPPED", reason: "aai-open has no token-auth open (request filed: docs/notes/requests/wp5b-to-integrator.md)" };
  out.verdictPartA = out.ready === true ? "PASS" : "FAIL";
  const path = writeResult("t-d1-3", out);
  console.log(JSON.stringify(out, null, 1));
  console.log(path);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
