/**
 * client/fixtures/builder.ts - helpers to author BatonEvent fixture logs (dev only: /dev/ui?fixture=…, unit tests).
 *
 * Fixtures are DEV DATA shaped exactly like a live run (every entry parses with BatonEventSchema). They let WP7
 * build and test the console before the controllers land (TASKS WP7 "Fixture event logs until they land").
 */
import "client-only";

import type {
  CaseState, Channel, ConflictCard, Evidence, FieldId, FieldState, FieldStatus, Party, PolicyRecord, StatusReason,
} from "@/core/contracts/case";
import type { BatonEvent } from "@/core/contracts/events";
import type { UiLogEntry } from "@/core/contracts/ext/wp7-ui";
import type { Peaks } from "@/core/contracts/scenario";
import type { TurnInput, WordTiming } from "@/core/contracts/turns";
import { cachedTurnIdOf, turnIdOf } from "@/core/contracts/turns";
import { FIELD_IDS, REQUIRED_FIELDS } from "@/core/intents/add-driver.fields";

// ------------------------------------------------------------------------------------------------ log

type Entry<T extends UiLogEntry> = T extends UiLogEntry ? Omit<T, "t"> : never;

/** Collects entries at explicit page-clock times and returns them stably sorted by `t`. */
export class FixtureLog {
  private readonly items: { t: number; i: number; e: UiLogEntry }[] = [];
  add(t: number, e: Entry<UiLogEntry>): this {
    this.items.push({ t: Math.round(t), i: this.items.length, e: { ...e, t: Math.round(t) } as UiLogEntry });
    return this;
  }
  entries(): UiLogEntry[] {
    return [...this.items].sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.e);
  }
}

export const isBatonEvent = (e: UiLogEntry): e is BatonEvent => !e.type.startsWith("ui.");

// ------------------------------------------------------------------------------------------------ deterministic noise

export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------------------------------------ turns

export interface ScriptTurn {
  ch: Channel;
  startMs: number;
  endMs: number;
  text: string;
}

/** Evenly timed words across the turn (streaming words are good enough for a fixture). */
export function wordsOf(turn: ScriptTurn): WordTiming[] {
  const toks = turn.text.split(/\s+/).filter(Boolean);
  const span = Math.max(1, turn.endMs - turn.startMs);
  const per = span / Math.max(1, toks.length);
  return toks.map((text, i) => ({
    text,
    startMs: Math.round(turn.startMs + i * per),
    endMs: Math.round(turn.startMs + (i + 1) * per - Math.min(60, per * 0.2)),
    confidence: 0.93,
  }));
}

export function turnInput(
  caseId: string,
  turn: ScriptTurn,
  order: number,
  opts: { cached?: boolean; recvLagMs?: number; late?: boolean; cut?: boolean } = {},
): TurnInput {
  const words = wordsOf(turn);
  return {
    caseId,
    turnId: opts.cached ? cachedTurnIdOf(turn.ch, order) : turnIdOf(turn.ch, order),
    channel: turn.ch,
    text: turn.text,
    startMs: words[0]?.startMs ?? turn.startMs,
    endMs: words[words.length - 1]?.endMs ?? turn.endMs,
    words,
    source: opts.cached ? "stt_cache" : "stt_live",
    recvMs: turn.endMs + (opts.recvLagMs ?? 320),
    cut: opts.cut ?? false,
    late: opts.late ?? false,
  };
}

/** Evidence for the words of `turn` that spell `quote` (case-insensitive, punctuation-insensitive). */
export function evidenceFor(turn: TurnInput, quote: string, source: Evidence["source"] = turn.source === "stt_cache" ? "stt_cache" : "stt_live"): Evidence {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9$]/g, "");
  const q = quote.split(/\s+/).map(norm).filter(Boolean);
  const w = turn.words.map((x) => norm(x.text));
  let from = 0;
  let to = turn.words.length - 1;
  outer: for (let i = 0; i < w.length; i++) {
    for (let j = 0; j < q.length; j++) if (w[i + j] !== q[j]) continue outer;
    from = i;
    to = i + q.length - 1;
    break;
  }
  return {
    channel: turn.channel,
    turnId: turn.turnId,
    startMs: turn.words[from]?.startMs ?? turn.startMs,
    endMs: turn.words[to]?.endMs ?? turn.endMs,
    quote,
    source,
  };
}

// ------------------------------------------------------------------------------------------------ case state

