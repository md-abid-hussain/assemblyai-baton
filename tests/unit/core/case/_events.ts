/** Fact-event builders for the WP1 derivation tests (not a test file). */
import type { Evidence, FactEvent, FieldId, Party } from "../../../../src/core/contracts";
import type { DerivableEvent } from "../../../../src/core/case/status-rules";

let counter = 0;

export interface EvSpec {
  field: FieldId;
  kind: FactEvent["kind"];
  party: Party;
  value?: string | null;
  t: number;
  seq?: number;
  ack?: string | null;
  turnId?: string | null;
  late?: boolean;
  cut?: boolean;
  confidence?: FactEvent["confidence"];
  evidence?: Evidence | null;
}

/** A fact event with `valueRaw = valueNorm = value` (values are already normalized). */
export function ev(s: EvSpec): DerivableEvent & { seq: number } {
  const seq = s.seq ?? ++counter;
  const channel = s.party === "rep" || s.party === "customer" ? s.party : "ai";
  const turnId = s.turnId !== undefined ? s.turnId : s.party === "rep" || s.party === "customer" ? `${s.party}-${seq}` : null;
  const evidence: Evidence | null = s.evidence !== undefined ? s.evidence
    : turnId ? { channel, turnId, startMs: s.t - 500, endMs: s.t, quote: String(s.value ?? "yes"), source: "stt_live" } : null;
  return {
    id: `e${seq}`,
    caseId: "c1",
    field: s.field,
    kind: s.kind,
    party: s.party,
    valueRaw: s.value ?? null,
    valueNorm: s.value ?? null,
    acknowledgesTurnId: s.ack ?? null,
    confidence: s.confidence ?? "high",
    turnId,
    turnEndMs: s.t,
    late: s.late ?? false,
    cut: s.cut ?? false,
    evidence,
    extractor: s.kind === "verifier" ? "sol" : s.kind === "tool_update" ? "tool" : s.kind === "policy" ? "policy" : "luna",
    seq,
  };
}
