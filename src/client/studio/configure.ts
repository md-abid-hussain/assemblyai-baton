"use client";
/**
 * client/studio/configure.ts - the Configure tab's model (SAAS §5.5, WP15·2).
 *
 * The forms are a *view of the same text the Code tab edits*: every control writes through `applyEdit(path, value)`,
 * so a YAML author's comments survive a form edit and the two tabs can never hold different relays. That makes the
 * interesting part of Configure not the inputs but the small pure decisions around them, which live here so the
 * tests can drive them without a DOM:
 *
 *  - which sections have a form and which say "Edit in Code →", and the path each one jumps to;
 *  - which diagnostics belong to which control, so a zod or lint error can point at the input (acceptance 3);
 *  - Move up / Move down as two `applyEdit`s rather than a rewrite of the whole list, so only the two blocks that
 *    actually moved lose their comments;
 *  - the secret-reference picker's inventory, which is read out of the blueprint itself;
 *  - whether this plan may add an HTTP action (SAAS §5.6, Pro and Business).
 *
 * Nothing here touches React or the store.
 */
import "client-only";

import { wordsIn } from "@/core/compiler/greeting";
import type { Blueprint, Connector } from "@/core/contracts/v2/blueprint";
import type { PlanId } from "@/core/contracts/v3/identity";
import { PLANS } from "@/core/contracts/v3/plans";
import type { CodeDiagnostic } from "@/core/relay-code";

// `StageKind` and its label table live in `./overview`, which is the other half of this pair; defining the union
// twice would let the two tabs disagree about what a stage kind is.
import type { StageKind } from "./overview";

export type Path = (string | number)[];

// ============================================================================================ sections

export const CONFIGURE_SECTIONS = ["fields", "handoff", "greeting", "stages", "disclosures", "connectors"] as const;
export type ConfigureSectionId = (typeof CONFIGURE_SECTIONS)[number];

export interface ConfigureSection {
  id: ConfigureSectionId;
  title: string;
  blurb: string;
  /** The blueprint path this section owns; also what its diagnostics are matched against. */
  path: Path;
}

export const SECTIONS: readonly ConfigureSection[] = Object.freeze([
  { id: "fields", title: "Case fields", blurb: "What the assistant has to end the call holding.", path: ["fields"] },
  { id: "handoff", title: "Handoff", blurb: "The line the rep says, and what has to be true before they can pass.", path: ["handoff"] },
  { id: "greeting", title: "Greeting & voice", blurb: "The first thing the customer hears after the baton.", path: ["playbook", "greeting"] },
  { id: "stages", title: "Stages", blurb: "The order the assistant works in, and what it may call in each one.", path: ["playbook", "stages"] },
  { id: "disclosures", title: "Disclosures", blurb: "Text that is read word for word and has to be accepted.", path: ["playbook", "disclosures"] },
  { id: "connectors", title: "Connectors", blurb: "What the assistant can actually do: links, documents, messages, your endpoints.", path: ["connectors"] },
] as const);

/**
 * SAAS §5.5: "Listening, QA, extraction, compliance, the case JSON and the prompt template have **no form**: each
 * section shows 'Edit in Code →' jumping to its path."
 *
 * They are listed rather than hidden on purpose — a builder who cannot find the keyterms anywhere in Configure has
 * no way to learn that they exist, and the point of the tab is to be the map of the relay.
 */
export interface CodeOnlySection {
  title: string;
  path: Path;
  why: string;
}

export const CODE_ONLY_SECTIONS: readonly CodeOnlySection[] = Object.freeze([
  { title: "Listening", path: ["listening"], why: "Keyterms, the transcription prompt, languages and tuning." },
  { title: "Prompt template", path: ["playbook", "promptTemplate"], why: "Leave it empty and the kernel generates the prompt from everything else." },
  { title: "Case JSON", path: ["playbook", "caseJson"], why: "What the assistant is handed about the account, and how big it may be." },
  { title: "Named values", path: ["values"], why: "Constants a connector charges or reads, such as a deposit." },
  { title: "Sample accounts", path: ["context"], why: "The fictional accounts Preview and the simulator run against." },
  { title: "Quality checks", path: ["qa"], why: "Which fields are re-ask checked, and the advice lexicon." },
  { title: "Extraction", path: ["extraction"], why: "The extractor's domain and intent lines and its field guide." },
  { title: "Compliance", path: ["compliance"], why: "The patterns the greeting must match, and what is never collected." },
] as const);

