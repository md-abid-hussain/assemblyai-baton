"use client";
/**
 * components/studio/configure/controls.tsx - the inputs every Configure section is built from (SAAS §5.5, WP15·2).
 *
 * Two rules decide the whole design of this file.
 *
 * **1. A control writes to the document, not to component state.** Its value comes from the parsed blueprint in the
 * source store and its change goes back through `applyEdit(path, value)`, which keeps the author's YAML comments.
 * So there is no form state to keep in step and no "save the form" button: Configure and Code are two views of one
 * string.
 *
 * **2. A text input commits on blur, not on keystroke.** Every commit re-serializes the document, re-parses it and
 * re-compiles the preview; doing that per keystroke would rewrite a 600-line YAML file sixty times a second and
 * move the caret under the typist. `useDraftValue` therefore holds the keystrokes locally and commits on blur or
 * Enter, and re-syncs whenever the document changes underneath (a Code-tab edit, a restore, a conflict resolution)
 * while the input is not focused.
 *
 * Errors are shown on the control itself, which is the other half of acceptance 3: a lint or zod error links to the
 * offending range in Code **or the input in Configure**.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { diagnosticsAt, pathKey, worstSeverity, type Path } from "@/client/studio/configure";
import { useSource, useSourceActions } from "@/client/studio/use-source-store";
import type { CodeDiagnostic } from "@/core/relay-code";
import { cn } from "@/lib/utils";

const INPUT_CLASS =
  "focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60";

/** True when the forms may be typed in: the text parses, passes zod, and this viewer may edit. */
export function useFormsEditable(): boolean {
  const readOnly = useSource((s) => s.readOnly);
  const blueprint = useSource((s) => s.blueprint);
  const diagnostics = useSource((s) => s.diagnostics);
  const blocking = diagnostics.some((d) => d.severity === "error" && d.source !== "lint");
  return !readOnly && blueprint !== null && !blocking;
}

/** The diagnostics attached to one path, for the message under a control. */
export function usePathDiagnostics(path: Path, match: "exact" | "subtree" = "subtree"): CodeDiagnostic[] {
  const diagnostics = useSource((s) => s.diagnostics);
  return diagnosticsAt(diagnostics, path, { match });
}

export function DiagnosticText({ diagnostics }: { diagnostics: readonly CodeDiagnostic[] }) {
  if (diagnostics.length === 0) return null;
  const severity = worstSeverity(diagnostics);
  return (
    <ul className={cn("mt-1 space-y-0.5 text-xs", severity === "error" ? "text-destructive" : "text-amber-700 dark:text-amber-400")}>
      {diagnostics.slice(0, 3).map((d, i) => (
        <li key={`${d.code}-${i}`}>
          {d.message} <span className="opacity-70">({d.code})</span>
        </li>
      ))}
    </ul>
  );
}

export interface RowProps {
  label: string;
  hint?: ReactNode;
  path: Path;
  /** "exact" when a sibling control owns the children of this path. */
  match?: "exact" | "subtree";
  children: ReactNode;
  className?: string;
}

/** A labelled control with its own diagnostics underneath. */
export function Row({ label, hint, path, match = "subtree", children, className }: RowProps) {
  const diagnostics = usePathDiagnostics(path, match);
  return (
    <div className={cn("min-w-0", className)}>
      <label className="block text-sm" htmlFor={pathKey(path)}>
        <span className="mb-1 block font-medium">{label}</span>
        {children}
      </label>
      {hint ? <p className="text-muted-foreground mt-1 text-xs">{hint}</p> : null}
      <DiagnosticText diagnostics={diagnostics} />
    </div>
  );
}

/**
 * Local keystrokes, committed on blur. `external` re-seeds the box whenever the document changes and the box is not
 * being typed in, so a Code-tab edit shows up in the forms immediately and an in-progress word is never stolen.
 */
export function useDraftValue<T extends string | number>(external: T, commit: (v: T) => void) {
  const [draft, setDraft] = useState<T>(external);
  const focused = useRef(false);
  const last = useRef<T>(external);
  useEffect(() => {
    if (!focused.current && external !== last.current) setDraft(external);
    last.current = external;
  }, [external]);
  return {
    value: draft,
    setDraft,
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      if (draft !== external) commit(draft);
    },
  };
}

export interface TextControlProps {
  path: Path;
  value: string;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
  /** A monospace box for templates and patterns. */
  mono?: boolean;
  maxLength?: number;
}

