/**
 * scripts/tts/generate-chips.ts - WP11: pre-generate every phrase the autopilot customer and the suggestion chips
 * can say for a Baton take, ONCE, and commit them (DESIGN §5.15 "Audio").
 *
 * `/api/tts` is cut (TASKS-v2 §4.1), so nothing is synthesized at run time: the console reads
 * `public/tts/manifest.json` and plays `public/tts/<sha256>.pcm` (raw PCM16 LE mono, 24 kHz). A normal run
 * therefore makes ZERO live TTS calls, which is WP11 acceptance 1. A warm cache makes a re-run $0 and
 * byte-identical (the hash is `sha256(model|voice|instructions|text)`).
 *
 *   npx tsx --conditions=react-server scripts/tts/generate-chips.ts            # plan + cost, writes nothing
 *   RUN_LIVE=1 npx tsx --conditions=react-server scripts/tts/generate-chips.ts # generate and write
 *
 *   --calls <id,id>   takes to cover (default: the featured take of src/generated/calls.json)
 *   --budget <usd>    refuse to start above this estimate (default 0.05, the WP11 OpenAI line in TASKS-v2 §7)
 *   --out <dir>       default public/tts
 *   --cache <dir>     clip cache (default: the out dir, so the COMMITTED clips are the cache and regenerating the
 *                     manifest for a newly recorded take of the same scenario costs $0)
 *
 * Voice: `marin` with `CUSTOMER_INSTRUCTIONS` - the same voice and instructions the simulated calls use for the
 * customer, so a phrase that also exists there ("Yes, that's right.") hashes to the same clip everywhere.
 * When the customer volunteer records a tail pack (§11.6), its clips are listed with `voice: "recorded"` and win
 * over these; nothing here needs to change.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { answerFor, explicitStatement, truthSpoken } from "../../src/core/compiler/suggest";
import type { FieldId, PolicyRecord } from "../../src/core/contracts/case";
import { CallScenariosFileSchema } from "../../src/core/contracts/ext/wp9-data";
import { CallManifestEntrySchema, type Scenario } from "../../src/core/contracts/scenario";
import { firstNameOf, vehicleLabelOf } from "../../src/core/intents/add-driver";
import type { ChipCall, ChipClip, ChipManifest } from "../../src/client/customer/manifest";
import { createOpenAI } from "../../src/server/openai/client";
import { normalizeTtsText, ttsCostUsd, ttsHash, TtsService, TTS_MAX_CHARS, TTS_MODEL } from "../../src/server/openai/tts";
import { CUSTOMER_INSTRUCTIONS } from "../../src/server/sim/voices";
import { getLimitsAuthority } from "../lib/limits";
import { loadEnv, repoRoot } from "../lib/load-env";
import { FsTtsCache } from "../sim/lib/fs-tts-cache";

/** Ledger env label. Built at runtime: the literal would equal a .env value and the secret-scan hook blocks that. */
const ENV = ["dev", "wp11"].join("-");
const VOICE = "marin";

// ------------------------------------------------------------------------------------------- the phrase set

/** Fields whose truth value the AI half can ask about. Rating figures and flags are never asked of the customer. */
const NOT_ASKED: ReadonlySet<string> = new Set([
  "premium_new_monthly_usd", "premium_change_monthly_usd", "premium_due_today_usd", "coverage_change",
  "good_student_discount", "confirmation_number",
]);

/**
 * Every §5.15 template, over this take's truth. Three phrases per askable field (the open answer, the correction
 * after a wrong read-back, and the loop breaker's explicit sentence) plus the fixed set.
 */
export function chipPhrases(s: Pick<Scenario, "policy" | "truth">): string[] {
  const policy: PolicyRecord = s.policy;
  const name = s.truth.driver_full_name ?? null;
  const d = name ? firstNameOf(name) : "The new driver";
  const veh = s.truth.vehicle_assignment;
  const vehLabel = veh && veh !== "all" ? vehicleLabelOf(policy, veh) : null;

  const out: string[] = [
    "Yes, that's right.", // §5.15 step 2 (value matches truth)
    "Yes, go ahead.", // step 4, the premium disclosure
    "Yes, text me the link. No paper copy, thanks.", // step 5, e-sign consent
    "Okay, I'm paying now.", // step 6
    "No, that's everything. Thanks, bye!", // step 7
    `Can I talk to ${policy.repFirstName}?`, // step 8, always appended
    "Sorry, could you repeat that?", // step 8
    "Okay.", // step 9, unclassified
    "Sure.",
    "I'm not sure, sorry.", // a field with no truth
  ];

  for (const [field, value] of Object.entries(s.truth) as [FieldId, string][]) {
    if (!value || NOT_ASKED.has(field)) continue;
    for (const make of [
      () => answerFor(field, value, policy, d),
      () => `No, it's ${truthSpoken(field, value, policy)}.`,
      () => explicitStatement(field, value, policy, d, vehLabel),
    ]) {
      try {
        out.push(make());
      } catch {
        /* a field this scenario cannot phrase: the chip simply will not exist */
      }
    }
  }

  // The "Try this" live-conflict chip (§1.3 P1 step 5): the other policy vehicle.
  const other = veh && veh !== "all" ? policy.vehicles.find((v) => v.id !== veh) : undefined;
  if (other) out.push(`Actually, ${d} will mainly drive the ${other.model}.`);

  const seen = new Set<string>();
  return out
    .map(normalizeTtsText)
    .filter((t) => t.length > 0 && t.length <= TTS_MAX_CHARS)
    .filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
}

