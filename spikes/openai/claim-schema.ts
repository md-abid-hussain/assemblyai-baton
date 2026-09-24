/**
 * claim-schema.ts - strict JSON schema for a "claim fact graph" (parties, timestamped facts,
 * contradictions) + a transcript formatter + a scorer against fixtures/dialog_script.json ground truth.
 *
 * Strict-mode rules this schema follows (OpenAI Structured Outputs):
 *  - every object has additionalProperties:false and lists every property in `required`
 *  - "optional" fields are expressed as a union with "null"
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { JsonSchemaFormat } from "./client.ts";

const FACT_KINDS = [
  "identity",
  "policy_number",
  "claim_number",
  "incident_date",
  "incident_time",
  "incident_location",
  "injury",
  "liability",
  "damage_estimate",
  "cost",
  "deductible",
  "contact_phone",
  "address",
  "appointment",
  "other",
] as const;

export type FactKind = (typeof FACT_KINDS)[number];

export interface Party {
  id: string;
  name: string;
  role: "adjuster" | "claimant" | "third_party" | "organization" | "other";
  organization: string | null;
  speaker_label: string | null;
}

export interface Fact {
  id: string;
  kind: FactKind;
  subject_party_id: string | null;
  asserted_by_party_id: string;
  value: string;
  normalized: string | null;
  turn_index: number;
  start_ms: number;
  end_ms: number;
  quote: string;
}

export interface Contradiction {
  id: string;
  topic: string;
  fact_ids: string[];
  description: string;
  severity: "low" | "medium" | "high";
  flagged_in_call: boolean;
}

export interface ClaimFactGraph {
  parties: Party[];
  facts: Fact[];
  contradictions: Contradiction[];
  open_questions: string[];
}

const str = (description: string) => ({ type: "string", description });
const nstr = (description: string) => ({ type: ["string", "null"], description });

export const CLAIM_FACT_GRAPH_FORMAT: JsonSchemaFormat = {
  name: "claim_fact_graph",
  description: "Parties, timestamped facts and contradictions extracted from an insurance claim call.",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["parties", "facts", "contradictions", "open_questions"],
    properties: {
      parties: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "role", "organization", "speaker_label"],
          properties: {
            id: str("Short id, e.g. P1"),
            name: str("Full name as spoken"),
            role: { type: "string", enum: ["adjuster", "claimant", "third_party", "organization", "other"] },
            organization: nstr("Organization the party belongs to, if stated"),
            speaker_label: nstr("Transcript speaker label if this party speaks in the call, else null"),
          },
        },
      },
      facts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind", "subject_party_id", "asserted_by_party_id", "value", "normalized", "turn_index", "start_ms", "end_ms", "quote"],
          properties: {
            id: str("Short id, e.g. F1"),
            kind: { type: "string", enum: [...FACT_KINDS] },
            subject_party_id: nstr("Party the fact is about (party id) or null"),
            asserted_by_party_id: str("Party id of the speaker who stated the fact"),
            value: str("The fact as stated"),
            normalized: nstr(
              "Canonical form: IDs uppercase without spaces, dates YYYY-MM-DD, times HH:MM 24h, money as plain number of USD, phone as NNN-NNN-NNNN",
            ),
            turn_index: { type: "integer", description: "Transcript turn index where the fact is stated" },
            start_ms: { type: "integer", description: "Turn start time in ms (copy from the transcript)" },
            end_ms: { type: "integer", description: "Turn end time in ms (copy from the transcript)" },
            quote: str("Verbatim substring of that turn's text supporting the fact"),
          },
        },
      },
      contradictions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "topic", "fact_ids", "description", "severity", "flagged_in_call"],
          properties: {
            id: str("Short id, e.g. C1"),
            topic: str("What the conflicting statements are about"),
            fact_ids: { type: "array", items: { type: "string" }, description: "Ids of the conflicting facts" },
            description: str("One sentence explaining the conflict"),
            severity: { type: "string", enum: ["low", "medium", "high"] },
            flagged_in_call: { type: "boolean", description: "Did anyone on the call notice/raise it?" },
          },
        },
      },
      open_questions: { type: "array", items: { type: "string" }, description: "Follow-ups an investigator should ask" },
    },
  },
};

export const CLAIM_EXTRACTION_INSTRUCTIONS = [
  "You are a claims-investigation analyst. Build a fact graph from the call transcript.",
  "Extract every party (including people only mentioned), and every material fact with the turn index, the turn's start_ms/end_ms copied exactly, and a verbatim quote.",
  "List contradictions: statements by the same party that cannot both be true. Reference the conflicting fact ids.",
  "Use only the transcript. Do not invent facts.",
].join(" ");

// ---------------------------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------------------------

export interface DialogTurn {
  index: number;
  speaker: string;
  name: string;
  channel: string;
  text: string;
  start_ms: number;
  end_ms: number;
}

export interface DialogScript {
  turns: DialogTurn[];
  facts: Record<string, unknown>;
  speakers: Record<string, { name: string; role: string }>;
}

export function loadDialog(fixturesDir: string): DialogScript {
  return JSON.parse(readFileSync(resolve(fixturesDir, "dialog_script.json"), "utf8")) as DialogScript;
}

/** One line per turn: `[t3 13440-21660ms] claimant (Priya Shah): text` */
export function formatTranscript(d: DialogScript, callDate = "2026-09-24"): string {
  const header = `Call date: ${callDate}. Insurer: Harbor Point. Speakers: adjuster = Daniel Reyes, claimant = Priya Shah.`;
  const lines = d.turns.map((t) => `[t${t.index} ${t.start_ms}-${t.end_ms}ms] ${t.speaker} (${t.name}): ${t.text}`);
  return `${header}\n\nTranscript:\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------------------------
// Scoring against fixtures/dialog_script.json ground truth
// ---------------------------------------------------------------------------------------------

export interface ScoreItem {
  check: string;
  ok: boolean;
  detail?: string;
}

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D+/g, "");
const compact = (s: string | null | undefined) => (s ?? "").replace(/[\s-]+/g, "").toUpperCase();

export function scoreGraph(g: ClaimFactGraph, d: DialogScript): { score: number; total: number; items: ScoreItem[] } {
  const items: ScoreItem[] = [];
  const add = (check: string, ok: boolean, detail?: string) => items.push({ check, ok, ...(detail ? { detail } : {}) });
  const names = g.parties.map((p) => p.name.toLowerCase());
  for (const n of ["daniel reyes", "priya shah", "mark donnelly"]) add(`party ${n}`, names.some((x) => x.includes(n)));
  add("org Lakeside Auto Body", g.parties.some((p) => /lakeside/i.test(p.name) || /lakeside/i.test(p.organization ?? "")) || g.facts.some((f) => /lakeside/i.test(f.value)));
  const norm = g.facts.map((f) => ({ f, c: compact(f.normalized ?? f.value), dg: digits(f.normalized ?? f.value) }));
  add("policy HP7740391", norm.some((x) => x.c.includes("HP7740391")));
  add("claim CL44812", norm.some((x) => x.c.includes("CL44812")));
  add("phone 4155550137", norm.some((x) => x.dg.includes("4155550137")));
  for (const [label, amt] of [["repair 3450", "3450"], ["tow 125", "125"], ["deductible 500", "500"]] as const)
    add(`amount ${label}`, norm.some((x) => x.dg === amt || x.dg === `${amt}00`));
  add("date 2026-09-15", g.facts.some((f) => (f.normalized ?? "").includes("2026-09-15")));
  add("time 17:00 present", g.facts.some((f) => /17:00/.test(f.normalized ?? "") || /5\s*p\.?m/i.test(f.value)));
  add("time 19:00 present", g.facts.some((f) => /19:00/.test(f.normalized ?? "") || /7\s*p\.?m/i.test(f.value)));
  // contradiction linking turn 3 and turn 9
  const byId = new Map(g.facts.map((f) => [f.id, f]));
  const hit = g.contradictions.find((c) => {
    const turns = new Set(c.fact_ids.map((id) => byId.get(id)?.turn_index));
    return turns.has(3) && turns.has(9);
  });
  add("contradiction t3 vs t9 (5pm vs 7pm)", !!hit, hit ? `${hit.topic} / flagged_in_call=${hit.flagged_in_call}` : undefined);
  add("contradiction flagged_in_call=false", hit ? hit.flagged_in_call === false : false);
  // grounding: timestamps copied + quotes verbatim
  const turns = new Map(d.turns.map((t) => [t.index, t]));
  const badTs = g.facts.filter((f) => {
    const t = turns.get(f.turn_index);
    return !t || t.start_ms !== f.start_ms || t.end_ms !== f.end_ms;
  });
  add("all fact timestamps match their turn", badTs.length === 0, badTs.length ? `${badTs.length}/${g.facts.length} mismatched: ${badTs.slice(0, 3).map((f) => f.id).join(",")}` : `${g.facts.length} facts`);
  const badQuotes = g.facts.filter((f) => !(turns.get(f.turn_index)?.text ?? "").includes(f.quote));
  add("all quotes verbatim in their turn", badQuotes.length === 0, badQuotes.length ? `${badQuotes.length}/${g.facts.length} not verbatim: ${badQuotes.slice(0, 3).map((f) => `${f.id}:"${f.quote}"`).join(" ")}` : undefined);
  const score = items.filter((i) => i.ok).length;
  return { score, total: items.length, items };
}