// ============================================================================================ paths and diagnostics

/** `["playbook","stages",0,"goal"]` → `"playbook.stages.0.goal"`, the key a React list and a test both want. */
export const pathKey = (path: Path): string => path.join(".");

/** True when `path` is `prefix` or sits under it. */
export function pathStartsWith(path: readonly (string | number)[], prefix: Path): boolean {
  if (path.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (String(path[i]) !== String(prefix[i])) return false;
  return true;
}

export const samePath = (a: readonly (string | number)[], b: Path): boolean =>
  a.length === b.length && pathStartsWith(a, b);

export interface DiagnosticsAtOptions {
  /** "exact" for one input, "subtree" for a section header or a table row. */
  match?: "exact" | "subtree";
}

/**
 * The diagnostics that belong to a path. A zod issue on `fields[2].label` and a lint issue on `fields[2]` both have
 * to reach the row the builder is looking at, which is why "subtree" exists.
 */
export function diagnosticsAt(
  diagnostics: readonly CodeDiagnostic[],
  path: Path,
  options: DiagnosticsAtOptions = {},
): CodeDiagnostic[] {
  const subtree = options.match !== "exact";
  return diagnostics.filter((d) => (subtree ? pathStartsWith(d.path, path) : samePath(d.path, path)));
}

/** The worst severity in a set, for a section header's badge. `null` when the section is clean. */
export function worstSeverity(diagnostics: readonly CodeDiagnostic[]): "error" | "warn" | null {
  let seen: "error" | "warn" | null = null;
  for (const d of diagnostics) {
    if (d.severity === "error") return "error";
    seen = "warn";
  }
  return seen;
}

// ============================================================================================ list order

export type MoveDirection = "up" | "down";

/** The index an item moves to, or `null` when it is already at the end it is being pushed towards. */
export function moveTarget(length: number, index: number, direction: MoveDirection): number | null {
  const to = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || index >= length) return null;
  return to < 0 || to >= length ? null : to;
}

export interface Edit {
  path: Path;
  /** `undefined` deletes the path (`applyEdit`'s own convention). */
  value: unknown;
}

/**
 * Move up / Move down as **two writes**, not a rewrite of the list (SAAS §5.5: no drag-to-reorder, buttons only).
 *
 * `applyEdit(["fields"], wholeArray)` would work and would throw away every comment inside every field. Writing the
 * two swapped items individually keeps the rest of the list byte-identical, and the two that moved lose only their
 * own comments — which is the least a reorder can cost while the source is the canonical text.
 */
export function swapEdits<T>(base: Path, items: readonly T[], from: number, to: number): Edit[] {
  const a = items[from];
  const b = items[to];
  if (a === undefined || b === undefined) return [];
  return [
    { path: [...base, from], value: b },
    { path: [...base, to], value: a },
  ];
}

/** Append to a list: `applyEdit` on the index one past the end adds an item in both YAML and JSON. */
export const appendEdit = <T>(base: Path, items: readonly T[], value: T): Edit => ({ path: [...base, items.length], value });

export const removeEdit = (base: Path, index: number): Edit => ({ path: [...base, index], value: undefined });

// ============================================================================================ greeting

/** The kernel's own count (`core/compiler/greeting.ts`), so the counter cannot disagree with lint G2. */
export const countWords = wordsIn;

export type WordBudgetTone = "ok" | "close" | "over";

/** Under budget, within three words of it, or over. The greeting is spoken, so "close" is worth a colour. */
export function wordBudgetTone(words: number, maxWords: number): WordBudgetTone {
  if (words > maxWords) return "over";
  return words >= maxWords - 3 ? "close" : "ok";
}

// ============================================================================================ secrets