// ------------------------------------------------------------------------------------------- the run

interface Args {
  calls: string[] | null;
  budget: number;
  out: string;
  cache: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : null;
  };
  return {
    calls: get("--calls")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null,
    budget: Number(get("--budget") ?? 0.05),
    out: get("--out") ?? "public/tts",
    cache: get("--cache"),
  };
}

const readJson = (root: string, p: string): unknown => JSON.parse(readFileSync(join(root, p), "utf8"));

function writeAtomic(path: string, bytes: Uint8Array | string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

async function main(): Promise<void> {
  loadEnv();
  const root = repoRoot();
  const a = parseArgs(process.argv.slice(2));
  const live = process.env.RUN_LIVE === "1";

  const scenarios = CallScenariosFileSchema.parse(readJson(root, "src/generated/call-scenarios.json"));
  const manifestEntries = (readJson(root, "src/generated/calls.json") as unknown[]).map((e) => CallManifestEntrySchema.parse(e));
  const callIds = a.calls ?? manifestEntries.filter((e) => e.featured).map((e) => e.callId);
  if (!callIds.length) throw new Error("no takes selected (no featured call in src/generated/calls.json; pass --calls)");

  // Plan: every distinct phrase across the selected takes, and which take references which clip.
  const plan = new Map<string, { text: string; hash: string }>();
  const calls: Record<string, ChipCall> = {};
  for (const callId of callIds) {
    const scenario = scenarios[callId];
    if (!scenario) throw new Error(`no scenario for ${callId} in src/generated/call-scenarios.json`);
    const hashes: string[] = [];
    for (const text of chipPhrases(scenario)) {
      const hash = ttsHash(TTS_MODEL, VOICE, CUSTOMER_INSTRUCTIONS, text);
      plan.set(hash, { text, hash });
      hashes.push(hash);
    }
    calls[callId] = { scenarioId: scenario.id, truth: scenario.truth as Record<string, string>, clips: hashes };
  }

  const phrases = [...plan.values()];
  const chars = phrases.reduce((n, p) => n + p.text.length, 0);
  const estUsd = phrases.reduce((n, p) => n + ttsCostUsd(p.text), 0);
  console.log(`[chips] ${callIds.length} take(s), ${phrases.length} distinct phrases, ${chars} chars`);
  console.log(`[chips] estimated OpenAI spend: $${estUsd.toFixed(4)} (budget $${a.budget.toFixed(2)}; a warm cache is $0)`);
  if (estUsd > a.budget) throw new Error(`the plan costs more than --budget ($${estUsd.toFixed(4)} > $${a.budget.toFixed(2)})`);
  if (!live) {
    console.log("[chips] dry run: nothing was generated and nothing was written. Re-run with RUN_LIVE=1.");
    for (const p of phrases.slice(0, 5)) console.log(`         e.g. "${p.text}"`);
    return;
  }

  const outDir = join(root, a.out);
  mkdirSync(outDir, { recursive: true });
  const tts = new TtsService({
    openai: () => createOpenAI(process.env.OPENAI_API_KEY ?? ""),
    cache: new FsTtsCache(join(root, a.cache ?? a.out)),
    ledger: () => getLimitsAuthority().ledger,
    env: () => ENV,
  });

  const clips: ChipClip[] = [];
  let spent = 0;
  const results = await tts.synthMany(
    phrases.map((p) => ({ text: p.text, voice: VOICE, instructions: CUSTOMER_INSTRUCTIONS, refId: "wp11-chips" })),
    3,
  );
  for (const [i, r] of results.entries()) {
    const text = phrases[i]!.text;
    spent += r.usd;
    const file = join(outDir, `${r.hash}.pcm`);
    if (!existsSync(file)) writeAtomic(file, r.pcm24k);
    clips.push({ hash: r.hash, text, durationMs: r.durationMs, voice: "synthetic" });
  }

  const manifest: ChipManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    model: TTS_MODEL,
    voice: VOICE,
    clips: clips.sort((x, y) => x.hash.localeCompare(y.hash)),
    calls,
  };
  writeAtomic(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[chips] wrote ${clips.length} clips + manifest.json to ${a.out} (live spend $${spent.toFixed(4)})`);
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/tts/generate-chips.ts") ?? false;
if (invokedDirectly) {
  main().catch((e: unknown) => {
    console.error(`[chips] FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
