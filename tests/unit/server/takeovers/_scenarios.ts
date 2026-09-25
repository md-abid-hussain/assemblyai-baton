/**
 * Kit scenarios as synthetic, talk-track-shaped calls for the takeover tests (not a test file). Every fact is stated by
 * its party and, when VERIFIED at the handoff, read back or acknowledged; the raw patches go through WP1's real
 * `applyExtraction`. The scenario JSON shape and the PolicyRecord mapping are fixture code for the kit scenarios only:
 * WP5's production code never sees them (it takes snapshots and policies through the contracts).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CaseState, FactEvent, FieldId, FieldStatus, NewFactEvent, PolicyRecord } from "../../../../src/core/contracts/case";
import type { RawPatch } from "../../../../src/core/contracts/extract";
import { turnIdOf, type TurnInput } from "../../../../src/core/contracts/turns";
import { applyExtraction, deriveCaseState } from "../../../../src/core/case";

const ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

interface KitFact { value: string | number | boolean; stated_by: "rep" | "customer"; status_at_handoff: FieldStatus; say_it?: string }
export interface KitScenario {
  id: string; call_date: string; rep: { name: string; agency: string };
  customer: { name: string; policy_number: string; carrier: string; address: { street: string; city: string; state: string; zip: string };
    existing_drivers: { name: string; relation: string }[]; vehicles: { id: string; year: number; make: string; model: string }[]; current_premium_monthly_usd: number };
  facts: Partial<Record<FieldId, KitFact>>;
}

export const kit = (id: string): KitScenario => JSON.parse(readFileSync(join(ROOT, "data", "scenarios", `${id}.json`), "utf8")) as KitScenario;

/** The PolicyRecord WP9's normalizeScenario produces (same mapping as WP1's test fixtures). */
export function policyOf(s: KitScenario): PolicyRecord {
  const [first = "", ...rest] = s.customer.name.split(" ");
  return {
    policyNumber: s.customer.policy_number, carrier: s.customer.carrier, agencyName: s.rep.agency, repFirstName: s.rep.name.split(" ")[0]!,
    policyholder: { firstName: first, lastName: rest.join(" ") }, phoneOnFileLast4: s.customer.policy_number.replace(/\D/g, "").slice(-4),
    address: s.customer.address, existingDrivers: s.customer.existing_drivers,
    vehicles: s.customer.vehicles.map((v) => ({ id: v.id, year: v.year, make: v.make, model: v.model, label: `${v.year} ${v.make} ${v.model}` })),
    currentMonthlyPremiumUsd: s.customer.current_premium_monthly_usd, callDate: s.call_date,
  };
}

const WORD_MS = 250;
type RawEvent = Omit<RawPatch["events"][number], "turn_id">;

export interface SynthCall { turns: TurnInput[]; events: NewFactEvent[] }

/** A synthetic call: every fact stated by its party (and acknowledged when VERIFIED at the handoff). */
export function synthCall(s: KitScenario, policy: PolicyRecord, caseId: string): SynthCall {
  const counters = { rep: 0, customer: 0 };
  let t = 5_000;
  const turns: TurnInput[] = [];
  const events: NewFactEvent[] = [];
  const say = (channel: "rep" | "customer", text: string, raw: RawEvent[]) => {
    const words = text.split(/\s+/).map((w, i) => ({ text: w, startMs: t + i * WORD_MS, endMs: t + (i + 1) * WORD_MS - 20, confidence: 0.95 }));
    const turn: TurnInput = {
      caseId, turnId: turnIdOf(channel, counters[channel]++), channel, text, startMs: t, endMs: words.at(-1)!.endMs, words,
      source: "stt_live", recvMs: words.at(-1)!.endMs + 400, cut: false, late: false,
    };
    t = turn.endMs + 300;
    turns.push(turn);
    const patch = { no_facts: raw.length === 0, events: raw.map((r) => ({ ...r, turn_id: turn.turnId })) } as RawPatch;
    events.push(...applyExtraction(patch, [turn], { caseId, policy }));
    return turn;
  };
  const facts = Object.entries(s.facts) as [FieldId, KitFact][];
  const ordered = [...facts.filter(([, f]) => f.status_at_handoff === "VERIFIED"), ...facts.filter(([, f]) => f.status_at_handoff === "PENDING")];
  for (const [field, fact] of ordered) {
    const sayIt = fact.say_it ?? String(fact.value);
    const stated = say(fact.stated_by, `${sayIt}.`, [{ field, kind: "stated", value: String(fact.value), quote: sayIt, acknowledges_turn_id: null, confidence: "high" }] as RawEvent[]);
    if (fact.status_at_handoff !== "VERIFIED") continue;
    if (fact.stated_by === "customer") say("rep", `${sayIt}, got it.`, [{ field, kind: "readback", value: String(fact.value), quote: sayIt, acknowledges_turn_id: null, confidence: "high" }] as RawEvent[]);
    else say("customer", "Yes, that's right.", [{ field, kind: "ack", value: null, quote: "Yes, that's right", acknowledges_turn_id: stated.turnId, confidence: "high" }] as RawEvent[]);
  }
  return { turns, events };
}

/** What WP3's freezeSnapshot derives at a pass point: the events of turns that ended by tArm, with `tArmMs`. */
export function snapshotAt(call: SynthCall, policy: PolicyRecord, caseId: string, tArmMs: number): CaseState {
  const seqd: FactEvent[] = call.events.filter((e) => e.turnEndMs <= tArmMs).map((e, i) => ({ ...e, seq: i + 1 }));
  return deriveCaseState(policy, seqd, { caseId, tArmMs });
}

export const HANDOFF_POINTS = ["early", "middle", "handoff"] as const;

/** Pass points along the call: a quarter in, half way, and after the last turn (150 ms after a turn end). */
export function passPoints(call: SynthCall): Record<(typeof HANDOFF_POINTS)[number], number> {
  const n = call.turns.length;
  return {
    early: (call.turns[Math.max(0, Math.floor(n / 4) - 1)]?.endMs ?? 0) + 150,
    middle: (call.turns[Math.floor(n / 2)]?.endMs ?? 0) + 150,
    handoff: (call.turns.at(-1)?.endMs ?? 0) + 150,
  };
}
