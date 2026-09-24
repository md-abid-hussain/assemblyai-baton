/**
 * stt-replay.ts - one live replay of the dialog fixture through two U3.5 Pro sessions via the product's
 * LiveSttChannelManager (WP4 acceptance 1 proxy: finals on the correct channel, no 3007, feed offset, Begin checks).
 *
 *   RUN_LIVE=1 npx tsx scripts/day1/stt-replay.ts [--rate 8000|16000] [--tuning default|none|MIN,MAX]
 *                                                  [--ctx last_rep_turn|none] [--record <cached-turns.json>] [--out <result.json>]
 *
 * Every open goes through scripts/lib/aai-open.ts (the laptop limits guard: 4 STT opens/min, ledger, always
 * Terminate). Costs ≈ 2 × 72 s × $0.45/h ≈ $0.018 per run.
 */
import { writeFileSync } from "node:fs";

import { registerMarkerShim } from "./stt-hooks";

registerMarkerShim();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (process.env.RUN_LIVE !== "1") {
    console.error("refusing to open live sessions without RUN_LIVE=1");
    process.exit(2);
  }
  const { replayFixture } = await import("./stt-live");
  const rate = Number(arg("rate") ?? 8000) === 16000 ? 16000 : 8000;
  const t = arg("tuning") ?? "default";
  const tuning8k = t === "default" ? undefined : t === "none" ? null : (() => {
    const [a, b] = t.split(",").map(Number);
    return { min_turn_silence: a!, max_turn_silence: b! };
  })();
  const ctx = arg("ctx") === "none" ? "none" : "last_rep_turn";
  const record = arg("record");
  const res = await replayFixture({ rate, ...(tuning8k !== undefined ? { tuning8k } : {}), ctxCarry: ctx, label: `${rate}-${t}-${ctx}`, ...(record ? { recordCachedTo: record } : {}) });
  const out = arg("out");
  if (out) writeFileSync(out, `${JSON.stringify(res, null, 2)}\n`);
  const { turns: _t, params: _p, ...summary } = res;
  console.log(JSON.stringify({ ...summary, channels: Object.fromEntries(Object.entries(res.channels).map(([k, v]) => [k, { ...v, text: `${v.text.slice(0, 80)}…` }])) }, null, 2));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exit(1);
});
