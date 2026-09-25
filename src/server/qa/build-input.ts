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
import { ToolNameSchema, type ToolName } from "../../core/contracts/tools";
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

/** Known tool calls in time order, stamped with their result time (else dispatch time). Unknown names are dropped. */
export function toolCallsOf(t: VaTimeline | null | undefined): QaToolCall[] {
  const out: QaToolCall[] = [];
  for (const turn of t?.turns ?? []) {
    for (const c of turn.tool_calls ?? []) {
      const name = ToolNameSchema.safeParse(c.name);
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

export function readMetrics(m: unknown): TakeoverMetricsRead {
  const r = TakeoverMetricsReadSchema.safeParse(m ?? {});
  return r.success ? r.data : {};
}

/**
 * One QA disclosure per text WP6 stored in `takeovers.metrics.disclosures`. `atMs` = the result time of the
 * matching `get_disclosure` call (first call with `args.kind === kind`, else the n-th unkeyed call), or null (the
 * engine then searches the whole agent channel).
 */
export function disclosuresOf(metrics: TakeoverMetricsRead, calls: readonly QaToolCall[]): Wp8QaDisclosure[] {
  const out: Wp8QaDisclosure[] = [];
  const gets = calls.filter((c) => c.name === "get_disclosure");
  for (const kind of DISCLOSURE_KINDS) {
    const d = metrics.disclosures?.[kind];
    if (!d || !d.text.trim()) continue;
    const call = gets.find((c) => c.args.kind === kind) ?? null;
    out.push({ kind: kind as DisclosureKind, text: d.text, criticalTokens: [...d.criticalTokens], atMs: call?.atMs ?? null });
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
export function keytermsOf(snapshot: Pick<CaseState, "fields"> | null, policy: PolicyRecord | null, max = 100): string[] {
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
  for (const f of Object.values(snapshot?.fields ?? {}) as (FieldState | undefined)[]) {
    if (!f || !KEYTERM_FIELDS.has(f.field)) continue;
    add(f.display ?? f.value);
  }
  if (policy) {
    add(`${policy.policyholder.firstName} ${policy.policyholder.lastName}`);
    for (const d of policy.existingDrivers) add(d.name);
    for (const v of policy.vehicles) add(`${v.make} ${v.model}`);
  }
  return out;
}

// ============================================================================================ the input

export interface QaSources {
  snapshot: Pick<CaseState, "fields">;
  policy: PolicyRecord;
  transcript: Pick<Transcript, "utterances" | "audio_duration">;
  timeline: VaTimeline | null;
  greeting: string | null;
  outcome: string | null;
  metrics: unknown;
  payment: PaymentFacts | null;
  durationSec: number | null;
}

export function buildQaInput(s: QaSources): Wp8QaInput {
  const { ch1, ch2 } = utterancesByChannel(s.transcript);
  const calls = toolCallsOf(s.timeline);
  const metrics = readMetrics(s.metrics);
  return {
    provisional: false,
    snapshot: { fields: s.snapshot.fields },
    policy: s.policy,
    ch2,
    ch1,
    toolCalls: calls.map((c) => ({ name: c.name, atMs: c.atMs })),
    disclosures: disclosuresOf(metrics, calls),
    greeting: s.greeting ?? "",
    // The recording starts with the spoken greeting on ch2, so it is never prepended here.
    prependGreeting: false,
    payment: paymentOf(s.payment),
    handedBack: s.outcome === "handed_back",
    aiSeconds: Math.round((s.durationSec ?? s.transcript.audio_duration ?? 0) * 1000) / 1000,
    latency: latencyOf(metrics),
  };
}
