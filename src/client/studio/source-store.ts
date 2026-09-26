"use client";
/**
 * client/studio/source-store.ts - **one source of truth in the browser** (SAAS §5.5).
 *
 * Every tab of the Studio reads this store and writes through it, so the Code tab, the Configure forms and the
 * Preview panel can never disagree about what the relay currently says:
 *
 *   text  --parse(150 ms)-->  { blueprint, hash, diagnostics }  --compile-->  preview
 *          \--applyEdit(path,value)--/ (a FORM edit, so YAML comments survive)
 *
 * Rules this file implements, straight from §5.5:
 *  - a code edit re-parses and re-compiles, debounced 150 ms;
 *  - a form edit calls `applyEdit` and then re-parses;
 *  - **a syntax error makes the forms read-only** - `blueprint` keeps the LAST VALID parse so the forms still have
 *    something to show, and `formsUsable` is the flag they gate on;
 *  - autosave after 2 s of idle (and on Save) **when the text passes zod**; lint errors are allowed through, a
 *    zod-invalid text is never sent;
 *  - the unsaved text is mirrored into `localStorage` per viewer, in try/catch, and offered back after a reload;
 *  - a 409 puts the store in `conflict` with both texts, for the diff prompt.
 *
 * The store is a vanilla zustand store so it is testable without React (`tests/unit/studio/source-store.test.ts`);
 * `useSourceStore` in `./use-source-store.ts` binds it to a component tree. Time and I/O are injected
 * (`SourceStoreDeps`), because "2 s of idle" is exactly the kind of thing a test must be able to make instant.
 */
import "client-only";

import { createStore, type StoreApi } from "zustand/vanilla";

import type { Blueprint } from "@/core/contracts/v2";
import {
  applyEdit, convert, hasBlockingErrors, hasErrors, serialize, sniffFormat, validateSource,
  type CodeDiagnostic, type SourceFormat,
} from "@/core/relay-code";

import { compilePreview, type StudioPreview } from "./preview";

export type SaveOutcome =
  | { ok: true; rev: number; hash: string | null }
  | { ok: false; conflict: true; rev: number; theirText: string | null }
  | { ok: false; conflict?: false; message: string; readOnly?: boolean };

export interface SourceStoreDeps {
  /** `PUT /api/relays/:id/source` when WP14b·4 has landed it, `PUT …/draft` before that (`./api.ts`). */
  save(i: { relayId: string; format: SourceFormat; text: string; blueprint: Blueprint; expectedRev: number }): Promise<SaveOutcome>;
  /** `window.localStorage`, or null when the caller does not want a per-viewer mirror. */
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** §5.5: 150 ms for the parse, 2000 ms of idle for the autosave. Tests pass 0. */
  parseDebounceMs: number;
  autosaveIdleMs: number;
}

export type SaveStatus = "clean" | "dirty" | "saving" | "saved" | "invalid" | "conflict" | "error";

export interface SourceState {
  relayId: string;
  format: SourceFormat;
  /** What the editor shows. */
  text: string;
  /** What the server last acknowledged. */
  savedText: string;
  rev: number;
  /** The last text that parsed **and** passed zod; the forms and the preview read this. */
  blueprint: Blueprint | null;
  hash: string | null;
  diagnostics: CodeDiagnostic[];
  preview: StudioPreview | null;
  previewError: string | null;
  /** The hash the server reported for the same text; a mismatch is a bug banner (P§7.3). */
  serverHash: string | null;
  status: SaveStatus;
  message: string | null;
  /** Set when the server refused a save with 409: the diff prompt reads both sides. */
  conflict: { theirText: string | null; theirRev: number } | null;
  /** A newer unsaved text found in `localStorage` at mount, waiting for "Restore" / "Discard". */
  restorable: string | null;
  readOnly: boolean;
  flagship: boolean;
}

