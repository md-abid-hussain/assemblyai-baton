/**
 * scripts/sim/draft-smoke.ts - WP17·3 live check of the drafting pipeline (PLATFORM §7.4). OpenAI only; the budget
 * for the whole unit is $0.10 and one desk costs ≈ $0.003.
 *
 * It runs the REAL pipeline against the real `gpt-6-luna`: the strict `draft_blueprint` call, `expandDraft`, the
 * schema and lint round, up to two repairs, the compliance post-fixes. No relay is created and no database is
 * touched, so it can run from a laptop.
 *
 * What it reports per desk, which is what `docs/notes/wp17.md` records:
 *   lint errors after the pipeline, repair rounds, cost, latency, output tokens, whether the greeting passes C1/G2,
 *   whether every disclosure is marked SAMPLE, and whether any real brand survived.
 *
 * With `--dry-run` it then takes the first drafted relay all the way through a TEXT DRY RUN (§7.5.2): the real
 * `sim_script` call, then the relay's OWN compiled extractor over the script's turns, and prints the case card, the
 * compiled greeting and the next ask per stage. That is the whole §7.5.2 path except the row.
 *
 *   RUN_LIVE=1 npx tsx --conditions=react-server scripts/sim/draft-smoke.ts [--desk <n>] [--all] [--dry-run] [--json <file>]
 */
import { writeFileSync } from "node:fs";

import type { Blueprint, DeskInput } from "../../src/core/contracts/v2";
import { compileRelay } from "../../src/core/relay/compile";
import { findDenylistedBrands } from "../../src/core/relay/brand-denylist";
import { runDraftPipeline } from "../../src/server/draft/pipeline";
import { DRAFT_EST_USD } from "../../src/server/openai/draft";
import { createOpenAI } from "../../src/server/openai/client";
import { generateSimScript } from "../../src/server/openai/sim-script";
import { runTextDryRun } from "../../src/server/sim/dry-run";
import { defaultRelayKernel } from "../../src/server/relays/kernel";
import { getLimitsAuthority } from "../lib/limits";
import { loadEnv } from "../lib/load-env";

const ENV = "dev-wp17";
/** Three luna rounds per desk, at the reservation cap. The real cost is far lower; this is the guard. */
const MAX_USD_PER_DESK = 3 * DRAFT_EST_USD;

/** Ten desks, none of them an industry the gallery already ships, for the §7.4 evaluation. */
export const DESKS: { name: string; input: DeskInput }[] = [
  {
    name: "dental-deposit",
    input: {
      industry: "healthcare", businessName: null,
      repHandles: "The coordinator takes the patient's name, what they are booking and the day they want, and checks the slot is free.",
      aiFinishes: ["confirm_details", "read_disclosure", "take_payment", "send_confirmation"],
      verbatim: "The deposit is non-refundable within 24 hours of the appointment.",
      payment: "A flat 50 dollar deposit", tone: "warm, brief, never pushy", voice: null,
    },
  },
  {
    name: "gym-membership-freeze",
    input: {
      industry: "retail", businessName: "Ironcrest Fitness",
      repHandles: "The desk staff take the member's name, which membership they are on and the dates they want to freeze.",
      aiFinishes: ["confirm_details", "read_disclosure", "send_confirmation"],
      verbatim: "A freeze can last up to three months and the monthly fee still applies at ten dollars.",
      payment: null, tone: "friendly and quick", voice: null,
    },
  },
  {
    name: "veterinary-booking",
    input: {
      industry: "other", businessName: null,
      repHandles: "The receptionist takes the owner's name, the pet's name and species, and what is wrong.",
      aiFinishes: ["confirm_details", "take_payment", "send_confirmation"],
      verbatim: null, payment: "A 30 dollar consultation deposit", tone: "calm and reassuring", voice: null,
    },
  },
  {
    name: "utility-move-out",
    input: {
      industry: "utilities", businessName: null,
      repHandles: "The agent takes the account holder's name, the service address and the move-out date, and reads the final meter.",
      aiFinishes: ["confirm_details", "read_disclosure", "send_confirmation"],
      verbatim: "The final bill is issued within 10 business days and any deposit is applied to it.",
      payment: null, tone: "plain and efficient", voice: null,
    },
  },
  {
    name: "mobile-plan-change",
    input: {
      industry: "telecom", businessName: null,
      repHandles: "The advisor takes the subscriber's name, the line they are changing and the plan they want.",
      aiFinishes: ["confirm_details", "read_disclosure", "esign", "send_confirmation"],
      verbatim: "The new plan starts on your next billing date and the price is locked for 12 months.",
      payment: null, tone: "clear and unhurried", voice: null,
    },
  },
  {
    name: "credit-union-card-replacement",
    input: {
      industry: "financial_services", businessName: null,
      repHandles: "The member services agent takes the member's name, which card was lost and the date they last used it.",
      aiFinishes: ["confirm_details", "read_disclosure", "send_confirmation"],
      verbatim: "You are not liable for transactions after you report the card lost.",
      payment: null, tone: "calm, careful, never alarming", voice: null,
    },
  },
  {
    name: "home-insurance-renewal",
    input: {
      industry: "insurance", businessName: null,
      repHandles: "The agent takes the policyholder's name, the property address and the renewal date, and quotes the new premium.",
      aiFinishes: ["confirm_details", "read_disclosure", "take_payment"],
      verbatim: "Cover continues without a gap only if the premium is paid before the renewal date.",
      payment: "The renewal premium the agent quoted", tone: "professional and warm", voice: null,
    },
  },
  {
    name: "driving-school-lesson",
    input: {
      industry: "other", businessName: null,
      repHandles: "The office takes the learner's name, their licence stage and the lesson slot they want.",
      aiFinishes: ["confirm_details", "take_payment", "send_confirmation"],
      verbatim: null, payment: "A 40 dollar lesson deposit", tone: "encouraging and brief", voice: null,
    },
  },
  {
    name: "pharmacy-refill",
    input: {
      industry: "healthcare", businessName: null,
      repHandles: "The technician takes the patient's name, which prescription they need refilled and which store to collect it from.",
      aiFinishes: ["confirm_details", "read_disclosure", "send_confirmation"],
      verbatim: "Refills need a prescriber's authorisation and can take up to two business days.",
      payment: null, tone: "quiet and respectful", voice: null,
    },
  },
  {
    name: "appliance-repair-visit",
    input: {
      industry: "retail", businessName: null,
      repHandles: "The scheduler takes the customer's name, the appliance and fault, and the visit window they want.",
      aiFinishes: ["confirm_details", "read_disclosure", "take_payment", "send_confirmation"],
      verbatim: "The call-out fee is charged even if the appliance cannot be repaired.",
      payment: "A 65 dollar call-out fee", tone: "practical and friendly", voice: null,
    },
  },
];

