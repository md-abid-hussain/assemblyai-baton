"use client";
/**
 * client/studio/overview.ts - the Overview tab's model (SAAS §5.5, WP15·2).
 *
 * Overview answers one question — *what happens on this call, and where does the baton change hands* — and it
 * answers it from the blueprint alone, read-only. This module turns a `Blueprint` into that track so the component
 * is only layout and the shape can be asserted in a unit test:
 *
 *     rep lane ──▶ ⟨Pass the baton⟩ ──▶ confirm ─▶ disclose ─▶ act ─▶ close
 *     what the rep    the line, the       each stage with its goal, the tools it may
 *     already holds   acceptance, the     call and the condition that ends it
 *                     gate before Pass
 *
 * "What the AI inherits" is the greeting for a canned state, which the Preview compile already has; Overview shows
 * the sentence and the two numbers that decide whether it works on a phone (words, and seconds at 0.34 s/word).
 */
import "client-only";

import type { Blueprint, BlueprintField } from "@/core/contracts/v2/blueprint";
import type { CodeDiagnostic } from "@/core/relay-code";

import { lineHash } from "./code-target";

export type StageKind = Blueprint["playbook"]["stages"][number]["kind"];

export const STAGE_KIND_LABEL: Readonly<Record<StageKind, string>> = Object.freeze({
  confirm: "Confirm",
  disclose: "Disclose",
  act: "Act",
  close: "Close",
});

export const SET_BY_LABEL: Readonly<Record<BlueprintField["setBy"], string>> = Object.freeze({
  rep_only: "Rep only",
  ai_allowed: "Rep or assistant",
  rep_or_customer: "Rep or customer",
});

export interface TrackField {
  id: string;
  label: string;
  type: string;
  required: boolean;
  setBy: BlueprintField["setBy"];
  /** A rep decision the assistant never raises or changes (P§3.2). */
  adviceDomain: boolean;
  /** Listed in `handoff.allowedWhen.requireVerified`: the Pass button stays disabled until it is verified. */
  gatesPass: boolean;
  /** Never asked: a named value supplies it. */
  serverResolved: boolean;
}

export interface TrackStage {
  id: string;
  kind: StageKind;
  label: string;
  goal: string;
  tools: string[];
  /** "when every required field is verified", "when Deposit terms is accepted", … */
  exit: string;
  /** The disclosure a `disclose` stage reads, when the exit names one. */
  disclosureTitle: string | null;
}

export interface RelayTrack {
  rep: {
    /** What the rep holds before the baton: everything they may set, in capture order. */
    fields: TrackField[];
    minCallSeconds: number;
    /** Labels of the fields that must be verified before Pass is enabled. */
    gates: string[];
  };
  baton: {
    repLine: string;
    acceptance: string;
    autoBaton: boolean;
    repReturnLine: string;
  };
  stages: TrackStage[];
  /** Fields the assistant itself may write with `update_case_field`. */
  aiWrites: TrackField[];
  connectors: { id: string; type: string; label: string; toolName: string | null }[];
}

