/**
 * server/qa/build-input.ts - turns the F3 artifacts into the QA engine's input (DESIGN §4.5 S4, §5.13):
 *  - the async multichannel transcript → ch2 (agent) / ch1 (user) utterances with word timings [10a §11];
 *  - the VA timeline → tool calls (and the `get_disclosure` result time that anchors each disclosure window);
 *  - `takeovers` (snapshot, greeting, outcome, metrics), the case policy and the payment row → the rest.
 * Pure functions over plain data (no I/O), so the unit tests drive them with fixtures.
 */
import "server-only";

import type { CaseState, DisclosureKind, FieldState, PolicyRecord } from "../../core/contracts/case";
import { DISCLOSURE_KINDS } from "../../core/contracts/case";
import type { QaResult } from "../../core/contracts/events";
import {
  TakeoverMetricsReadSchema,
  type TakeoverMetricsRead,
  type Wp8QaDisclosure,
  type Wp8QaInput,
  type Wp8QaUtterance,
} from "../../core/contracts/ext/wp8-verify";
import { BatonToolNameSchema, type ToolName } from "../../core/contracts/tools";
import type { IntentSpec } from "../../core/contracts/v2/relay";
import type { AccountRecord } from "../../core/contracts/v2";
import { accountFor, policyFor } from "../../core/relay/account";
import type { Transcript, Utterance } from "../aai/async";

// ============================================================================================ VA timeline

/** VA session timeline artifact (observed keys, 10a §11). Times are ms from session start. */
export interface TimelineToolCall {
  call_id?: string;
  name?: string;
  arguments?: unknown;
  result?: unknown;
  dispatched_at_ms?: number | null;
  result_received_at_ms?: number | null;
  is_error?: boolean;
  timed_out?: boolean;
}
export interface TimelineTurn {
  turn_id?: string;
  trigger?: string;
  agent_text?: string | null;
  user_transcript?: string | null;
  agent_reply_started_at_ms?: number | null;
  agent_reply_ended_at_ms?: number | null;
  interrupted_at_ms?: number | null;
  tool_calls?: TimelineToolCall[] | null;
}
export interface VaTimeline {
  session_id?: string;
  started_at_unix_ms?: number;
  turns?: TimelineTurn[] | null;
  ended?: { reason?: string; public_reason?: string; duration_seconds?: number } | null;
}

/** A timeline time as ms from session start (tolerates epoch-ms values by subtracting `started_at_unix_ms`). */
export function relMs(v: number | null | undefined, startedAtUnixMs: number | undefined): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v > 1e11 && typeof startedAtUnixMs === "number" && startedAtUnixMs > 1e11) return v - startedAtUnixMs;
  return v;
}

export interface QaToolCall { name: ToolName; atMs: number | null; args: Record<string, unknown> }