export function emptyCaseState(caseId: string): CaseState {
  const fields = {} as Record<FieldId, FieldState>;
  for (const f of FIELD_IDS) {
    fields[f] = { field: f, status: "MISSING", reason: "absent", value: null, display: null, source: null, evidence: [], conflict: null, flags: [], updatedAtMs: 0 };
  }
  return {
    caseId,
    intent: "add_driver",
    version: 0,
    callClockMs: 0,
    fields,
    readiness: readinessOf(fields),
    conflicts: [],
    stage: null,
    disclosuresGiven: [],
    payment: null,
    confirmationNumber: null,
  };
}

export function readinessOf(fields: Record<FieldId, FieldState>): CaseState["readiness"] {
  let verified = 0;
  let pending = 0;
  let missing = 0;
  for (const f of REQUIRED_FIELDS) {
    const st = fields[f]?.status ?? "MISSING";
    if (st === "VERIFIED") verified++;
    else if (st === "PENDING") pending++;
    else missing++;
  }
  return { verified, pending, missing, requiredTotal: REQUIRED_FIELDS.length, ready: pending === 0 && missing === 0 };
}

export interface FieldPatch {
  status: FieldStatus;
  reason: StatusReason;
  value?: string | null;
  display?: string | null;
  source?: Party | null;
  /** Newest first after merge (≤3 kept). */
  evidence?: Evidence[];
  conflict?: FieldState["conflict"];
  flags?: FieldState["flags"];
}

export function setField(cs: CaseState, field: FieldId, p: FieldPatch, atMs: number): CaseState {
  const prev = cs.fields[field];
  const evidence = [...(p.evidence ?? []), ...(prev?.evidence ?? [])]
    .filter((e, i, xs) => xs.findIndex((x) => x.turnId === e.turnId && x.startMs === e.startMs) === i)
    .slice(0, 3);
  const next: FieldState = {
    field,
    status: p.status,
    reason: p.reason,
    value: p.value !== undefined ? p.value : (prev?.value ?? null),
    display: p.display !== undefined ? p.display : (prev?.display ?? null),
    source: p.source !== undefined ? p.source : (prev?.source ?? null),
    evidence,
    conflict: p.conflict !== undefined ? p.conflict : null,
    flags: p.flags ?? [],
    updatedAtMs: atMs,
  };
  const fields = { ...cs.fields, [field]: next };
  return { ...cs, version: cs.version + 1, callClockMs: Math.max(cs.callClockMs, atMs), fields, readiness: readinessOf(fields) };
}

export function withConflicts(cs: CaseState, conflicts: ConflictCard[]): CaseState {
  return { ...cs, conflicts, version: cs.version + 1 };
}

// ------------------------------------------------------------------------------------------------ peaks

/** Synthetic peaks (50/s) shaped by the script's turns: dev fixtures only. */
export function syntheticPeaks(turns: readonly ScriptTurn[], durationMs: number, seed = 7): Peaks {
  const n = Math.ceil(durationMs / 20);
  const rnd = prng(seed);
  const mk = (ch: Channel) => {
    const out = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) out[i] = Math.round(rnd() * 0.03 * 1000) / 1000;
    for (const t of turns) {
      if (t.ch !== ch) continue;
      const a = Math.floor(t.startMs / 20);
      const b = Math.min(n - 1, Math.ceil(t.endMs / 20));
      for (let i = a; i <= b; i++) {
        const syll = 0.55 + 0.45 * Math.sin(i * 0.9 + rnd() * 2);
        const edge = Math.min(1, (i - a) / 6, (b - i) / 6);
        out[i] = Math.round(Math.min(1, Math.max(0.04, (0.25 + 0.6 * rnd()) * syll * edge)) * 1000) / 1000;
      }
    }
    return out;
  };
  return { ratePerSec: 50, rep: mk("rep"), customer: mk("customer") };
}

// ------------------------------------------------------------------------------------------------ policy

export const S01_POLICY: PolicyRecord = {
  policyNumber: "NBM-4418207",
  carrier: "Northbeam Mutual",
  agencyName: "Harborview Insurance Agency",
  repFirstName: "Daniel",
  policyholder: { firstName: "Priya", lastName: "Raman" },
  phoneOnFileLast4: "8207",
  address: { street: "1427 Belle Avenue", city: "Lakewood", state: "OH", zip: "44107" },
  existingDrivers: [
    { name: "Priya Raman", relation: "named_insured" },
    { name: "Arun Raman", relation: "spouse" },
  ],
  vehicles: [
    { id: "veh1", year: 2021, make: "Honda", model: "Civic", label: "2021 Honda Civic" },
    { id: "veh2", year: 2018, make: "Toyota", model: "Highlander", label: "2018 Toyota Highlander" },
  ],
  currentMonthlyPremiumUsd: 96,
  callDate: "2026-09-25",
};
