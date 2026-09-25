/**
 * client/session/provisional-qa.ts - the QA card's PROVISIONAL numbers (DESIGN §1.3 P1 step 8, S3): computed on the
 * page the moment the AI half ends, from the Voice Agent's own `transcript.agent` captions and tool rail, with the
 * same deterministic engine the server runs on the async ch2 transcript (WP1 `computeQa`). WP8's verified result
 * replaces it 15–25 s later ("✓ Verified from recording").
 *
 * The clock is the page clock relative to the arm (captions and tool results share it), so each disclosure's search
 * window (§5.13 step 6.2) still anchors on its `get_disclosure` result. Critical tokens are read back from WP1's
 * deterministic disclosure templates; when a text does not match them the check falls back to similarity alone.
 */
import "client-only";

import type { CaseState, DisclosureKind, PolicyRecord } from "@/core/contracts/case";
import { DISCLOSURE_KINDS } from "@/core/contracts/case";
import type { QaResult } from "@/core/contracts/events";
import { TOOL_NAMES, type ToolName } from "@/core/contracts/tools";
import { computeQa, type QaDisclosure, type QaInput } from "@/core/qa";

import type { UiState } from "../store/reduce";

/** The critical tokens of a disclosure text, read back from WP1's templates (src/core/compiler/disclosures.ts). */
export function criticalTokensOf(kind: DisclosureKind, text: string, policy: PolicyRecord | null): string[] {
  if (kind === "esign_consent") {
    const last4 = /ending in ([^,]+),/.exec(text)?.[1]?.trim();
    const out = ["electronically", "paper copy"];
    if (last4) out.unshift(last4);
    else if (policy) out.unshift(policy.phoneOnFileLast4.split("").join(" "));
    return out;
  }
  const monthly = /premium is (.+?) a month/.exec(text)?.[1];
  const due = /, and (.+?) is due today/.exec(text)?.[1];
  const date = /, starting (.+?)\. Your new premium/.exec(text)?.[1];
  const name = /We're adding (\S+)/.exec(text)?.[1];
  return [monthly, due, date, name].filter((x): x is string => !!x && x !== "the");
}

const isToolName = (n: string): n is ToolName => (TOOL_NAMES as readonly string[]).includes(n);

const PAYMENT: Record<string, QaResult["payment"]> = { webhook: "verified_webhook", server_poll: "verified_poll", mock: "simulated" };

/** The QA input of the pass that started at page time `armedT`, from the console state. Null before any pass. */
export function provisionalQaInput(s: UiState, snapshot: Pick<CaseState, "fields"> | null): QaInput | null {
  const t0 = s.takeover.armedT;
  const policy = s.context?.policy ?? null;
  const snap = snapshot ?? s.caseState;
  if (t0 === null || !policy || !snap) return null;
  const rel = (t: number) => Math.max(0, t - t0);
  const lines = s.ai.filter((l) => l.lane === "ai" && l.t >= t0 && l.kind !== "tool_preamble" && l.kind !== "unspoken_text" && l.text.trim());
  const tools = s.tools.filter((x) => x.t >= t0);
  const disclosures: QaDisclosure[] = [];
  for (const x of tools) {
    if (x.name !== "get_disclosure" || !x.result || typeof x.result !== "object") continue;
    const r = x.result as { ok?: unknown; text?: unknown; kind?: unknown };
    const kind = (x.args as { kind?: unknown } | null)?.kind ?? r.kind;
    if (r.ok === false || typeof r.text !== "string" || !(DISCLOSURE_KINDS as readonly unknown[]).includes(kind)) continue;
    if (disclosures.some((d) => d.kind === kind)) continue; // idempotent per kind: the first read counts
    disclosures.push({ kind: kind as DisclosureKind, text: r.text, criticalTokens: criticalTokensOf(kind as DisclosureKind, r.text, policy), atMs: rel(x.tResult ?? x.t) });
  }
  const paid = s.payment?.status === "succeeded";
  const simulated = !!s.caseState?.payment?.simulated;
  const payment: QaResult["payment"] = !paid ? "unpaid" : simulated ? "simulated" : (PAYMENT[s.payment?.source ?? ""] ?? "verified_poll");
  const start = s.takeover.connectedT ?? t0;
  const end = Math.max(start, lines.at(-1)?.t ?? start, s.t);
  const last = (m: keyof UiState["hud"]) => s.hud[m]?.last ?? null;
  return {
    provisional: true,
    snapshot: snap,
    policy,
    ch2: lines.map((l) => ({ text: l.text, startMs: rel(l.t) })),
    toolCalls: tools.filter((x) => isToolName(x.name)).map((x) => ({ name: x.name, atMs: rel(x.t) })),
    disclosures,
    greeting: lines[0]?.text ?? "",
    prependGreeting: false,
    payment,
    handedBack: !!s.handBack && s.handBack.t >= t0,
    aiSeconds: Math.round((end - start) / 1000),
    latency: {
      clickToFirstAudibleMs: last("click_to_first_audible"),
      deadAirAfterRepMs: last("dead_air_after_rep"),
      turnLatencyP50Ms: s.hud.turn_audible_latency?.p50 ?? null,
    },
  };
}

/** Provisional QA for the latest pass, or null when there is nothing to score yet (no pass, no AI line). */
export function provisionalQa(s: UiState, snapshot: Pick<CaseState, "fields"> | null): QaResult | null {
  const input = provisionalQaInput(s, snapshot);
  if (!input || input.ch2.length === 0) return null;
  return computeQa(input);
}