function parseArgs(a: unknown): Record<string, unknown> {
  if (a && typeof a === "object" && !Array.isArray(a)) return a as Record<string, unknown>;
  if (typeof a === "string") {
    try {
      const j = JSON.parse(a) as unknown;
      if (j && typeof j === "object" && !Array.isArray(j)) return j as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
  }
  return {};
}

/**
 * Known tool calls in time order, stamped with their result time (else dispatch time). Unknown names are dropped.
 *
 * "Known" is Baton's six built-ins by default. WP14b·3 passes `known` for a relay run — the relay's OWN tool names
 * (`relayQaContext`) — because P§4.7 widened `ToolNameSchema` to the id grammar, so `ToolNameSchema` would now let
 * `made_up_tool` through and the "unknown names dropped" contract would be empty (WP14a·4's note, §2).
 */
export function toolCallsOf(t: VaTimeline | null | undefined, known?: ReadonlySet<string>): QaToolCall[] {
  const out: QaToolCall[] = [];
  for (const turn of t?.turns ?? []) {
    for (const c of turn.tool_calls ?? []) {
      const name = known
        ? (typeof c.name === "string" && known.has(c.name) ? { success: true as const, data: c.name as ToolName } : { success: false as const })
        : BatonToolNameSchema.safeParse(c.name);
      if (!name.success) continue;
      const atMs = relMs(c.result_received_at_ms, t?.started_at_unix_ms) ?? relMs(c.dispatched_at_ms, t?.started_at_unix_ms);
      out.push({ name: name.data, atMs, args: parseArgs(c.arguments) });
    }
  }
  return out.sort((a, b) => (a.atMs ?? Infinity) - (b.atMs ?? Infinity));
}

// ============================================================================================ async transcript

/** Channel of an utterance: `channel`, else `speaker` ("1"/"2" with multichannel). */
const channelOf = (u: Pick<Utterance, "channel" | "speaker">): string | null => (u.channel ?? u.speaker ?? null)?.toString() ?? null;

function toQaUtterance(u: Utterance): Wp8QaUtterance {
  return {
    text: u.text,
    startMs: u.start,
    endMs: u.end,
    words: (u.words ?? []).map((w) => ({ text: w.text, startMs: w.start, endMs: w.end })),
  };
}

/** ch1 = user, ch2 = agent (VA recording layout "stereo (left=user, right=agent)"; 10a §11). */
export function utterancesByChannel(t: Pick<Transcript, "utterances">): { ch1: Wp8QaUtterance[]; ch2: Wp8QaUtterance[] } {
  const ch1: Wp8QaUtterance[] = [];
  const ch2: Wp8QaUtterance[] = [];
  const sorted = [...(t.utterances ?? [])].sort((a, b) => a.start - b.start);
  for (const u of sorted) {
    const ch = channelOf(u);
    if (ch === "2") ch2.push(toQaUtterance(u));
    else if (ch === "1") ch1.push(toQaUtterance(u));
  }
  return { ch1, ch2 };
}

// ============================================================================================ takeover metrics

/**
 * WP14b·3: `TakeoverMetricsReadSchema.disclosures` is a `partialRecord` over Baton's two `DisclosureKind`s
 * (`contracts/ext/wp8-verify.ts`, WP18's file), so a RELAY run — whose stored keys are its own blueprint ids —
 * fails the whole object and used to lose `hud` with it, i.e. every latency number of every Dental run.
 *
 * So: the strict parse first (a Baton run takes it, byte for byte), and on failure one retry without `disclosures`.
 * The relay's own texts are then read from the raw value by `disclosuresOf`. Requested in
 * `requests/wp14b-to-wp18.md` §9; once the enum widens to the id grammar, the retry can go.
 */
export function readMetrics(m: unknown): TakeoverMetricsRead {
  const r = TakeoverMetricsReadSchema.safeParse(m ?? {});
  if (r.success) return r.data;
  if (typeof m === "object" && m !== null && "disclosures" in m) {
    const { disclosures: _d, ...rest } = m as Record<string, unknown>;
    const retry = TakeoverMetricsReadSchema.safeParse(rest);
    if (retry.success) return retry.data;
  }
  return {};
}

/**
 * One QA disclosure per text WP6 stored in `takeovers.metrics.disclosures`. `atMs` = the result time of the
 * matching `get_disclosure` call (first call with `args.kind === kind`, else the n-th unkeyed call), or null (the
 * engine then searches the whole agent channel).
 */
export function disclosuresOf(
  metrics: TakeoverMetricsRead,
  calls: readonly QaToolCall[],
  /**
   * WP14b·3: a relay's own disclosure ids, in blueprint order. `TakeoverMetricsReadSchema.disclosures` is a fixed
   * two-value `partialRecord` in `contracts/ext/wp8-verify.ts` — WP18's file, not WP14b's — so a relay's ids are
   * stripped by that parse and are read from `raw` instead. Requested in `requests/wp14b-to-wp18.md`; once the enum
   * widens, `raw` can go and this becomes one loop.
   */
  relay?: { ids: readonly string[]; raw: unknown },
): Wp8QaDisclosure[] {
  const out: Wp8QaDisclosure[] = [];
  const gets = calls.filter((c) => c.name === "get_disclosure");
  const stored = relay ? rawDisclosures(relay.raw) : null;
  const ids: readonly string[] = relay ? relay.ids : DISCLOSURE_KINDS;
  for (const kind of ids) {
    const d = stored ? stored[kind] : metrics.disclosures?.[kind as (typeof DISCLOSURE_KINDS)[number]];
    if (!d || !d.text.trim()) continue;
    const call = gets.find((c) => c.args.kind === kind) ?? null;
    out.push({ kind: kind as DisclosureKind, text: d.text, criticalTokens: [...d.criticalTokens], atMs: call?.atMs ?? null });
  }
  return out;
}

/** `takeovers.metrics.disclosures` as written, before the two-value parse (WP14b·3; see `disclosuresOf`). */
function rawDisclosures(m: unknown): Record<string, { text: string; criticalTokens: string[] }> {
  const d = (m as { disclosures?: unknown } | null | undefined)?.disclosures;
  if (typeof d !== "object" || d === null) return {};
  const out: Record<string, { text: string; criticalTokens: string[] }> = {};
  for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
    const text = (v as { text?: unknown } | null)?.text;
    if (typeof text !== "string") continue;
    const toks = (v as { criticalTokens?: unknown }).criticalTokens;
    out[k] = { text, criticalTokens: Array.isArray(toks) ? toks.filter((x): x is string => typeof x === "string") : [] };
  }
  return out;
}

export function latencyOf(metrics: TakeoverMetricsRead): NonNullable<Wp8QaInput["latency"]> {
  const h = metrics.hud ?? {};
  return {
    clickToFirstAudibleMs: h.click_to_first_audible ?? null,
    deadAirAfterRepMs: h.dead_air_after_rep ?? null,
    turnLatencyP50Ms: h.turn_audible_latency ?? null,
  };
}

