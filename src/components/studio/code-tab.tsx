"use client";
/**
 * components/studio/code-tab.tsx - the Code tab (SAAS §5.5, P1).
 *
 * The whole relay as one file, with the YAML ⇄ JSON toggle, the published JSON Schema, our diagnostics as markers,
 * Format, Save, Download and Import.
 *
 * **Which editor renders** is decided here, once, in this order:
 *   1. `CODE_EDITOR=textarea` (the K-MONACO kill switch) → the textarea, no Monaco chunk requested at all;
 *   2. otherwise try `loadMonaco()`; if the vendor tree is missing or the loader never fires → the textarea, with a
 *      note saying so. A Studio that silently lost its editor would be worse than one that says which one it is
 *      using, especially on a judged deployment.
 * Either way the tab keeps every function except completion, which is acceptance 6.
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";

import type { CodeEditorMode } from "@/client/studio/capabilities";
import { parseCodeTarget, resolveTarget } from "@/client/studio/code-target";
import { loadMonaco } from "@/client/studio/monaco";
import { diagnosticCounts } from "@/client/studio/source-store";
import { useSource, useSourceActions, useSourceStore } from "@/client/studio/use-source-store";
import { Button } from "@/components/ui/button";
import type { SourceFormat } from "@/core/relay-code";
import { cn } from "@/lib/utils";

import { DiagnosticsList } from "./diagnostics-list";
import TextareaCodeEditor from "./textarea-code-editor";

const MonacoCodeEditor = dynamic(() => import("./monaco-code-editor"), {
  ssr: false,
  loading: () => <p className="text-muted-foreground p-4 text-sm">Loading the editor…</p>,
});

type EditorChoice = "checking" | "monaco" | "textarea";

export interface CodeTabProps {
  schemaUrl: string;
  monacoVsPath: string;
  editor: CodeEditorMode;
  readOnly: boolean;
  onImport: () => void;
  onDownload: () => void;
}

export function CodeTab({ schemaUrl, monacoVsPath, editor, readOnly, onImport, onDownload }: CodeTabProps) {
  const format = useSource((s) => s.format);
  const diagnostics = useSource((s) => s.diagnostics);
  const blueprint = useSource((s) => s.blueprint);
  const actions = useSourceActions();
  const store = useSourceStore();

  const [choice, setChoice] = useState<EditorChoice>(editor === "textarea" ? "textarea" : "checking");
  const [monacoError, setMonacoError] = useState<string | null>(null);
  const [caret, setCaret] = useState<{ line: number; col: number } | null>(null);
  /*
   * Monaco's "reveal this position" is **state, not a ref**. It arrives in `onMount`, which is one dynamic import
   * and one mount after `choice` flips to "monaco", so a ref would leave anything that wanted to jump in the
   * meantime — the `#L…` / `#P…` fragment below — writing into a ref nobody reads again. As state it re-renders
   * the tab the moment the editor can actually scroll, and the pending jump runs then.
   */
  const [reveal, setReveal] = useState<((line: number, col: number) => void) | null>(null);

  useEffect(() => {
    if (editor === "textarea") return;
    let alive = true;
    loadMonaco(monacoVsPath).then(
      () => alive && setChoice("monaco"),
      (e: unknown) => {
        if (!alive) return;
        setMonacoError(e instanceof Error ? e.message : String(e));
        setChoice("textarea");
      },
    );
    return () => {
      alive = false;
    };
  }, [editor, monacoVsPath]);

  const jump = useCallback(
    (line: number, col: number) => {
      if (reveal) reveal(line, col);
      else setCaret({ line, col });
    },
    [reveal],
  );

  /*
   * The `#L8:11` / `#Pplaybook.greeting` fragment that Overview's lint summary and Configure's "Edit in Code →"
   * link with (`client/studio/code-target.ts`).
   *
   * It is read **once the editor exists** rather than on mount: Monaco arrives through a dynamic import, and a
   * reveal issued before `onReveal` has handed us its callback would be dropped. `choice` is in the dependency
   * list precisely so the effect runs again at that moment. The fragment is then cleared so that a later Save or
   * a re-render does not drag the caret back to where the builder arrived.
   */
  useEffect(() => {
    // Not before there is an editor that can scroll: "checking" has neither, and Monaco has no `reveal` until it
    // has mounted. The textarea consumes `caret` as a prop, so it is ready as soon as `choice` says so.
    if (choice === "checking" || (choice === "monaco" && !reveal)) return;

    const go = () => {
      const target = parseCodeTarget(window.location.hash);
      if (!target) return;
      // `getState()` rather than a subscription: the text is read at the moment of the jump, and a subscription
      // would re-run this on every keystroke.
      const { text, format: fmt } = store.getState();
      const at = resolveTarget(target, text, fmt);
      if (at) jump(at.line, at.col);
      // Cleared so a later re-render, Save or reload does not drag the caret back to where the reader arrived.
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    };

    go();
    // A second "Edit in Code →" for a different section changes only the fragment, which is not a navigation.
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, [choice, reveal, jump, store]);

  const counts = diagnosticCounts(diagnostics);
  const toggleFormat = (next: SourceFormat) => {
    if (next === format) return;
    if (next === "json" && format === "yaml" && !window.confirm("Converting to JSON drops the comments in this file. Continue?")) return;
    actions.setFormat(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div role="group" aria-label="Source format" className="bg-muted inline-flex rounded-md p-[3px]">
          {(["yaml", "json"] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={format === f}
              onClick={() => toggleFormat(f)}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium",
                format === f ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.toUpperCase()}
            </button>
          ))}
        </div>

        <Button type="button" size="sm" variant="outline" disabled={readOnly || !blueprint} onClick={() => {
          if (format === "yaml" && !window.confirm("Formatting rewrites the file from the canonical blueprint, which drops comments. Continue?")) return;
          actions.formatDocument();
        }}>
          Format
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={readOnly} onClick={() => void actions.saveNow()}>
          Save
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDownload}>
          Download
        </Button>
        {!readOnly ? (
          <Button type="button" size="sm" variant="outline" onClick={onImport}>
            Import
          </Button>
        ) : null}

        <span className="ml-auto flex items-center gap-3 text-xs">
          <a href={schemaUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
            Schema
          </a>
          <span className={cn("text-muted-foreground", counts.errors > 0 && "text-destructive")}>
            {counts.errors} {counts.errors === 1 ? "error" : "errors"} · {counts.warnings}{" "}
            {counts.warnings === 1 ? "warning" : "warnings"}
          </span>
        </span>
      </div>

      {monacoError ? (
        <p className="border-b bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          The code editor could not load from <code>{monacoVsPath}</code>, so this is the plain editor: everything
          works except completion. ({monacoError})
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden border-b">
        {choice === "checking" ? (
          <p className="text-muted-foreground p-4 text-sm">Loading the editor…</p>
        ) : choice === "monaco" ? (
          <MonacoCodeEditor
            schemaUrl={schemaUrl}
            readOnly={readOnly}
            // `setReveal(() => fn)`: a bare `setReveal(fn)` would have React call it as an updater.
            onReveal={(fn) => setReveal(() => fn)}
          />
        ) : (
          <TextareaCodeEditor readOnly={readOnly} caret={caret} />
        )}
      </div>

      <div className="max-h-48 shrink-0 overflow-auto">
        <DiagnosticsList diagnostics={diagnostics} onJump={jump} />
      </div>
    </div>
  );
}