/** `SecretRefSchema`: `{ $secret: "sec_<16 lowercase alphanumerics>" }`. */
export const SECRET_ID_RE = /^sec_[a-z0-9]{16}$/;

export const isSecretRef = (v: unknown): v is { $secret: string } =>
  typeof v === "object" && v !== null && typeof (v as { $secret?: unknown }).$secret === "string";

/**
 * Every secret id the blueprint already references, sorted and de-duplicated.
 *
 * There is no "list this org's secrets" endpoint yet (the store is server-side, `src/server/secrets/**`), so the
 * picker offers what this relay already uses plus a checked free-text entry. A clone drops secret values and leaves
 * `null` behind (`SecretRebinder`, lint K2), which is exactly the case the picker exists for: the header is there,
 * the reference is gone, and the builder points it at one of the ids they can see.
 */
export function secretRefsIn(value: unknown, out: Set<string> = new Set()): string[] {
  if (Array.isArray(value)) {
    for (const v of value) secretRefsIn(v, out);
  } else if (isSecretRef(value)) {
    if (SECRET_ID_RE.test(value.$secret)) out.add(value.$secret);
  } else if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) secretRefsIn(v, out);
  }
  return [...out].sort();
}

// ============================================================================================ stages

export type Stage = Blueprint["playbook"]["stages"][number];
export type StageExit = Stage["exit"];

/** The order a call runs in, and therefore the order the toggles sit in and a new stage is inserted at. */
export const STAGE_ORDER: readonly StageKind[] = ["confirm", "disclose", "act", "close"];

export const STAGE_BLURB: Readonly<Record<StageKind, string>> = Object.freeze({
  confirm: "Read back what the rep already took, and fill in what is missing.",
  disclose: "Read a disclosure word for word and get a yes.",
  act: "Do the thing: charge, send, sign, call your endpoint.",
  close: "Say what happens next and end the call.",
});

/** The two tools every stage must keep (`StageSchema`: min 2, and lint requires both). */
export const REQUIRED_STAGE_TOOLS: readonly string[] = ["update_case_field", "hand_back_to_rep"];

export interface ToolOption {
  name: string;
  /** "a built-in tool", or the connector's label. */
  from: string;
  /** Never unchecked: `StageSchema` needs two tools and lint L4 needs these two. */
  required: boolean;
}

/**
 * Every tool name a stage may list, exactly as `lint.ts`'s `indexOf` builds it: the two built-ins, `get_disclosure`
 * only when the relay has a disclosure, each field's confirm tool, and one per tool-bearing connector.
 *
 * It is rebuilt from the blueprint rather than stored so that adding a connector immediately offers its tool in
 * every stage's checklist — the two are the same document.
 */
export function toolInventory(bp: Blueprint): ToolOption[] {
  const out: ToolOption[] = [
    { name: "update_case_field", from: "a built-in tool", required: true },
    { name: "hand_back_to_rep", from: "a built-in tool", required: true },
  ];
  if (bp.playbook.disclosures.length > 0) out.push({ name: "get_disclosure", from: "a built-in tool", required: false });
  for (const f of bp.fields) if (f.confirmTool) out.push({ name: f.confirmTool.name, from: `confirms ${f.label}`, required: false });
  for (const c of bp.connectors) if ("toolName" in c) out.push({ name: c.toolName, from: c.label, required: false });
  return out;
}

/**
 * Check or uncheck one tool in a stage, keeping the author's order (`StageSchema`: "ORDERED").
 *
 * A checked tool is appended rather than inserted at its inventory position, because the order is the order the
 * assistant is told to prefer and only the author knows what that should be.
 */
export function stageToolEdit(stageIndex: number, tools: readonly string[], name: string, on: boolean): Edit | null {
  const has = tools.includes(name);
  if (has === on) return null;
  if (!on && REQUIRED_STAGE_TOOLS.includes(name)) return null;
  const next = on ? [...tools, name] : tools.filter((t) => t !== name);
  if (next.length < 2 || next.length > 6) return null;
  return { path: ["playbook", "stages", stageIndex, "tools"], value: next };
}