interface DeskResult {
  desk: string;
  status: "ok" | "invalid";
  lintErrors: number;
  lintWarnings: number;
  repairs: number;
  usd: number;
  ms: number;
  fields: number;
  stages: string[];
  connectors: string[];
  greetingWords: number | null;
  disclosuresSample: boolean;
  brandsLeft: string[];
  notes: string[];
  firstErrors: string[];
}

function fail(msg: string): never {
  console.error(`[draft-smoke] FAIL: ${msg}`);
  process.exit(1);
}

async function runDesk(desk: { name: string; input: DeskInput }, client: ReturnType<typeof createOpenAI>): Promise<{ result: DeskResult; blueprint: Blueprint | null }> {
  const t0 = Date.now();
  const r = await runDraftPipeline(
    {
      llm: { openai: () => client, ledger: () => getLimitsAuthority().ledger, env: () => ENV },
      kernel: defaultRelayKernel,
      create: null,
      today: () => new Date().toISOString().slice(0, 10),
    },
    desk.input,
    `draft-smoke:${desk.name}`,
  );
  const bp = r.blueprint;
  const errors = r.lint.filter((i) => i.severity === "error");
  const brands = bp
    ? [...new Set([bp.meta.title, bp.meta.tagline, ...bp.context.samples.map((s) => s.org.name), ...bp.playbook.disclosures.map((d) => d.text)]
      .flatMap((t) => findDenylistedBrands(t).map((h) => h.brand)))]
    : [];
  const result: DeskResult = {
    desk: desk.name,
    status: r.status,
    lintErrors: errors.length,
    lintWarnings: r.lint.length - errors.length,
    repairs: r.repairs,
    usd: Number(r.usd.toFixed(6)),
    ms: Date.now() - t0,
    fields: bp?.fields.length ?? 0,
    stages: bp?.playbook.stages.map((s) => s.kind) ?? [],
    connectors: bp?.connectors.map((c) => c.type) ?? [],
    greetingWords: bp?.playbook.greeting.maxWords ?? null,
    disclosuresSample: (bp?.playbook.disclosures ?? []).every((d) => /\bSAMPLE\b/.test(d.text)),
    brandsLeft: brands,
    notes: r.notes,
    firstErrors: errors.slice(0, 3).map((i) => `${i.code} ${i.path.join(".")}: ${i.message}`),
  };
  return { result, blueprint: bp };
}

