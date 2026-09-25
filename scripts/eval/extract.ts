/**
 * extract.ts - `npm run eval:extract` (DESIGN §6.3): the extraction cache.
 *
 *   RUN_LIVE=1 npm run eval:extract -- --version v1|v2|v3|all [--variant pc_ctx|pc_noctx|mono_diar]
 *       [--calls pilot|chosen|all|<ids>] [--force] [--dry-run] [--max-usd 1.00] [--calls-dir …] [--data-root …]
 *
 * Replays the cached finals of `<variant>` in recvMs order through the PRODUCTION extractor (WP3 `OpenAIExtractor`,
 * gpt-6-luna) bound to WP1's engine, SEQUENTIALLY with single-turn calls, each seeing the state derived from the
 * events so far → `data/cache/extract/<callId>/<version>.<variant>.json` (`ExtractCacheFile`, turns keyed by the cached
 * turn id `${ch}-c${turn_order}`, events in order, measured `extractMs`).
 *
 * Versions (§6.4): v1 = EXTRACTOR_PROMPT_V1 on pc_noctx; v2 = V3 prompt on pc_noctx; v3 = V3 prompt on pc_ctx.
 * `--version all` = v1.pc_noctx, v2.pc_noctx, v3.pc_ctx, v3.pc_noctx, v3.mono_diar (whichever STT caches exist).
 * A cache whose extractorVersion equals the current one is skipped unless --force. Spend goes to the ledger.
 */
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ADD_DRIVER_PATCH_FORMAT, applyExtraction, buildExtractorInput, deriveCaseState, emptyCaseState, EXTRACT_MAX_NEW_TURNS, EXTRACT_RECENT_TURNS,
  EXTRACTOR_MODEL_ID, EXTRACTOR_PROMPT_V1, EXTRACTOR_PROMPT_V3, EXTRACTOR_REASONING_EFFORT, EXTRACTOR_VERSION_V1, EXTRACTOR_VERSION_V3, verifierDisagreementEvents,
} from "../../src/core/case";
import { ExtractCacheFileSchema, type PipelineVersion, type SttVariant } from "../../src/core/contracts/eval";
import { stableJson } from "../../src/core/scenario/assets";
import { replayExtraction, type DeriveFn } from "../../src/core/scenario/extract-replay";
import { extractCachePath, parseFlags, resolvePaths, str, type PipelinePaths } from "../calls/lib/kit-io";
import { cachedTurns, planFromKit, selectCalls } from "./lib/replay-inputs";

export const VERSION_DEFAULT_VARIANT: Record<PipelineVersion, SttVariant> = { v1: "pc_noctx", v2: "pc_noctx", v3: "pc_ctx" };
export const ALL_CONFIGS: readonly [PipelineVersion, SttVariant][] = [
  ["v1", "pc_noctx"],
  ["v2", "pc_noctx"],
  ["v3", "pc_ctx"],
  ["v3", "pc_noctx"],
  ["v3", "mono_diar"],
];

/** The WP1 engine artefacts per version (v1 = the values-only prompt; v2/v3 = V3). */
export function extractorArtefactsOf(version: PipelineVersion) {
  const v1 = version === "v1";
  return {
    prompt: v1 ? EXTRACTOR_PROMPT_V1 : EXTRACTOR_PROMPT_V3,
    format: ADD_DRIVER_PATCH_FORMAT,
    model: EXTRACTOR_MODEL_ID,
    effort: EXTRACTOR_REASONING_EFFORT as "none",
    version: v1 ? EXTRACTOR_VERSION_V1 : EXTRACTOR_VERSION_V3,
    maxNewTurns: EXTRACT_MAX_NEW_TURNS,
    recentTurns: EXTRACT_RECENT_TURNS,
  };
}

/** Rough luna cost per turn (≈1.5k input + 150 output tokens at $0.10/$0.50 per 1M). */
const EST_USD_PER_TURN = 0.00025;

