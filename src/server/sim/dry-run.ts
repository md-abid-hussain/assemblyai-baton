/**
 * server/sim/dry-run.ts - TEXT DRY RUN (PLATFORM §7.5.2; WP17·3).
 *
 * The default test for a drafted or blank relay: ≈ $0.01, ≈ 15 s, no audio and no AI call.
 *
 *   1. luna writes the `sim_script` exactly as for a voiced sim (`generateSimScript`, WP17·2);
 *   2. its human-half turns are fed to the relay's OWN extractor as rep/customer finals - no STT, no microphone -
 *      and folded by the case engine, so the case card is the real one, not a mock;
 *   3. the page gets the fields at the pass with the quoted turn as evidence, the compiled greeting the AI would
 *      open with, and what it would ask next in each stage.
 *
 * The result is stored on the `sim_calls` row (`kind:"text_dry_run"`), so a dry run is replayable and countable in
 * analytics beside voiced sims - and never blended with them (P§9).
 *
 * Spend: the script's own ledger rows (`sim_script`) plus one `extract` reservation per batch, settled from usage.
 */
import "server-only";

import type OpenAI from "openai";

import { BatonError } from "../../core/contracts/errors";
import { z } from "zod";

import type { FieldState, NewFactEvent, Stage } from "../../core/contracts/case";
import type { RawPatch } from "../../core/contracts/extract";
import type { SpendLedger } from "../../core/contracts/services";
import { turnIdOf, type TurnInput } from "../../core/contracts/turns";
import type { AccountRecord, Blueprint, CompiledRelay, SimScript, TextDryRunResult } from "../../core/contracts/v2";
import { applyExtraction, deriveCaseState, emptyCaseState } from "../../core/case";
import { nextStepOf } from "../../core/compiler/stages";
import { policyFor } from "../../core/relay/account";
import { makeScope } from "../../core/relay/scope";
import { parseTemplate, renderTemplate, type RenderScope } from "../../core/relay/template";
import { log } from "../log";
import { extractStructured, EXTRACTOR_EFFORT, EXTRACTOR_MODEL, type OnTrace } from "../openai/client";
import { extractTimeoutMs, EXTRACT_MAX_OUTPUT_TOKENS, usdOfUsage } from "../openai/extractor";

const dryLog = log.child({ component: "dry-run" });

/** §5.3 batching, reused unchanged: ≤ 3 new turns per call, the last 6 finals as RECENT. */
export const DRY_RUN_BATCH = 3;
export const DRY_RUN_RECENT = 6;
/** One reservation per extractor batch. The real cost is ≈ $0.0005 each. */
export const DRY_RUN_EXTRACT_EST_USD = 0.002;
/** What the client's progress bar is scaled to (§7.5.2: "takes ≈ 15 s"). */
export const DRY_RUN_ETA_SEC = 18;

/** Runtime stage names (`UiSpec`), which call a blueprint's `act` stage `pay`. */
const RUNTIME_STAGE: Record<string, Stage> = { confirm: "confirm", disclose: "disclose", act: "pay", close: "close" };

/** Script turns as finals on the call clock: 4 s a turn, alternating channels, no word timings. */
export function dryRunTurns(script: SimScript, caseId: string): TurnInput[] {
  let repOrder = 0;
  let customerOrder = 0;
  return script.turns.map((t, i) => {
    const order = t.speaker === "rep" ? ++repOrder : ++customerOrder;
    const startMs = i * 4000;
    const endMs = startMs + 3500;
    return {
      caseId,
      turnId: turnIdOf(t.speaker, order),
      channel: t.speaker,
      text: t.text,
      startMs,
      endMs,
      words: [],
      // A dry run has no microphone and no STT: the script IS the final.
      source: "typed" as const,
      recvMs: endMs,
      cut: false,
      late: false,
    };
  });
}

export interface DryRunDeps {
  openai: () => OpenAI;
  ledger: () => SpendLedger | null;
  env: () => string;
  /** Injected in tests: an extractor that returns fixed events and costs nothing. */
  extract?: (i: { turns: TurnInput[]; recent: TurnInput[]; state: ReturnType<typeof emptyCaseState> }) => Promise<ExtractBatch>;
  /** Diagnostics for the live smoke script: what each batch produced, and why it produced nothing. */
  onBatch?: (i: ExtractBatch & { turns: number }) => void;
  /** Raw OpenAI trace, for the live smoke script only. */
  onTrace?: OnTrace;
}

