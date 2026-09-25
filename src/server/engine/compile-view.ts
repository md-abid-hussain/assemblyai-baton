import "server-only";

import type { KernelBinding } from "../../core/contracts/ext/wp14b-engine";
import {
  CANNED_STATES, SECONDS_PER_WORD, type AccountRecord, type Blueprint, type CannedState, type CompiledRelay,
  type CompiledRelayView, type LintIssue,
} from "../../core/contracts/v2";

/**
 * `GET /api/relays/:id/compiled` (PLATFORM §7.3): the server's authoritative compile of a version or a draft, in the
 * shape the Studio compares with its own browser compile (`hash` first; a mismatch is a bug banner).
 *
 * - `greetings`: every blueprint sample × the 4 canned states (lint G2's set), with word count and seconds;
 * - `prompts` / `tools`: per runtime stage of the relay, for sample 0 in the `one_pending` canned state (the usual
 *   state at a pass);
 * - `extractor`: the generated strict format, with `strictOk` from the OpenAI strict-mode rules (every object closed,
 *   every property required);
 * - `firstUpdate`: `compiled.takeover(...)` for that same snapshot, which runs `validateFirstUpdate`; a throw is
 *   `{ok: false, reason}`, never a 500.
 */
export interface CompileViewInput {
  relayId: string;
  versionId: string | null;
  blueprint: Blueprint;
  lint: LintIssue[];
  compiled: CompiledRelay;
  binding: Pick<KernelBinding, "kernelVersion" | "cannedSnapshot">;
  deployId: string;
}

/** The canned state the per-stage prompt, tools and first update are shown for. */
export const VIEW_STATE: CannedState = "one_pending";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500);

export function compiledRelayView(i: CompileViewInput): CompiledRelayView {
  const { compiled, binding } = i;
  const samples = i.blueprint.context.samples;
  const account0 = samples[0] as AccountRecord;
  const greetings: CompiledRelayView["greetings"] = [];
  samples.forEach((account, sampleIndex) => {
    for (const state of CANNED_STATES) {
      const g = compiled.greeting(binding.cannedSnapshot(compiled, account, state), account);
      greetings.push({ state, sampleIndex, text: g.text, wordCount: g.wordCount, estSeconds: Math.round(g.wordCount * SECONDS_PER_WORD * 10) / 10 });
    }
  });
  const snapshot = binding.cannedSnapshot(compiled, account0, VIEW_STATE);
  const stages = compiled.ui.stages.map((s) => s.kind);
  const prompts = stages.map((stage) => {
    const text = compiled.prompt(snapshot, account0, stage, { deployId: i.deployId });
    return { stage, chars: text.length, text };
  });
  const tools = stages.map((stage) => ({ stage, tools: compiled.tools(stage) }));
  let firstUpdate: CompiledRelayView["firstUpdate"];
  try {
    compiled.takeover(snapshot, account0, { deployId: i.deployId, compiledBy: "server" });
    firstUpdate = { ok: true, reason: null };
  } catch (e) {
    firstUpdate = { ok: false, reason: errText(e) };
  }
  const f = compiled.extractor.format;
  return {
    relayId: i.relayId,
    versionId: i.versionId,
    hash: compiled.hash,
    kernelVersion: binding.kernelVersion,
    lint: i.lint,
    ui: compiled.ui,
    listening: compiled.listening(account0),
    greetings,
    prompts,
    tools,
    extractor: { versionId: compiled.extractor.versionId, prompt: compiled.extractor.prompt, formatName: f.name, schema: f.schema, strictOk: strictSchemaErrors(f.schema).length === 0 },
    firstUpdate,
  };
}

/**
 * OpenAI strict-mode violations of a JSON schema (structured outputs): every `object` needs `additionalProperties:
 * false` and lists every property in `required`. Returns paths; [] = strict-compatible.
 */
export function strictSchemaErrors(schema: unknown, path = "$"): string[] {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema)) return schema.flatMap((s, k) => strictSchemaErrors(s, `${path}[${k}]`));
  const o = schema as Record<string, unknown>;
  const out: string[] = [];
  const isObject = o.type === "object" || (Array.isArray(o.type) && o.type.includes("object"));
  if (isObject) {
    if (o.additionalProperties !== false) out.push(`${path}: additionalProperties must be false`);
    const props = o.properties && typeof o.properties === "object" ? Object.keys(o.properties as object) : [];
    const req = Array.isArray(o.required) ? new Set(o.required as unknown[]) : new Set<unknown>();
    for (const k of props) if (!req.has(k)) out.push(`${path}.${k}: not in required`);
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === "properties" && v && typeof v === "object") {
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) out.push(...strictSchemaErrors(pv, `${path}.${pk}`));
    } else if (k === "items" || k === "anyOf" || k === "oneOf" || k === "allOf" || k === "$defs" || k === "definitions") {
      if (k === "$defs" || k === "definitions") {
        for (const [dk, dv] of Object.entries((v ?? {}) as Record<string, unknown>)) out.push(...strictSchemaErrors(dv, `${path}.${k}.${dk}`));
      } else {
        out.push(...strictSchemaErrors(v, `${path}.${k}`));
      }
    }
  }
  return out;
}
