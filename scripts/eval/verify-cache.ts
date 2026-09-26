/**
 * verify-cache.ts - the verifier cache for the v3 "verifier off" ablation (DESIGN §6.3): sol (WP3 `OpenAIVerifier`)
 * over the cached finals at a 30 s call-time cadence → `data/cache/verify/<callId>.<variant>.json`.
 *
 *   RUN_LIVE=1 npx tsx --conditions=react-server scripts/eval/verify-cache.ts [--variant pc_ctx] [--calls pilot|…]
 *       [--force] [--dry-run] [--max-usd 1.00] [--calls-dir …] [--data-root …]
 *
 * A run is usable at t when startMs + ms ≤ t; runs never overlap (F2). ≈6 runs × $0.016 per call.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { VerifierCacheFileSchema, type SttVariant } from "../../src/core/contracts/eval";
import { stableJson } from "../../src/core/scenario/assets";
import { replayVerifier, VERIFY_CADENCE_MS } from "../../src/core/scenario/extract-replay";
import { parseFlags, resolvePaths, str, verifyCachePath } from "../calls/lib/kit-io";
import { cachedTurns, planFromKit, selectCalls } from "./lib/replay-inputs";

const EST_USD_PER_RUN = 0.016;

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2), {
    variant: "string", calls: "string", force: "boolean", "dry-run": "boolean", "max-usd": "string", "calls-dir": "string", "sim-takes-dir": "string", "scenarios-dir": "string", "data-root": "string",
  });
  const paths = resolvePaths({ callsDir: str(f["calls-dir"]), simTakesDir: str(f["sim-takes-dir"]), scenariosDir: str(f["scenarios-dir"]), dataRoot: str(f["data-root"]) });
  const variant = (str(f.variant) ?? "pc_ctx") as SttVariant;
  const maxUsd = Number(str(f["max-usd"]) ?? "1");
  const calls = selectCalls(planFromKit(paths), str(f.calls) ?? "pilot");
  const todo = calls.filter((c) => {
    if (!cachedTurns(paths, c.entry.callId, variant, "x")) {
      console.log(`skip ${c.entry.callId}: no complete ${variant} STT cache`);
      return false;
    }
    if (!f.force && existsSync(verifyCachePath(paths.dataRoot, c.entry.callId, variant))) {
      console.log(`cached ${c.entry.callId}`);
      return false;
    }
    return true;
  });
  const est = todo.reduce((s, c) => s + Math.ceil(c.entry.durationMs / VERIFY_CADENCE_MS) * EST_USD_PER_RUN, 0);
  console.log(`${todo.length} call(s), ≈$${est.toFixed(3)} (cap $${maxUsd.toFixed(2)})`);
  if (f["dry-run"]) return;
  if (process.env.RUN_LIVE !== "1") throw new Error("refusing to call OpenAI without RUN_LIVE=1 (use --dry-run to preview)");

  const { createOpenAI, VERIFIER_MODEL } = await import("../../src/server/openai/client");
  const { OpenAIVerifier } = await import("../../src/server/openai/verifier");
  const { loadEnv } = await import("../lib/load-env");
  const { getLimitsAuthority } = await import("../lib/limits");
  loadEnv();
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY missing (value never printed)");
  const verifier = new OpenAIVerifier({ client: createOpenAI(key, { maxRetries: 1 }) });
  const ledger = getLimitsAuthority().ledger;
  let spent = 0;
  for (const c of todo) {
    const callEst = Math.ceil(c.entry.durationMs / VERIFY_CADENCE_MS) * EST_USD_PER_RUN;
    if (spent + callEst > maxUsd) {
      console.log(`budget: stopping at $${spent.toFixed(3)}`);
      break;
    }
    const caseId = `eval-${c.entry.callId}`;
    const turns = cachedTurns(paths, c.entry.callId, variant, caseId)!;
    const res = await ledger.reserve({ provider: "openai", action: "wp9_verify_cache", refId: c.entry.callId, estUsd: callEst, env: process.env.BATON_DEPLOY_ID ?? "dev-wp9" });
    if (!res.ok) throw new Error(`ledger refused (${res.code})`);
    try {
      const r = await replayVerifier(
        { callId: c.entry.callId, variant, caseId, policy: c.scenario.policy, callDate: c.scenario.callDate, turns, endMs: c.entry.durationMs, createdAt: new Date().toISOString(), model: VERIFIER_MODEL },
        { verifier, onRun: (x) => console.log(`    run @${(x.startMs / 1000).toFixed(0)} s: ${x.turns} turns, ${x.ms} ms`) },
      );
      await ledger.settle(res.id, r.usd);
      spent += r.usd;
      const out = verifyCachePath(paths.dataRoot, c.entry.callId, variant);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, stableJson(VerifierCacheFileSchema.parse(r.file)));
      console.log(`verified ${c.entry.callId}: ${r.file.runs.length} runs, $${r.usd.toFixed(4)}`);
    } catch (e) {
      await ledger.release(res.id).catch(() => undefined);
      console.error(`FAILED ${c.entry.callId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`done: $${spent.toFixed(4)} OpenAI`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
