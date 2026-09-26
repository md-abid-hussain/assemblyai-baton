"use client";
/**
 * client/studio/preview.ts - the Studio's **browser** compile (PLATFORM §7.3, SAAS §5.5 "Preview").
 *
 * `src/core` is isomorphic, so the browser runs the same kernel the server runs: `compileRelay` → the greeting for
 * the four canned states, the system prompt and tools per stage, the extractor prompt and strict schema, and the
 * first `session.update`. The server re-runs it on save and is authoritative; `hash` is what the two compare, and a
 * mismatch is a bug banner (`hashMismatch` in the shell), not a silent divergence.
 *
 * This mirrors `src/server/engine/compile-view.ts` field for field on purpose: the shapes the two produce have to be
 * comparable at a glance during a hash-mismatch investigation. It cannot import that module (it is `server-only`),
 * and it deliberately does not import `CompiledRelayView` either - the browser has no `deployId` and no kernel
 * binding, so the two views agree on content and not on provenance.
 */
import "client-only";

import {
  CANNED_STATES, KERNEL_VERSION, SECONDS_PER_WORD,
  type AccountRecord, type Blueprint, type CannedState, type CompiledListening, type UiSpec,
} from "@/core/contracts/v2";
import type { Stage } from "@/core/contracts/case";
import type { VaFunctionTool } from "@/core/contracts/tools";
import { cannedCaseState } from "@/core/relay/canned";
import { compileRelay } from "@/core/relay/compile";
import { assertStrictSchema } from "@/core/relay/extractor";

/** The canned state the per-stage prompt, tools and first update are shown for (the usual state at a pass). */
export const PREVIEW_STATE: CannedState = "one_pending";

/** The deploy marker the browser compile stamps into a prompt. It is never a real deployment id. */
export const PREVIEW_DEPLOY_ID = "preview";

export interface PreviewGreeting {
  state: CannedState;
  sampleIndex: number;
  text: string;
  wordCount: number;
  estSeconds: number;
}

export interface StudioPreview {
  hash: string;
  kernelVersion: string;
  ui: UiSpec;
  /** Every sample × the four canned states, in `CANNED_STATES` order. */
  greetings: PreviewGreeting[];
  prompts: { stage: Stage; chars: number; text: string }[];
  tools: { stage: Stage; tools: VaFunctionTool[] }[];
  extractor: {
    versionId: string;
    prompt: string;
    formatName: string;
    schema: Record<string, unknown>;
    strictOk: boolean;
    /** Why `assertStrictSchema` refused, when it did. */
    strictReason: string | null;
  };
  firstUpdate: { ok: boolean; reason: string | null };
  /** The merged keyterms, STT prompt, languages and tuning the first sample compiles to. */
  listening: CompiledListening;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500);

const round1 = (n: number): number => Math.round(n * 10) / 10;

export interface CompilePreviewOptions {
  /** The flagship drops the safety block (`relay/safety.ts`); everything else keeps it. */
  flagship?: boolean;
  /** Skip the hash recomputation when the caller already has one from `validateSource`. */
  hash?: string;
}

/**
 * Compile a blueprint for the Preview panel. It throws only when `compileRelay` itself throws (a blueprint that
 * passed zod but cannot be compiled); every *rendering* failure is captured in the view instead, so one broken
 * disclosure never blanks the whole panel.
 */
export function compilePreview(bp: Blueprint, opts: CompilePreviewOptions = {}): StudioPreview {
  const compiled = compileRelay(bp, { flagship: opts.flagship ?? false, ...(opts.hash ? { hash: opts.hash } : {}) });
  const samples = bp.context.samples as AccountRecord[];
  const account0 = samples[0] as AccountRecord;

  const greetings: PreviewGreeting[] = [];
  samples.forEach((account, sampleIndex) => {
    for (const state of CANNED_STATES) {
      try {
        const snapshot = cannedCaseState(compiled, account, state);
        const g = compiled.greeting(snapshot, account);
        greetings.push({ state, sampleIndex, text: g.text, wordCount: g.wordCount, estSeconds: round1(g.wordCount * SECONDS_PER_WORD) });
      } catch (e) {
        greetings.push({ state, sampleIndex, text: `— could not render: ${errText(e)}`, wordCount: 0, estSeconds: 0 });
      }
    }
  });

  const snapshot = cannedCaseState(compiled, account0, PREVIEW_STATE);
  const stages = compiled.ui.stages.map((s) => s.kind);
  const prompts = stages.map((stage) => {
    let text: string;
    try {
      text = compiled.prompt(snapshot, account0, stage, { deployId: PREVIEW_DEPLOY_ID });
    } catch (e) {
      text = `— could not render: ${errText(e)}`;
    }
    return { stage, chars: text.length, text };
  });
  const tools = stages.map((stage) => {
    try {
      return { stage, tools: compiled.tools(stage) };
    } catch {
      return { stage, tools: [] as VaFunctionTool[] };
    }
  });

  let firstUpdate: StudioPreview["firstUpdate"];
  try {
    compiled.takeover(snapshot, account0, { deployId: PREVIEW_DEPLOY_ID, compiledBy: "client" });
    firstUpdate = { ok: true, reason: null };
  } catch (e) {
    firstUpdate = { ok: false, reason: errText(e) };
  }

  const format = compiled.extractor.format;
  let strictOk = true;
  let strictReason: string | null = null;
  try {
    assertStrictSchema(format);
  } catch (e) {
    strictOk = false;
    strictReason = errText(e);
  }

  let listening: CompiledListening;
  try {
    listening = compiled.listening(account0);
  } catch {
    listening = { keyterms: [], prompt: "", languageCodes: ["en"], tuning: "telephony_8k" };
  }

  return {
    hash: compiled.hash,
    kernelVersion: KERNEL_VERSION,
    ui: compiled.ui,
    greetings,
    prompts,
    tools,
    extractor: {
      versionId: compiled.extractor.versionId,
      prompt: compiled.extractor.prompt,
      formatName: format.name,
      schema: format.schema,
      strictOk,
      strictReason,
    },
    firstUpdate,
    listening,
  };
}

/** The greeting to show for a canned state, preferring sample 0 (the one the Overview tab names). */
export function greetingFor(preview: StudioPreview, state: CannedState, sampleIndex = 0): PreviewGreeting | null {
  return preview.greetings.find((g) => g.state === state && g.sampleIndex === sampleIndex) ?? null;
}

/**
 * What a canned state is called in the product. Three tabs show the same four buttons (Preview, Configure's
 * greeting counter, Overview's "What the AI inherits"), so the wording lives with the model they all read.
 */
export const CANNED_STATE_LABEL: Readonly<Record<CannedState, string>> = Object.freeze({
  all_verified: "Everything verified",
  one_pending: "One pending",
  one_missing: "One missing",
  nothing: "Nothing captured",
});
