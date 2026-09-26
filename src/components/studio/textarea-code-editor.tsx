"use client";
/**
 * components/studio/textarea-code-editor.tsx - the `CODE_EDITOR=textarea` fallback (SAAS §5.5.1, K-MONACO).
 *
 * "Keeps every Code-tab function except completion" (TASKS-v3 §7 acceptance 6) is the bar, so this is not a
 * degraded textarea: it has line numbers that scroll with the text, Tab inserts two spaces instead of leaving the
 * field, Ctrl/⌘ S saves, and the same diagnostics appear - as a clickable list rather than as squiggles, which is
 * the P§7.2 Advanced design. Import, Export, Format and the YAML ⇄ JSON toggle all live in the tab above it and are
 * unaffected.
 */
import { useEffect, useRef } from "react";

import { useSource, useSourceActions } from "@/client/studio/use-source-store";
import { cn } from "@/lib/utils";

export interface TextareaCodeEditorProps {
  readOnly: boolean;
  /** 1-based line, 1-based column: the diagnostics list uses it to put the caret on the offending token. */
  caret?: { line: number; col: number } | null;
}

export default function TextareaCodeEditor({ readOnly, caret }: TextareaCodeEditorProps) {
  const text = useSource((s) => s.text);
  const actions = useSourceActions();
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  const lineCount = text.length === 0 ? 1 : text.split("\n").length;

  useEffect(() => {
    if (!caret || !areaRef.current) return;
    const lines = text.split("\n");
    let offset = 0;
    for (let i = 0; i < caret.line - 1 && i < lines.length; i += 1) offset += (lines[i] ?? "").length + 1;
    offset += Math.max(0, caret.col - 1);
    const area = areaRef.current;
    area.focus();
    area.setSelectionRange(offset, offset);
  }, [caret, text]);

  return (
    <div className="flex h-full min-h-0 font-mono text-[13px] leading-5">
      <div
        ref={gutterRef}
        aria-hidden="true"
        className="text-muted-foreground bg-muted/40 h-full shrink-0 overflow-hidden border-r px-2 py-2 text-right tabular-nums select-none"
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        ref={areaRef}
        value={text}
        readOnly={readOnly}
        aria-label="Relay blueprint source"
        spellCheck={false}
        wrap="off"
        onScroll={(e) => {
          if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onChange={(e) => actions.setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void actions.saveNow();
            return;
          }
          if (e.key === "Tab" && !e.shiftKey && !readOnly) {
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: a, selectionEnd: b } = el;
            const next = `${text.slice(0, a)}  ${text.slice(b)}`;
            actions.setText(next);
            requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
          }
        }}
        className={cn(
          "h-full min-h-0 flex-1 resize-none overflow-auto bg-transparent px-3 py-2 outline-none",
          "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-inset",
          readOnly && "text-muted-foreground",
        )}
      />
    </div>
  );
}