export interface SourceActions {
  /** A Code-tab edit. Schedules the parse and the autosave. */
  setText(text: string): void;
  /** A Configure-tab edit: `applyEdit` keeps the author's comments. `value === undefined` deletes the path. */
  applyFormEdit(path: (string | number)[], value: unknown): void;
  /**
   * Several form edits as one change: one parse, one autosave, one entry in the browser's undo of the text.
   * Move up/down is two writes and a field's type change is six, and neither is a sensible place to stop halfway.
   */
  applyFormEdits(edits: readonly { path: (string | number)[]; value: unknown }[]): void;
  /** The YAML ⇄ JSON toggle. A no-op when the text does not parse. */
  setFormat(format: SourceFormat): void;
  /** Re-serialize the canonical blueprint: "Format" in the Code tab. Comments are lost, so the UI confirms first. */
  formatDocument(): void;
  /** Replace the whole document (Import). */
  replaceText(text: string, format?: SourceFormat): void;
  /** Run the parse now, cancelling any pending debounce. */
  parseNow(): void;
  /** Save now (the Save button, Ctrl/⌘ S, and the idle autosave). */
  saveNow(): Promise<void>;
  /** The 409 prompt: keep the local text (and bump to their rev) or take theirs. */
  resolveConflict(choice: "mine" | "theirs"): void;
  /** The reload prompt. */
  restoreLocal(): void;
  discardLocal(): void;
  /** The server's own hash for the current text, for the mismatch banner. */
  setServerHash(hash: string | null): void;
  /** Stop the timers (component unmount). */
  dispose(): void;
}

export type SourceStore = StoreApi<SourceState & SourceActions>;

export interface CreateSourceStoreInput {
  relayId: string;
  text: string;
  format?: SourceFormat;
  rev: number;
  readOnly?: boolean;
  flagship?: boolean;
  deps: Partial<SourceStoreDeps> & Pick<SourceStoreDeps, "save">;
}

export const LOCAL_DRAFT_PREFIX = "changeover.studio.draft.";

const defaultDeps = (d: Partial<SourceStoreDeps>): Omit<SourceStoreDeps, "save"> => ({
  storage: d.storage !== undefined ? d.storage : safeStorage(),
  now: d.now ?? (() => Date.now()),
  setTimer: d.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
  clearTimer: d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
  parseDebounceMs: d.parseDebounceMs ?? 150,
  autosaveIdleMs: d.autosaveIdleMs ?? 2000,
});

/** `localStorage` throws in a private window and in some embedded views; a Studio that cannot mirror still works. */
function safeStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const probe = `${LOCAL_DRAFT_PREFIX}probe`;
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

/** True when the forms may edit: the text parses and passes zod right now (SAAS §5.5). */
export const formsUsable = (s: Pick<SourceState, "diagnostics" | "blueprint">): boolean =>
  s.blueprint !== null && !hasBlockingErrors(s.diagnostics);

/** The bar's wording: "Saved · rev 7" / "Unsaved: 2 errors to fix" (SAAS §5.5). */
export function savedStateLabel(s: Pick<SourceState, "status" | "rev" | "diagnostics">): string {
  const blocking = s.diagnostics.filter((d) => d.severity === "error" && d.source !== "lint").length;
  switch (s.status) {
    case "saving": return "Saving…";
    case "conflict": return "Saved elsewhere — merge your edits";
    case "invalid": return `Unsaved: ${blocking} ${blocking === 1 ? "error" : "errors"} to fix`;
    case "dirty": return "Unsaved changes";
    case "error": return "Not saved";
    default: return `Saved · rev ${s.rev}`;
  }
}