/**
 * The exit condition, written as one value.
 *
 * `ExitSchema` is a discriminated union whose *keys change with the kind*, so a per-key write would leave a stale
 * `disclosure` next to a `connector` and fail zod between the two edits. One write of the whole object is both
 * correct and a single undo step.
 */
export function exitEdit(stageIndex: number, exit: StageExit): Edit {
  return { path: ["playbook", "stages", stageIndex, "exit"], value: exit };
}

/** The default exit for a kind, given what the relay actually has to point at. */
export function defaultExit(kind: StageKind, bp: Blueprint): StageExit {
  if (kind === "close") return { kind: "end" };
  const disclosure = bp.playbook.disclosures[0];
  if (kind === "disclose" && disclosure) return { kind: "disclosure_accepted", disclosure: disclosure.id };
  const connector = bp.connectors.find((c) => "toolName" in c);
  if (kind === "act" && connector) return { kind: "connector_succeeded", connector: connector.id };
  return { kind: "all_required_verified" };
}

const STAGE_SEED: Readonly<Record<StageKind, { id: string; label: string; goal: string; tools: string[] }>> = Object.freeze({
  confirm: {
    id: "confirm", label: "Confirm",
    goal: "Read back what the rep already took and confirm it. Ask for anything still missing, one thing at a time.",
    tools: ["update_case_field", "hand_back_to_rep"],
  },
  disclose: {
    id: "disclose", label: "Disclose",
    goal: "Read the disclosure word for word, then ask the customer to accept it. Do not paraphrase it.",
    tools: ["get_disclosure", "update_case_field", "hand_back_to_rep"],
  },
  act: {
    id: "act", label: "Act",
    goal: "Do what the call is for, then say plainly what you did.",
    tools: ["update_case_field", "hand_back_to_rep"],
  },
  close: {
    id: "close", label: "Close",
    goal: "Say what happens next in one sentence, thank the customer and end the call.",
    tools: ["update_case_field", "hand_back_to_rep"],
  },
});

/** A schema-valid stage of a kind, with its tools filtered to what this relay actually has. */
export function newStage(kind: StageKind, bp: Blueprint): Stage {
  const seed = STAGE_SEED[kind];
  const inventory = new Set(toolInventory(bp).map((t) => t.name));
  const tools = seed.tools.filter((t) => inventory.has(t));
  for (const t of REQUIRED_STAGE_TOOLS) if (!tools.includes(t)) tools.push(t);
  if (kind === "act") {
    const connector = bp.connectors.find((c) => "toolName" in c);
    if (connector && "toolName" in connector && tools.length < 6) tools.splice(0, 0, connector.toolName);
  }
  const taken = new Set(bp.playbook.stages.map((s) => s.id));
  let id = seed.id;
  for (let n = 2; taken.has(id) && n < 100; n++) id = `${seed.id}_${n}`;
  return { id, label: seed.label, kind, goal: seed.goal, tools: tools.slice(0, 6), exit: defaultExit(kind, bp) };
}

/**
 * Insert into a list as `applyEdit`s: append, then bubble up with swaps.
 *
 * `applyEdit` can set an index and can delete one, but it has no "insert at", and rewriting the whole list to make
 * room would discard the comments inside every item that did not move. Appending and swapping costs `2·(n-index)+1`
 * writes and touches only the items that actually shift.
 */
export function insertEdits<T>(base: Path, items: readonly T[], index: number, value: T): Edit[] {
  const at = Math.max(0, Math.min(index, items.length));
  // A working copy, updated as each swap is emitted: every swap has to read the list as the *previous* edits left
  // it, not as it was before the insert, or the second swap would put the wrong item back.
  const work: T[] = [...items, value];
  const out: Edit[] = [appendEdit(base, items, value)];
  for (let i = work.length - 1; i > at; i--) {
    out.push(...swapEdits(base, work, i, i - 1));
    const above = work[i] as T;
    work[i] = work[i - 1] as T;
    work[i - 1] = above;
  }
  return out;
}

