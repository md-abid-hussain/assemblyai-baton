/**
 * T2b - does `max_session_duration_seconds` on the temp token actually cap the session? (session.ready
 * `expires_at` came back as now+3600 s in T2 regardless of the requested 180 s.) Also: can the same token
 * open a second, concurrent session?
 *
 * Mints a token with max_session_duration_seconds=60 (the minimum), streams silence at real time and waits
 * up to 100 s for the server to end the session. ALWAYS sends session.end at the end.
 *
 *   npx tsx voice-agent/t2b-max-duration.ts
 * Log: spikes/out/va-t2b-max-duration.jsonl
 */
import { RealtimeAudioFeeder, type ServerEvent } from "./client.ts";
import { brief, open, restFor, sleep, vaLogger } from "./harness.ts";

const log = vaLogger("t2b-max-duration");
const rest = restFor(log, "bearer");
const out: Record<string, unknown> = {};

async function main() {
  const { token } = await rest.mintToken({ expiresInSeconds: 60, maxSessionDurationSeconds: 60 });
  const s = await open(log, { token });
  const tReady = Date.now();
  const ready = await s.start({ system_prompt: "You are a silent test agent. Never speak unless the user speaks.", output: { voice: "alba" } });
  out.session_id = ready.session_id;
  out.expiresAtMinusNowSec = ready.expires_at ? Math.round(ready.expires_at - tReady / 1000) : null;
  const feeder = new RealtimeAudioFeeder(s);
  feeder.start();

  // concurrent second session with the same token
  try {
    const s2 = await open(log, { token });
    try {
      const r2 = await s2.start({ system_prompt: "second session", output: { voice: "alba" } }, 8000);
      out.sameTokenConcurrent = { ready: true, session_id: r2.session_id };
    } catch (e) {
      out.sameTokenConcurrent = { ready: false, error: String(e) };
    }
    await s2.end();
  } catch (e) {
    out.sameTokenConcurrent = { connectError: String(e) };
  }
  console.log("same token concurrent:", brief(out.sameTokenConcurrent));

  const terminal: { atSec: number; ev: ServerEvent }[] = [];
  s.on("*", (e: ServerEvent) => {
    if (e.type === "session.ended" || e.type === "session.error") terminal.push({ atSec: (Date.now() - tReady) / 1000, ev: e });
  });
  const deadline = Date.now() + 100_000;
  while (Date.now() < deadline && s.isOpen) await sleep(500);
  out.serverTerminal = terminal;
  out.closedAtSec = s.closed ? (Date.now() - tReady) / 1000 : null;
  out.close = s.closed ?? null;
  out.stillOpenAfter100s = s.isOpen;
  out.feeder = { sentChunks: feeder.sentChunks, maxLateMs: Math.round(feeder.maxLateMs) };
  await feeder.stop();
  out.clientEnd = (await s.end()) ?? null;
  const capped = !out.stillOpenAfter100s;
  log.result(capped ? "PASS" : "FAIL", out);
  log.close();
  console.log(brief(out, 3000));
}

main().catch((e) => {
  log.error(e);
  log.close();
  console.error(e);
  process.exit(1);
});