export interface ExtractBatch {
  events: NewFactEvent[];
  usd: number;
  /** The model said there was nothing to extract in these turns. */
  noFacts?: boolean;
  error?: string | null;
}

export interface DryRunInput {
  compiled: CompiledRelay;
  blueprint: Blueprint;
  sampleIndex: number;
  script: SimScript;
  /** The `sim_calls` id; also the case id the evidence quotes are keyed by. */
  simCallId: string;
}

export interface DryRunOutcome {
  result: TextDryRunResult;
  usd: number;
  ms: number;
}

/** A template rendered in a field-phrase position, with `{subject}` resolved first (as the kernel does). */
function phraseScope(bp: Blueprint, account: AccountRecord, snapshot: { fields: Record<string, unknown> }, values: Readonly<Record<string, string | null>>): RenderScope {
  const base = makeScope({ bp, account, snapshot: snapshot as never, values });
  const subject = () => renderTemplate(parseTemplate(bp.playbook.subject), base);
  return makeScope({ bp, account, snapshot: snapshot as never, values, slots: { subject } });
}

const render = (src: string, scope: RenderScope): string => {
  try {
    return renderTemplate(parseTemplate(src), scope).trim();
  } catch {
    return src;
  }
};

export async function runTextDryRun(d: DryRunDeps, i: DryRunInput): Promise<DryRunOutcome> {
  const t0 = performance.now();
  const account = i.blueprint.context.samples[i.sampleIndex];
  if (!account) throw new RangeError(`sample ${i.sampleIndex} does not exist`);
  const policy = policyFor(account);
  const spec = i.compiled.spec;
  const caseId = i.simCallId;
  const turns = dryRunTurns(i.script, caseId);

  // ---- 2. the human half through the relay's own extractor ------------------------------------------------
  const extract = d.extract ?? defaultExtract(d, { compiled: i.compiled, account });
  const events: NewFactEvent[] = [];
  let usd = 0;
  let state = emptyCaseState(caseId, spec);
  for (let at = 0; at < turns.length; at += DRY_RUN_BATCH) {
    const batch = turns.slice(at, at + DRY_RUN_BATCH);
    const recent = turns.slice(Math.max(0, at - DRY_RUN_RECENT), at);
    const out = await extract({ turns: batch, recent, state });
    d.onBatch?.({ ...out, turns: batch.length });
    usd += out.usd;
    events.push(...out.events);
    state = deriveCaseState(policy, events, { caseId }, spec);
  }
  const snapshot = state;

  // ---- 3. the case card at the pass, with the turn that settled each field ---------------------------------
  const byTurn = new Map(turns.map((t) => [t.turnId, t]));
  const fields = i.compiled.ui.fields.map((f) => {
    const st = (snapshot.fields as Record<string, FieldState | undefined>)[f.id];
    const ev = st?.evidence[0] ?? null;
    return {
      id: f.id,
      label: f.label,
      status: st?.status ?? "MISSING",
      value: st?.value ?? null,
      display: st?.display ?? st?.value ?? null,
      quote: ev?.quote ?? null,
      turnId: ev && byTurn.has(ev.turnId) ? ev.turnId : (ev?.turnId ?? null),
    };
  });

  // ---- the compiled greeting, and the next ask in each stage -----------------------------------------------
  const greeting = i.compiled.greeting(snapshot, account);
  const values = i.compiled.values({ snapshot, account });
  const scope = phraseScope(i.blueprint, account, snapshot, values);
  const g = i.blueprint.playbook.greeting;
  const step = nextStepOf(snapshot, spec);
  const fieldOf = (id: string | null) => (id ? i.blueprint.fields.find((f) => f.id === id) ?? null : null);

  const steps = i.blueprint.playbook.stages.map((s) => {
    const stage = RUNTIME_STAGE[s.kind] ?? "confirm";
    let ask: string;
    if (s.kind === "confirm") {
      const f = fieldOf(step.kind === "confirm" || step.kind === "ask" ? step.field : null);
      ask = !f
        ? render(g.next.ready, scope)
        : step.kind === "confirm"
          ? render(g.next.confirm.replace("{phrase.confirm}", f.phrases.confirm), scope)
          : render(g.next.ask.replace("{phrase.ask}", f.phrases.ask), scope);
    } else if (s.kind === "disclose") {
      const d0 = i.blueprint.playbook.disclosures.find((x) => (s.exit.kind === "disclosure_accepted" ? x.id === s.exit.disclosure : true));
      ask = d0 ? `Reads "${d0.title}" word for word, then asks ${render("{subject}", scope) || "you"} to agree.` : render(s.goal, scope);
    } else if (s.kind === "act") {
      const c = i.blueprint.connectors.find((x) => "toolName" in x && s.tools.includes(x.toolName));
      ask = c ? `Uses ${c.label.toLowerCase()} and confirms it went through.` : render(s.goal, scope);
    } else {
      ask = render(g.next.ready, scope);
    }
    return { stage, label: s.label, ask: ask.slice(0, 400) };
  });

  return {
    result: {
      fields,
      greeting: { text: greeting.text, wordCount: greeting.wordCount },
      steps,
      extractorVersionId: i.compiled.extractor.versionId,
    },
    usd: Math.round(usd * 1e6) / 1e6,
    ms: Math.round(performance.now() - t0),
  };
}

