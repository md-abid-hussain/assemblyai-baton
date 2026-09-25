/**
 * T-D1-0: first-update acceptance (DESIGN App. B, §5.9.1). WP5b.
 *
 * Sends the exact hand-written first `session.update` (scripts/day1/fixtures/first-update-{confirm,disclose}.json)
 * for both initial stages, once with keyterms off and once with keyterms on, and each transcription_mode once:
 *
 *   #  fixture   keyterms  transcription_mode  listen to the greeting
 *   1  confirm   off       min_latency         yes (verbatim check)
 *   2  disclose  off       balanced            no
 *   3  confirm   on        max_accuracy        no
 *   4  disclose  on        min_latency         yes (verbatim check)
 *
 * Pass: session.ready every time, and session.ready.config echoes input.transcription_mode, input.keyterms (when
 * sent) and tools[].execution_mode:"interactive" as sent.
 *
 *   RUN_LIVE=1 npx tsx --conditions=react-server scripts/day1/va-t0-first-update.ts [--fixture-dir <dir>]
 *
 * `--fixture-dir` re-runs the same matrix on WP1's compiler output at G1 (files with the same names).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { SessionError, type InlineSessionConfig } from "../../src/core/aai/voice-agent";
import { FIXTURE_KEYTERMS } from "./va-build-fixtures";
import {
  FIXTURES_DIR, closeVa, diffEcho, joinWords, norm, openVaQueued, requireLive, sleep, startFeeder, waitReplyDone, writeResult,
} from "./va-lib";

type Stage = "confirm" | "disclose";
const MATRIX: { stage: Stage; keyterms: boolean; mode: "min_latency" | "balanced" | "max_accuracy"; listen: boolean }[] = [
  { stage: "confirm", keyterms: false, mode: "min_latency", listen: true },
  { stage: "disclose", keyterms: false, mode: "balanced", listen: false },
  { stage: "confirm", keyterms: true, mode: "max_accuracy", listen: false },
  { stage: "disclose", keyterms: true, mode: "min_latency", listen: true },
];

async function main(): Promise<void> {
  requireLive();
  const dirArg = process.argv.indexOf("--fixture-dir");
  const dir = dirArg > 0 && process.argv[dirArg + 1] ? resolve(process.argv[dirArg + 1]!) : FIXTURES_DIR;
  const results: unknown[] = [];
  let totalUsd = 0;

  for (const [i, m] of MATRIX.entries()) {
    const fx = JSON.parse(readFileSync(resolve(dir, `first-update-${m.stage}.json`), "utf8")) as {
      type: "session.update";
      session: Record<string, unknown> & { input: Record<string, unknown>; greeting: string };
    };
    const session = structuredClone(fx.session);
    session.input = { ...session.input, transcription_mode: m.mode };
    if (m.keyterms) session.input.keyterms = [...FIXTURE_KEYTERMS[m.stage]];
    const name = `t-d1-0-${i + 1}-${m.stage}-${m.keyterms ? "kt" : "nokt"}-${m.mode}`;
    const v = await openVaQueued({ name, capMs: 90_000 });
    const rec: Record<string, unknown> = { run: i + 1, ...m, waitedMs: v.waitedMs };
    try {
      const t0 = performance.now();
      let ready;
      try {
        ready = await v.session.start(session as InlineSessionConfig, 10_000);
      } catch (e) {
        rec.ready = false;
        rec.error = e instanceof SessionError ? { code: e.code, message: e.event.message, param: e.event.param } : String(e);
        rec.close = v.session.closed ?? null;
        console.log(`#${i + 1} ${name}: NO session.ready`, rec.error);
        continue;
      }
      rec.ready = true;
      rec.readyMs = Math.round(performance.now() - t0);
      rec.sessionId = ready.session_id;
      const d = diffEcho(session, ready);
      rec.echo = d;
      rec.sawUpdatedBeforeReady = v.session.timeline.some((x) => x.type === "session.updated");
      if (m.listen) {
        const feeder = startFeeder(v.session);
        const greet = await waitReplyDone(v.session, 45_000);
        await feeder.stop();
        if (greet) {
          const spoken = greet.text ?? joinWords(greet.words);
          rec.greeting = {
            kind: greet.kind,
            leadingSilenceMs: greet.leadingSilenceMs,
            audioMs: Math.round(greet.audioMs),
            firstAudibleAfterReadyMs: greet.firstAudibleAtMs !== undefined ? Math.round(greet.firstAudibleAtMs - (t0 + (rec.readyMs as number))) : null,
            verbatim: norm(spoken) === norm(session.greeting),
            transcript: spoken,
          };
        } else rec.greeting = { timeout: true };
      } else {
        await sleep(1000);
      }
      console.log(`#${i + 1} ${name}: ready in ${rec.readyMs} ms, echo ${d.ok ? "OK" : "MISMATCH"}`, d.ok ? "" : JSON.stringify(d.checks.filter((c) => !c.ok)));
    } finally {
      const c = await closeVa(v);
      rec.sessionSeconds = c.sessionSeconds;
      rec.usd = c.usd;
      totalUsd += c.usd ?? 0;
      results.push(rec);
    }
  }
  const pass = results.every((r) => (r as { ready?: boolean; echo?: { ok: boolean } }).ready && (r as { echo?: { ok: boolean } }).echo?.ok);
  const path = writeResult("t-d1-0", { pass, totalUsd: Math.round(totalUsd * 10000) / 10000, results });
  console.log(`T-D1-0 ${pass ? "PASS" : "FAIL"}; spend ≈ $${totalUsd.toFixed(4)}; ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