export function createSourceStore(input: CreateSourceStoreInput): SourceStore {
  const deps: SourceStoreDeps = { save: input.deps.save, ...defaultDeps(input.deps) };
  const key = `${LOCAL_DRAFT_PREFIX}${input.relayId}`;
  const format = input.format ?? sniffFormat(input.text);

  let parseTimer: unknown = null;
  let saveTimer: unknown = null;
  let saving = false;
  /** Bumped on every edit; a save that finishes against a stale generation does not claim "clean". */
  let generation = 0;

  const store = createStore<SourceState & SourceActions>((set, get) => {
    const cancel = () => {
      if (parseTimer !== null) deps.clearTimer(parseTimer);
      if (saveTimer !== null) deps.clearTimer(saveTimer);
      parseTimer = null;
      saveTimer = null;
    };

    const mirror = (text: string) => {
      if (!deps.storage) return;
      try {
        if (text === get().savedText) deps.storage.removeItem(key);
        else deps.storage.setItem(key, JSON.stringify({ text, rev: get().rev, at: deps.now() }));
      } catch {
        /* a full or blocked store is not an editing error */
      }
    };

    const runParse = (): void => {
      parseTimer = null;
      const { text, format: fmt, flagship } = get();
      const { blueprint, hash, diagnostics } = validateSource(text, fmt);
      if (blueprint === null) {
        // Keep the last good blueprint so the forms and the preview still render; they gate on `formsUsable`.
        set({ diagnostics, hash: null, status: statusFor(get(), diagnostics, text) });
        return;
      }
      let preview: StudioPreview | null = null;
      let previewError: string | null = null;
      try {
        preview = compilePreview(blueprint, { flagship, ...(hash ? { hash } : {}) });
      } catch (e) {
        previewError = e instanceof Error ? e.message : String(e);
      }
      set({ blueprint, hash, diagnostics, preview, previewError, status: statusFor(get(), diagnostics, text) });
    };

    const schedule = (): void => {
      generation += 1;
      if (parseTimer !== null) deps.clearTimer(parseTimer);
      if (deps.parseDebounceMs <= 0) runParse();
      else parseTimer = deps.setTimer(runParse, deps.parseDebounceMs);

      if (get().readOnly) return;
      if (saveTimer !== null) deps.clearTimer(saveTimer);
      if (deps.autosaveIdleMs > 0) saveTimer = deps.setTimer(() => void get().saveNow(), deps.autosaveIdleMs);
    };

    const edit = (text: string, format?: SourceFormat): void => {
      if (get().readOnly) return;
      set({ text, ...(format ? { format } : {}), status: "dirty", message: null, serverHash: null });
      mirror(text);
      schedule();
    };

    const first = validateSource(input.text, format);
    let firstPreview: StudioPreview | null = null;
    let firstPreviewError: string | null = null;
    if (first.blueprint) {
      try {
        firstPreview = compilePreview(first.blueprint, { flagship: input.flagship ?? false, ...(first.hash ? { hash: first.hash } : {}) });
      } catch (e) {
        firstPreviewError = e instanceof Error ? e.message : String(e);
      }
    }

    return {
      relayId: input.relayId,
      format,
      text: input.text,
      savedText: input.text,
      rev: input.rev,
      blueprint: first.blueprint,
      hash: first.hash,
      diagnostics: first.diagnostics,
      preview: firstPreview,
      previewError: firstPreviewError,
      serverHash: null,
      status: "clean",
      message: null,
      conflict: null,
      restorable: readRestorable(deps.storage, key, input.text),
      readOnly: input.readOnly ?? false,
      flagship: input.flagship ?? false,

      setText: (text) => edit(text),

      applyFormEdit: (path, value) => get().applyFormEdits([{ path, value }]),

      applyFormEdits: (edits) => {
        const s = get();
        if (s.readOnly || !formsUsable(s) || edits.length === 0) return;
        try {
          // Applied against the running text, not against `s.text`, so the second edit of a swap sees the first.
          let text = s.text;
          for (const e of edits) text = applyEdit(text, s.format, e.path, e.value);
          edit(text);
        } catch (e) {
          // All or nothing: a half-applied swap would be worse than a refused one, so `text` is only committed above.
          set({ message: e instanceof Error ? e.message : String(e) });
        }
      },

      setFormat: (next) => {
        const s = get();
        if (next === s.format) return;
        try {
          const text = convert(s.text, next);
          if (s.readOnly) set({ format: next, text });
          else edit(text, next);
        } catch (e) {
          set({ message: e instanceof Error ? e.message : String(e) });
        }
      },

      formatDocument: () => {
        const s = get();
        if (!s.blueprint) return;
        edit(serialize(s.blueprint, s.format));
      },

      replaceText: (text, fmt) => edit(text, fmt ?? sniffFormat(text)),

      parseNow: () => {
        if (parseTimer !== null) {
          deps.clearTimer(parseTimer);
          parseTimer = null;
        }
        runParse();
      },

      saveNow: async () => {
        if (saveTimer !== null) {
          deps.clearTimer(saveTimer);
          saveTimer = null;
        }
        get().parseNow();
        const s = get();
        if (s.readOnly || saving) return;
        if (s.text === s.savedText) {
          set({ status: "clean" });
          return;
        }
        // Zod (and a credential) block the save; lint errors do not (SAAS §5.2).
        if (s.blueprint === null || hasBlockingErrors(s.diagnostics)) {
          set({ status: "invalid" });
          return;
        }
        const mine = s.text;
        const at = ++generation;
        saving = true;
        set({ status: "saving", message: null });
        try {
          const r = await deps.save({ relayId: s.relayId, format: s.format, text: mine, blueprint: s.blueprint, expectedRev: s.rev });
          if (r.ok) {
            const stillCurrent = generation === at && get().text === mine;
            set({
              rev: r.rev,
              savedText: mine,
              serverHash: r.hash,
              status: stillCurrent ? "saved" : "dirty",
              message: null,
            });
            if (stillCurrent) mirror(mine);
          } else if (r.conflict) {
            set({ status: "conflict", conflict: { theirText: r.theirText, theirRev: r.rev }, message: "This relay was saved elsewhere." });
          } else {
            set({ status: "error", message: r.message, ...(r.readOnly ? { readOnly: true } : {}) });
          }
        } catch (e) {
          set({ status: "error", message: e instanceof Error ? e.message : String(e) });
        } finally {
          saving = false;
        }
      },

      resolveConflict: (choice) => {
        const s = get();
        if (!s.conflict) return;
        if (choice === "theirs" && s.conflict.theirText !== null) {
          set({ text: s.conflict.theirText, savedText: s.conflict.theirText, rev: s.conflict.theirRev, conflict: null, status: "clean" });
          mirror(s.conflict.theirText);
          get().parseNow();
          return;
        }
        // "Keep mine": adopt their rev so the next save is accepted, and leave the text dirty.
        set({ rev: s.conflict.theirRev, conflict: null, status: "dirty" });
      },

      restoreLocal: () => {
        const s = get();
        if (s.restorable === null) return;
        const text = s.restorable;
        set({ restorable: null });
        edit(text, sniffFormat(text));
      },

      discardLocal: () => {
        set({ restorable: null });
        try {
          deps.storage?.removeItem(key);
        } catch {
          /* ignore */
        }
      },

      setServerHash: (hash) => set({ serverHash: hash }),

      dispose: cancel,
    };
  });

  return store;
}