/**
 * The real extractor, bound to this relay's compiled artefacts. It is the SAME `OpenAIExtractor` a live run uses -
 * the only difference is where the finals come from - so a dry run tests the relay, not a stand-in.
 */
/**
 * The relay's own extractor call, made here rather than through `OpenAIExtractor` (WP14b's) for one reason:
 * that class sanitizes the model's patch with `RawPatchEventSchema`, whose `field` is `FieldIdSchema` - the **21
 * legacy Baton field ids**. A drafted relay's fields are not among them, so every event is silently dropped and the
 * case card comes back empty. Measured live on 2026-09-25: 4 batches, 4 valid events from luna, 0 kept
 * (`docs/notes/requests/wp17-to-wp14b.md` §6 asks for the shared fix).
 *
 * Everything else is the same call a live run makes: the same compiled prompt, the same strict format (whose `field`
 * enum is the relay's own ids, so nothing foreign can come back), the same effort and token budget. The events are
 * then filtered by `applyExtraction` against `spec.fieldIds`, which is the check that actually belongs here.
 */
const DRY_RUN_PATCH = z.object({
  no_facts: z.boolean().default(false),
  events: z.array(z.object({
    turn_id: z.string(),
    field: z.string(),
    kind: z.enum(["stated", "readback", "ack", "corrected", "denied", "question"]),
    value: z.string().nullable(),
    quote: z.string(),
    acknowledges_turn_id: z.string().nullable(),
    confidence: z.enum(["high", "medium", "low"]),
  })).default([]),
});

function defaultExtract(d: DryRunDeps, o: { compiled: CompiledRelay; account: AccountRecord }): NonNullable<DryRunDeps["extract"]> {
  const spec = o.compiled.spec;
  const policy = policyFor(o.account);
  return async ({ turns, recent, state }) => {
    const caseId = turns[0]!.caseId;
    const ledger = d.ledger();
    let reservation: string | null = null;
    if (ledger) {
      const res = await ledger.reserve({ provider: "openai", action: "extract", refId: caseId, estUsd: DRY_RUN_EXTRACT_EST_USD, env: d.env() });
      if (!res.ok) throw new BatonError("E_BUDGET", "Today's dry-run budget is used up. The compiled preview still works.");
      reservation = res.id;
    }
    try {
      const r = await extractStructured<unknown>(d.openai(), {
        model: EXTRACTOR_MODEL,
        instructions: o.compiled.extractor.prompt,
        input: o.compiled.extractor.buildInput({ callDate: o.account.callDate, account: o.account, state, recent, newTurns: turns }),
        format: o.compiled.extractor.format,
        reasoningEffort: EXTRACTOR_EFFORT,
        temperature: 0,
        maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
        store: false,
        request: { timeoutMs: extractTimeoutMs(), maxRetries: 0 },
        ...(d.onTrace ? { onTrace: d.onTrace } : {}),
        label: "dry_run_extract",
      });
      const usd = usdOfUsage(r.usage);
      if (ledger && reservation) await ledger.settle(reservation, usd).catch((err: unknown) => dryLog.warn("ledger settle failed", { err }));
      const parsed = DRY_RUN_PATCH.safeParse(r.data);
      if (!parsed.success) return { events: [], usd, noFacts: false, error: "the extractor's patch did not parse" };
      const events = applyExtraction(parsed.data as unknown as RawPatch, turns, { caseId, policy, callDate: o.account.callDate }, spec);
      if (events.length < parsed.data.events.length) {
        dryLog.warn("dry run dropped extractor events", { kept: events.length, of: parsed.data.events.length });
      }
      return { events, usd, noFacts: parsed.data.no_facts, error: null };
    } catch (e) {
      if (ledger && reservation) await ledger.release(reservation).catch((err: unknown) => dryLog.warn("ledger release failed", { err }));
      throw e;
    }
  };
}