// ============================================================================================ payment

export interface PaymentFacts { status: string; statusSource: string | null; simulated: boolean }

/** DESIGN §5.13 step 7: `payment` from `payments.status_source` (only a succeeded payment counts). */
export function paymentOf(p: PaymentFacts | null | undefined): QaResult["payment"] {
  if (!p || p.status !== "succeeded") return "unpaid";
  if (p.simulated || p.statusSource === "mock") return "simulated";
  if (p.statusSource === "webhook") return "verified_webhook";
  if (p.statusSource === "server_poll") return "verified_poll";
  return "unpaid";
}

// ============================================================================================ keyterms (S2)

const KEYTERM_FIELDS = new Set(["driver_full_name", "vehicle_assignment", "garaging_zip", "license_state", "driver_relation"]);

/**
 * `keyterms_prompt` for the S2 submit: the snapshot's entity values (display form, else the value), the policyholder
 * and existing drivers' names and the vehicle models. ≤ `max` terms, each ≤ 50 chars and ≤ 6 words, deduplicated.
 */
export function keytermsOf(
  snapshot: Pick<CaseState, "fields"> | null,
  /** A Baton case's `PolicyRecord`, or a relay case's stored `AccountRecord` (`cases.policy`, WP14b·3). */
  policy: PolicyRecord | AccountRecord | null,
  max = 100,
  /** WP14b·3: with a spec the entity fields are the RELAY's, and the account's own name and tables supply the rest. */
  spec?: IntentSpec,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string | null | undefined) => {
    const t = (s ?? "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 50 || t.split(" ").length > 6) return;
    const k = t.toLowerCase();
    if (seen.has(k) || out.length >= max) return;
    seen.add(k);
    out.push(t);
  };
  const entity = spec ? spec.entityFields : KEYTERM_FIELDS;
  for (const f of Object.values(snapshot?.fields ?? {}) as (FieldState | undefined)[]) {
    if (!f || !entity.has(f.field)) continue;
    add(f.display ?? f.value);
  }
  if (policy && spec) {
    const a = accountFor(policy);
    add(`${a.customer.firstName} ${a.customer.lastName}`.trim());
    for (const rows of Object.values(a.tables)) for (const row of rows) for (const v of Object.values(row)) add(v);
  } else if (policy) {
    const p = policyFor(policy);
    add(`${p.policyholder.firstName} ${p.policyholder.lastName}`);
    for (const d of p.existingDrivers) add(d.name);
    for (const v of p.vehicles) add(`${v.make} ${v.model}`);
  }
  return out;
}

// ============================================================================================ the input

export interface QaSources {
  snapshot: Pick<CaseState, "fields">;
  /** `cases.policy`: a `PolicyRecord` for a Baton case, a stored `AccountRecord` for a relay case (WP14b·3). */
  policy: PolicyRecord | AccountRecord;
  transcript: Pick<Transcript, "utterances" | "audio_duration">;
  timeline: VaTimeline | null;
  greeting: string | null;
  outcome: string | null;
  metrics: unknown;
  payment: PaymentFacts | null;
  durationSec: number | null;
}

/**
 * The relay half of the QA input (WP14b·3, TASKS-v2 WP14b acceptance 6): which fields are entities, which tool names
 * are known, and which disclosure ids exist. Built from the case's compiled relay (`relayQaContext` in
 * `src/server/engine/qa-context.ts`); omitted, every output is Baton's, byte for byte.
 */
export interface RelayQaContext {
  spec: IntentSpec;
  toolNames: ReadonlySet<string>;
  disclosureIds: readonly string[];
}

export function buildQaInput(s: QaSources, relay?: RelayQaContext): Wp8QaInput {
  const { ch1, ch2 } = utterancesByChannel(s.transcript);
  const calls = toolCallsOf(s.timeline, relay?.toolNames);
  const metrics = readMetrics(s.metrics);
  return {
    provisional: false,
    snapshot: { fields: s.snapshot.fields },
    // `Wp8QaInput.policy` is a `PolicyRecord` (`contracts/ext/wp8-verify.ts`, WP18's file). A relay case's stored
    // account goes through WP14a's adapter, so QA reads one shape; `policyFor` returns a `PolicyRecord` unchanged.
    policy: policyFor(s.policy),
    ch2,
    ch1,
    toolCalls: calls.map((c) => ({ name: c.name, atMs: c.atMs })),
    disclosures: disclosuresOf(metrics, calls, relay ? { ids: relay.disclosureIds, raw: s.metrics } : undefined),
    greeting: s.greeting ?? "",
    // The recording starts with the spoken greeting on ch2, so it is never prepended here.
    prependGreeting: false,
    payment: paymentOf(s.payment),
    handedBack: s.outcome === "handed_back",
    aiSeconds: Math.round((s.durationSec ?? s.transcript.audio_duration ?? 0) * 1000) / 1000,
    latency: latencyOf(metrics),
  };
}