/** `dirty` unless the text is zod-invalid (then `invalid`), or identical to what the server holds (then `clean`). */
function statusFor(s: SourceState, diagnostics: CodeDiagnostic[], text: string): SaveStatus {
  if (s.status === "conflict" || s.status === "saving") return s.status;
  if (hasBlockingErrors(diagnostics)) return "invalid";
  if (text === s.savedText) return "clean";
  return s.status === "saved" ? "dirty" : s.status === "clean" ? "dirty" : s.status;
}

function readRestorable(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null,
  key: string,
  current: string,
): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { text?: unknown };
    const text = typeof parsed.text === "string" ? parsed.text : null;
    return text !== null && text !== current ? text : null;
  } catch {
    return null;
  }
}

/** A red-count for the lint badge: zod/syntax/codec errors first, then lint errors, then warnings. */
export function diagnosticCounts(diagnostics: readonly CodeDiagnostic[]): { errors: number; warnings: number; blocking: number } {
  let errors = 0;
  let warnings = 0;
  let blocking = 0;
  for (const d of diagnostics) {
    if (d.severity === "error") {
      errors += 1;
      if (d.source !== "lint") blocking += 1;
    } else warnings += 1;
  }
  return { errors, warnings, blocking };
}

export { hasErrors, hasBlockingErrors };