export function TextControl({ path, value, disabled, placeholder, rows, mono, maxLength }: TextControlProps) {
  const actions = useSourceActions();
  const draft = useDraftValue(value, (v) => actions.applyFormEdit(path, v));
  const common = {
    id: pathKey(path),
    value: draft.value,
    disabled,
    placeholder,
    maxLength,
    onFocus: draft.onFocus,
    onBlur: draft.onBlur,
    className: cn(INPUT_CLASS, mono && "font-mono text-xs"),
  };
  if (rows && rows > 1) {
    return <textarea {...common} rows={rows} onChange={(e) => draft.setDraft(e.target.value)} />;
  }
  return (
    <input
      {...common}
      type="text"
      onChange={(e) => draft.setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

/**
 * A `string[]` edited as one comma-separated box (examples, critical tokens, `responsePick` paths).
 *
 * The split happens at commit, not at keystroke, so a comma typed mid-word does not momentarily rewrite the
 * document into two items; an empty box commits `[]` rather than `[""]`, which zod would reject on a `min(1)` item.
 */
export function CsvListControl({
  path, value, disabled, placeholder, max,
}: { path: Path; value: readonly string[]; disabled?: boolean; placeholder?: string; max?: number }) {
  const actions = useSourceActions();
  const joined = value.join(", ");
  const draft = useDraftValue(joined, (v) => {
    const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
    actions.applyFormEdit(path, max ? parts.slice(0, max) : parts);
  });
  return (
    <input
      id={pathKey(path)}
      type="text"
      value={draft.value}
      disabled={disabled}
      placeholder={placeholder}
      onFocus={draft.onFocus}
      onBlur={draft.onBlur}
      onChange={(e) => draft.setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className={INPUT_CLASS}
    />
  );
}

export function NumberControl({
  path, value, disabled, min, max, step = 1,
}: { path: Path; value: number; disabled?: boolean; min?: number; max?: number; step?: number }) {
  const actions = useSourceActions();
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  const last = useRef(value);
  useEffect(() => {
    if (!focused.current && value !== last.current) setDraft(String(value));
    last.current = value;
  }, [value]);
  return (
    <input
      id={pathKey(path)}
      type="number"
      inputMode="numeric"
      value={draft}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false;
        const n = Number(draft);
        // An unparseable box reverts rather than writing NaN into the document.
        if (!Number.isFinite(n)) setDraft(String(value));
        else if (n !== value) actions.applyFormEdit(path, n);
      }}
      className={cn(INPUT_CLASS, "tabular-nums")}
    />
  );
}

export function SelectControl<T extends string>({
  path, value, options, disabled, labels, onPick,
}: {
  path: Path;
  value: T;
  options: readonly T[];
  disabled?: boolean;
  labels?: Readonly<Partial<Record<T, string>>>;
  /** Overrides the plain `applyFormEdit`, for a change that has to write more than one key. */
  onPick?: (v: T) => void;
}) {
  const actions = useSourceActions();
  return (
    <select
      id={pathKey(path)}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        const v = e.target.value as T;
        if (onPick) onPick(v);
        else actions.applyFormEdit(path, v);
      }}
      className={INPUT_CLASS}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {labels?.[o] ?? o}
        </option>
      ))}
    </select>
  );
}

export function CheckControl({
  path, value, label, disabled, hint,
}: { path: Path; value: boolean; label: string; disabled?: boolean; hint?: ReactNode }) {
  const actions = useSourceActions();
  const diagnostics = usePathDiagnostics(path, "exact");
  return (
    <div className="min-w-0">
      <label className="flex items-start gap-2 text-sm">
        <input
          id={pathKey(path)}
          type="checkbox"
          checked={value}
          disabled={disabled}
          onChange={(e) => actions.applyFormEdit(path, e.target.checked)}
          className="mt-0.5 size-4 shrink-0"
        />
        <span>
          <span className="font-medium">{label}</span>
          {hint ? <span className="text-muted-foreground block text-xs">{hint}</span> : null}
        </span>
      </label>
      <DiagnosticText diagnostics={diagnostics} />
    </div>
  );
}

/** A section shell: a heading, a one-line blurb, a problem count, and the controls. */
export function SectionCard({
  id, title, blurb, path, actions, children,
}: { id: string; title: string; blurb: string; path: Path; actions?: ReactNode; children: ReactNode }) {
  const diagnostics = usePathDiagnostics(path);
  const severity = worstSeverity(diagnostics);
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="rounded-xl border">
      <header className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-h`} className="text-sm font-semibold">
            {title}
          </h2>
          <p className="text-muted-foreground text-xs">{blurb}</p>
        </div>
        {severity ? (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              severity === "error" ? "bg-destructive/10 text-destructive" : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
            )}
          >
            {diagnostics.length} {diagnostics.length === 1 ? "problem" : "problems"}
          </span>
        ) : null}
        {actions}
      </header>
      <div className="space-y-4 px-4 py-4">{children}</div>
    </section>
  );
}

/** Two or three controls side by side above 640 px, stacked below it (the 390 px rule). */
export const Grid = ({ cols = 2, children }: { cols?: 2 | 3; children: ReactNode }) => (
  <div className={cn("grid gap-4", cols === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>{children}</div>
);