/**
 * Turn a stage kind on or off (SAAS §5.5: "a toggle per kind").
 *
 * Off removes every stage of that kind — a relay can hold two `act` stages and a half-removed pair is not a state
 * anyone asked for — highest index first, so the earlier removals do not shift the later ones. `PlaybookSchema`
 * needs at least one stage, so the last one cannot be switched off and this returns `[]`.
 */
export function stageToggleEdits(bp: Blueprint, kind: StageKind, on: boolean): Edit[] {
  const base: Path = ["playbook", "stages"];
  const stages = bp.playbook.stages;
  const present = stages.filter((s) => s.kind === kind).length;
  if (on) {
    if (present > 0 || stages.length >= 4) return [];
    const rank = (k: StageKind) => STAGE_ORDER.indexOf(k);
    let index = stages.length;
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      if (s && rank(s.kind) > rank(kind)) {
        index = i;
        break;
      }
    }
    return insertEdits(base, stages, index, newStage(kind, bp));
  }
  if (present === 0 || present >= stages.length) return [];
  const out: Edit[] = [];
  for (let i = stages.length - 1; i >= 0; i--) if (stages[i]?.kind === kind) out.push(removeEdit(base, i));
  return out;
}

// ============================================================================================ disclosures

export type Disclosure = Blueprint["playbook"]["disclosures"][number];

/** A schema-valid disclosure. The text asks a question, because the stage exits on a yes. */
export function newDisclosure(taken: Iterable<string>): Disclosure {
  const used = new Set(taken);
  let id = "disclosure";
  for (let n = 2; used.has(id) && n < 100; n++) id = `disclosure_${n}`;
  return {
    id,
    title: "New disclosure",
    text: "SAMPLE TEXT. Replace this with the wording your compliance team signed off, word for word. Is that okay with you?",
    criticalTokens: [],
    requiresReady: false,
    requiresAccepted: null,
    consent: false,
  };
}

// ============================================================================================ connectors

export type ConnectorType = Connector["type"];

export const CONNECTOR_TYPE_LABELS: Readonly<Record<ConnectorType, string>> = Object.freeze({
  payment_link: "Payment link",
  esign_mock: "Document to sign",
  sms_mock: "Text message",
  http_action: "HTTP action",
  lookup_table: "Lookup table",
  completion_webhook: "Completion webhook",
  confirmation: "Confirmation",
});

/** Only `http_action` and `completion_webhook` leave our origin, and only the first is addable from the forms. */
export const CONNECTOR_LEAVES_ORIGIN: Readonly<Record<ConnectorType, boolean>> = Object.freeze({
  payment_link: false,
  esign_mock: false,
  sms_mock: false,
  http_action: true,
  lookup_table: false,
  completion_webhook: true,
  confirmation: false,
});

/**
 * SAAS §5.6: HTTP actions to the org's own hosts are a Pro and Business capability, and `PLANS` is the one table
 * that says so. `null` is the pre-SaaS world this code still runs in (no principal, no plan): there is no plan layer
 * to gate on yet, so nothing is hidden. WP21's entitlement view replaces the `null` when it lands.
 */
export const canAddHttpAction = (plan: PlanId | null): boolean => (plan === null ? true : PLANS[plan].limits.httpAction);

/** A schema-valid `http_action` skeleton the builder then points at their own endpoint. */
export function newHttpAction(taken: Iterable<string>): Extract<Connector, { type: "http_action" }> {
  const used = new Set(taken);
  let id = "http_action";
  let toolName = "call_my_endpoint";
  for (let n = 2; used.has(id) && n < 100; n++) id = `http_action_${n}`;
  for (let n = 2; used.has(toolName) && n < 100; n++) toolName = `call_my_endpoint_${n}`;
  return {
    type: "http_action",
    id,
    label: "My endpoint",
    toolName,
    description: "Calls our own endpoint and returns what it answers. Replace this description: the assistant reads it to decide when to call.",
    method: "POST",
    url: "https://example.com/changeover",
    params: { type: "object", required: [], properties: {} },
    headers: [],
    hmacSecret: null,
    timeoutMs: 2500,
    responsePick: [],
    sideEffect: false,
  };
}