async function runOne(paths: PipelinePaths, callId: string, version: PipelineVersion, variant: SttVariant, c: ReturnType<typeof planFromKit>[number]): Promise<{ usd: number; turns: number; failed: number }> {
  const { createOpenAI } = await import("../../src/server/openai/client");
  const { OpenAIExtractor } = await import("../../src/server/openai/extractor");
  const { loadEnv } = await import("../lib/load-env");
  const { getLimitsAuthority } = await import("../lib/limits");
  loadEnv();
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY missing (value never printed)");
  const caseId = `eval-${callId}`;
  const turns = cachedTurns(paths, callId, variant, caseId);
  if (!turns) throw new Error(`no complete ${variant} STT cache`);
  const engine = { impl: "wp1" as const, emptyCaseState, deriveCaseState, applyExtraction, verifierDisagreementEvents, buildExtractorInput, extractor: extractorArtefactsOf(version) };
  const extractor = new OpenAIExtractor({ client: createOpenAI(key, { maxRetries: 0 }), engine });
  const ledger = getLimitsAuthority().ledger;
  const res = await ledger.reserve({ provider: "openai", action: `wp9_extract_${version}`, refId: callId, estUsd: turns.length * EST_USD_PER_TURN * 2, env: process.env.BATON_DEPLOY_ID ?? "dev-wp9" });
  if (!res.ok) throw new Error(`ledger refused (${res.code})`);
  try {
    const r = await replayExtraction(
      { callId, version, variant, caseId, policy: c.scenario.policy, callDate: c.scenario.callDate, turns, createdAt: new Date().toISOString() },
      { extractor, derive: deriveCaseState as unknown as DeriveFn, retries: 1, onTurn: (t) => t.failed && console.log(`    turn ${t.turnId} FAILED`) },
    );
    await ledger.settle(res.id, r.usd);
    const file = ExtractCacheFileSchema.parse(r.file);
    const out = extractCachePath(paths.dataRoot, callId, version, variant);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, stableJson(file));
    return { usd: r.usd, turns: turns.length, failed: r.failedTurnIds.length };
  } catch (e) {
    await ledger.release(res.id).catch(() => undefined);
    throw e;
  }
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2), {
    version: "string", variant: "string", calls: "string", force: "boolean", "dry-run": "boolean", "max-usd": "string",
    "calls-dir": "string", "scenarios-dir": "string", "data-root": "string",
  });
  const paths = resolvePaths({ callsDir: str(f["calls-dir"]), scenariosDir: str(f["scenarios-dir"]), dataRoot: str(f["data-root"]) });
  const v = str(f.version) ?? "v3";
  const configs: [PipelineVersion, SttVariant][] =
    v === "all" ? [...ALL_CONFIGS] : [[v as PipelineVersion, (str(f.variant) as SttVariant | undefined) ?? VERSION_DEFAULT_VARIANT[v as PipelineVersion]]];
  for (const [ver] of configs) if (!["v1", "v2", "v3"].includes(ver)) throw new Error(`unknown version ${ver}`);
  const maxUsd = Number(str(f["max-usd"]) ?? "1");
  const calls = selectCalls(planFromKit(paths), str(f.calls) ?? "pilot");
  const todo: { c: (typeof calls)[number]; version: PipelineVersion; variant: SttVariant; est: number }[] = [];
  for (const c of calls) {
    for (const [version, variant] of configs) {
      const turns = cachedTurns(paths, c.entry.callId, variant, "x");
      if (!turns) {
        console.log(`skip ${c.entry.callId} ${version}.${variant}: no complete ${variant} STT cache`);
        continue;
      }
      const out = extractCachePath(paths.dataRoot, c.entry.callId, version, variant);
      if (!f.force && existsSync(out)) {
        const cur = ExtractCacheFileSchema.safeParse(JSON.parse(readFileSync(out, "utf8")));
        if (cur.success && cur.data.extractorVersion === extractorArtefactsOf(version).version) {
          console.log(`cached ${c.entry.callId} ${version}.${variant}`);
          continue;
        }
      }
      todo.push({ c, version, variant, est: turns.length * EST_USD_PER_TURN });
    }
  }
  console.log(`${todo.length} extraction run(s), ≈$${todo.reduce((s, t) => s + t.est, 0).toFixed(3)} (cap $${maxUsd.toFixed(2)})`);
  if (f["dry-run"]) return;
  if (process.env.RUN_LIVE !== "1") throw new Error("refusing to call OpenAI without RUN_LIVE=1 (use --dry-run to preview)");
  let spent = 0;
  for (const t of todo) {
    if (spent + t.est > maxUsd) {
      console.log(`budget: stopping at $${spent.toFixed(3)}`);
      break;
    }
    try {
      const r = await runOne(paths, t.c.entry.callId, t.version, t.variant, t.c);
      spent += r.usd;
      console.log(`extracted ${t.c.entry.callId} ${t.version}.${t.variant}: ${r.turns} turns, ${r.failed} failed, $${r.usd.toFixed(4)}`);
    } catch (e) {
      console.error(`FAILED ${t.c.entry.callId} ${t.version}.${t.variant}: ${e instanceof Error ? e.message : String(e)}`);
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