/** The §7.5.2 path on a freshly drafted relay: script (luna) → the relay's own extractor → the page's three panes. */
async function dryRun(bp: Blueprint, client: ReturnType<typeof createOpenAI>): Promise<void> {
  const llm = { openai: () => client, ledger: () => getLimitsAuthority().ledger, env: () => ENV };
  const t0 = Date.now();
  const script = await generateSimScript(llm, { blueprint: bp, sampleIndex: 0, refId: "draft-smoke:dry" });
  console.log(`[draft-smoke] script: ${script.script.turns.length} turns, ${script.chars} chars, attempt ${script.attempts}, $${script.usd.toFixed(5)}`);
  const compiled = compileRelay(bp, { versionId: null, relayId: null, hash: "smoke", flagship: false });
  const out = await runTextDryRun(
    {
      ...llm,
      onBatch: (b) => console.log(`             batch of ${b.turns}: ${b.events.length} events, noFacts=${b.noFacts ?? "-"}, error=${b.error ?? "-"}`),
      ...(process.argv.includes("--trace")
        ? { onTrace: (e: { type: string; response?: unknown }) => { if (e.type === "responses.response") console.log(`             raw: ${JSON.stringify((e.response as { output_text?: string }).output_text ?? "").slice(0, 400)}`); } }
        : {}),
    },
    { compiled, blueprint: bp, sampleIndex: 0, script: script.script, simCallId: "sim_draftsmoke00000" },
  );
  const settled = out.result.fields.filter((f) => f.status !== "MISSING");
  console.log(`[draft-smoke] dry run: ${settled.length}/${out.result.fields.length} fields settled, $${out.usd.toFixed(5)}, ${((Date.now() - t0) / 1000).toFixed(1)}s total`);
  for (const f of out.result.fields) console.log(`             ${f.status.padEnd(9)} ${f.label.padEnd(24)} ${f.display ?? "-"}${f.quote ? `   "${f.quote.slice(0, 50)}"` : ""}`);
  console.log(`[draft-smoke] greeting (${out.result.greeting.wordCount} words): ${out.result.greeting.text}`);
  for (const s of out.result.steps) console.log(`             ${s.stage.padEnd(8)} ${s.label.padEnd(10)} ${s.ask}`);
}

async function main(): Promise<void> {
  loadEnv();
  if (process.env.RUN_LIVE !== "1") fail("set RUN_LIVE=1 (this spends OpenAI credit)");
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) fail("OPENAI_API_KEY is not set (value never printed)");

  const deskIdx = process.argv.indexOf("--desk");
  const all = process.argv.includes("--all");
  const chosen = all ? DESKS : DESKS.slice(0, deskIdx > 0 ? Number(process.argv[deskIdx + 1]) : 1);
  const worst = chosen.length * MAX_USD_PER_DESK;
  console.log(`[draft-smoke] ${chosen.length} desk(s); worst case $${worst.toFixed(3)}`);

  const client = createOpenAI(key, { maxRetries: 0, timeoutMs: 120_000 });
  const results: DeskResult[] = [];
  let firstBlueprint: Blueprint | null = null;
  for (const desk of chosen) {
    const { result: r, blueprint } = await runDesk(desk, client);
    firstBlueprint ??= blueprint;
    results.push(r);
    console.log(
      `[draft-smoke] ${r.desk.padEnd(30)} ${r.status.padEnd(7)} errors=${r.lintErrors} warns=${r.lintWarnings} repairs=${r.repairs} ` +
      `fields=${r.fields} stages=${r.stages.join(">")} $${r.usd.toFixed(5)} ${(r.ms / 1000).toFixed(1)}s`,
    );
    if (r.firstErrors.length) for (const e of r.firstErrors) console.log(`             ${e}`);
    if (r.brandsLeft.length) console.log(`             BRANDS LEFT: ${r.brandsLeft.join(", ")}`);
  }

  const clean = results.filter((r) => r.lintErrors === 0).length;
  const usd = results.reduce((s, r) => s + r.usd, 0);
  console.log(`[draft-smoke] lint-error-free ${clean}/${results.length}; no repair needed ${results.filter((r) => r.repairs === 0).length}/${results.length}; total $${usd.toFixed(5)}`);
  console.log(`[draft-smoke] every disclosure SAMPLE: ${results.every((r) => r.disclosuresSample)}; brands left: ${results.flatMap((r) => r.brandsLeft).length}`);

  if (process.argv.includes("--dry-run")) {
    if (!firstBlueprint) fail("nothing was drafted, so there is nothing to dry-run");
    await dryRun(firstBlueprint, client);
  }

  const jsonIdx = process.argv.indexOf("--json");
  if (jsonIdx > 0) {
    writeFileSync(process.argv[jsonIdx + 1]!, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    console.log(`[draft-smoke] wrote ${process.argv[jsonIdx + 1]}`);
  }
  if (clean < results.length) console.log("[draft-smoke] some desks still lint with errors; see above");
}

void main();