/** `["a","b"]` → "a and b"; `["a","b","c"]` → "a, b and c". Used in the exit sentences. */
export function joinWords(parts: readonly string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1] as string}`;
}

/** The end condition of a stage, as the sentence Overview prints. */
export function exitLabel(exit: Blueprint["playbook"]["stages"][number]["exit"], bp: Blueprint): string {
  switch (exit.kind) {
    case "all_required_verified":
      return "when every required field is verified";
    case "disclosure_accepted": {
      const d = bp.playbook.disclosures.find((x) => x.id === exit.disclosure);
      return `when ${d ? d.title : exit.disclosure} is accepted`;
    }
    case "connector_succeeded": {
      const c = bp.connectors.find((x) => x.id === exit.connector);
      return `when ${c ? c.label : exit.connector} succeeds`;
    }
    case "end":
      return "then the call ends";
  }
}

const toTrackField = (f: BlueprintField, gates: ReadonlySet<string>): TrackField => ({
  id: f.id,
  label: f.label,
  type: f.type,
  required: f.required,
  setBy: f.setBy,
  adviceDomain: f.adviceDomain,
  gatesPass: gates.has(f.id),
  serverResolved: f.serverResolvable !== undefined,
});

/** The whole track, in the order the call runs. Pure: same blueprint in, same object out. */
export function buildTrack(bp: Blueprint): RelayTrack {
  const gates = new Set(bp.handoff.allowedWhen.requireVerified);
  const fields = [...bp.fields].sort((a, b) => a.capture.priority - b.capture.priority);
  const rep = fields.filter((f) => f.setBy !== "ai_allowed" || f.adviceDomain).map((f) => toTrackField(f, gates));
  const aiWrites = fields.filter((f) => f.setBy === "ai_allowed" && !f.adviceDomain).map((f) => toTrackField(f, gates));
  return {
    rep: {
      fields: rep,
      minCallSeconds: bp.handoff.allowedWhen.minCallSeconds,
      gates: [...gates].map((id) => bp.fields.find((f) => f.id === id)?.label ?? id),
    },
    baton: {
      repLine: bp.handoff.repLine,
      acceptance: bp.handoff.acceptance.phrase,
      autoBaton: bp.handoff.autoBaton,
      repReturnLine: bp.handoff.repReturnLine,
    },
    stages: bp.playbook.stages.map((s) => {
      // Hoisted so the discriminant narrows inside the `find` closure: `s.exit` is a mutable property access, and
      // TS widens it straight back to the full union there.
      const exit = s.exit;
      return {
        id: s.id,
        kind: s.kind,
        label: s.label,
        goal: s.goal,
        tools: [...s.tools],
        exit: exitLabel(exit, bp),
        disclosureTitle:
          exit.kind === "disclosure_accepted"
            ? (bp.playbook.disclosures.find((d) => d.id === exit.disclosure)?.title ?? exit.disclosure)
            : null,
      };
    }),
    aiWrites,
    connectors: bp.connectors.map((c) => ({
      id: c.id,
      type: c.type,
      label: c.label,
      toolName: "toolName" in c ? c.toolName : null,
    })),
  };
}

// ============================================================================================ the lint summary

export interface LintSummary {
  /** Zod, syntax and codec errors: these block Save. */
  blocking: number;
  /** Lint errors: these block Test and Publish, not Save (SAAS §5.2). */
  lintErrors: number;
  warnings: number;
  /** Everything, in the order a builder fixes it, capped by the caller. */
  items: CodeDiagnostic[];
}

const RANK: Record<string, number> = { syntax: 0, schema: 1, codec: 2, lint: 3 };

/** The same ordering the Code tab's list uses, so the two never disagree about what is "first". */
export function lintSummary(diagnostics: readonly CodeDiagnostic[]): LintSummary {
  let blocking = 0;
  let lintErrors = 0;
  let warnings = 0;
  for (const d of diagnostics) {
    if (d.severity !== "error") warnings += 1;
    else if (d.source === "lint") lintErrors += 1;
    else blocking += 1;
  }
  const items = [...diagnostics].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    const ra = RANK[a.source] ?? 9;
    const rb = RANK[b.source] ?? 9;
    if (ra !== rb) return ra - rb;
    return (a.range?.startLine ?? 0) - (b.range?.startLine ?? 0);
  });
  return { blocking, lintErrors, warnings, items };
}

/**
 * The link a lint summary row points at: the Code tab, with the range in the fragment. The fragment's shape is
 * `./code-target.ts`'s contract, shared with Configure's "Edit in Code →" and consumed once by the Code tab.
 */
export function codeHref(relayId: string, diagnostic: Pick<CodeDiagnostic, "range">): string {
  const base = `/app/relays/${encodeURIComponent(relayId)}/code`;
  if (!diagnostic.range) return base;
  // `startCol` is 0-based in the codec; a caret is 1-based (`wp23-to-wp15.md` §3).
  return `${base}${lineHash(diagnostic.range.startLine, diagnostic.range.startCol + 1)}`;
}
