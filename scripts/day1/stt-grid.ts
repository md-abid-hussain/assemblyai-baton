/**
 * stt-grid.ts - T-D1-6 (DESIGN App. B): 8 kHz µ-law turn tuning. The v1.1 grid is min_turn_silence ∈ {160, 400} ×
 * max_turn_silence ∈ {1000, 2400} on 2 real takes (16 sessions) + one Hinglish × 8 kHz × prompt/keyterms run.
 *
 * Until the real takes exist this runs the REDUCED PROXY grid on the TTS dialog fixture's 8 kHz µ-law derivative
 * (1 "take" × 4 points = 8 sessions) + the server-default baseline + the Hinglish run. Pass `--take <name>` later
 * to label real-take runs (the fixture loader is swapped for the take's split channels by WP9's assets).
 *
 *   RUN_LIVE=1 npx tsx scripts/day1/stt-grid.ts [--out <dir>] [--only baseline|grid|hinglish]
 *
 * Pass criteria: recall ≥ 90%, p50 final ≤ 1 s. Cost ≈ $0.10 for the proxy set.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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
  const { replayFixture, hinglish8k } = await import("./stt-live");
  const { TUNING_8K_GRID } = await import("../../src/core/aai/stt-params");
  const out = resolve(arg("out") ?? "grid-out");
  mkdirSync(out, { recursive: true });
  const only = arg("only");
  const rows: Record<string, unknown>[] = [];
  const points: { label: string; tuning8k: { min_turn_silence: number; max_turn_silence: number } | null }[] = [];
  if (!only || only === "baseline") points.push({ label: "8k-server-default", tuning8k: null });
  if (!only || only === "grid") for (const g of TUNING_8K_GRID) points.push({ label: `8k-${g.min_turn_silence}-${g.max_turn_silence}`, tuning8k: g });
  for (const p of points) {
    const res = await replayFixture({ rate: 8000, tuning8k: p.tuning8k, label: p.label, recordCachedTo: resolve(out, `cached-turns.${p.label}.json`) });
    writeFileSync(resolve(out, `${p.label}.json`), `${JSON.stringify(res, null, 2)}\n`);
    const row = {
      label: p.label,
      entityRecall: res.entityRecall,
      wordRecall: { rep: res.channels.rep.wordRecall, customer: res.channels.customer.wordRecall },
      wer: { rep: res.channels.rep.wer, customer: res.channels.customer.wer },
      finals: { rep: res.channels.rep.finals, customer: res.channels.customer.finals },
      splits: res.channels.rep.splits + res.channels.customer.splits,
      merges: res.channels.rep.merges + res.channels.customer.merges,
      p50: { rep: res.channels.rep.latencyP50, customer: res.channels.customer.latencyP50 },
      p90: { rep: res.channels.rep.latencyP90, customer: res.channels.customer.latencyP90 },
      maxFeedOffsetMs: Math.max(res.channels.rep.maxFeedOffsetMs, res.channels.customer.maxFeedOffsetMs),
      no3007: res.no3007,
      begin: res.beginChecks.every((b) => b.ok),
      usd: res.estUsd,
      missing: res.entitiesMissing,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  if (!only || only === "hinglish") {
    const h = await hinglish8k();
    writeFileSync(resolve(out, "hinglish-8k.json"), `${JSON.stringify(h, null, 2)}\n`);
    rows.push({ label: h.label, finals: h.finals, hasDigits481529: h.hasDigits481529, latinOnly: h.latinOnly, usd: h.estUsd });
    console.log(JSON.stringify(rows.at(-1)));
  }
  writeFileSync(resolve(out, "summary.json"), `${JSON.stringify(rows, null, 2)}\n`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exit(1);
});
