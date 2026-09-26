"use client";
/**
 * components/studio/monaco-code-editor.tsx - the Monaco half of the Code tab (SAAS §5.5.1).
 *
 * This module is only ever reached through `next/dynamic(..., { ssr: false })` from `code-tab.tsx`, and `code-tab`
 * only reaches it once `loadMonaco()` has resolved. That is what keeps acceptance 7 true: `@monaco-editor/react`
 * lives in a chunk that no other page imports, and `monaco-editor` itself is never imported at all - the AMD tree
 * under `/vendor/monaco/vs` is fetched at runtime.
 */
import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";

import {
  configureJsonSchema, editorOptions, fetchBlueprintSchema, MARKER_OWNER, monacoLanguage, toMarkers,
  type MonacoApi,
} from "@/client/studio/monaco";
import { useSource, useSourceActions } from "@/client/studio/use-source-store";

export interface MonacoCodeEditorProps {
  schemaUrl: string;
  readOnly: boolean;
  /** Called with the editor's "reveal this range" function, so the diagnostics list can jump into the code. */
  onReveal?: (reveal: (line: number, col: number) => void) => void;
}

type EditorInstance = Parameters<OnMount>[0];

export default function MonacoCodeEditor({ schemaUrl, readOnly, onReveal }: MonacoCodeEditorProps) {
  const text = useSource((s) => s.text);
  const format = useSource((s) => s.format);
  const diagnostics = useSource((s) => s.diagnostics);
  const actions = useSourceActions();

  const editorRef = useRef<EditorInstance | null>(null);
  const [monaco, setMonaco] = useState<MonacoApi | null>(null);

  /** Markers are set from an effect, not from `onChange`, so they follow the debounced parse and never flicker. */
  useEffect(() => {
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    const model = editor.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(model, MARKER_OWNER, toMarkers(monaco, diagnostics));
  }, [monaco, diagnostics, text]);

  const onMount: OnMount = (editor, api) => {
    editorRef.current = editor;
    setMonaco(api as unknown as MonacoApi);
    onReveal?.((line, col) => {
      editor.revealPositionInCenter({ lineNumber: line, column: col });
      editor.setPosition({ lineNumber: line, column: col });
      editor.focus();
    });
    // Ctrl/⌘ S saves instead of opening the browser's save dialog (SAAS §5.5 "Save (Ctrl/⌘ S)").
    editor.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.KeyS, () => void actions.saveNow());
    void (async () => {
      const schema = await fetchBlueprintSchema(schemaUrl);
      // The model's uri decides what a relative `$schema` in the document resolves to, so it has to be passed in.
      if (schema) {
        configureJsonSchema(api as unknown as MonacoApi, schema, schemaUrl, editor.getModel()?.uri.toString(), window.location.origin);
      }
    })();
  };

  return (
    <Editor
      language={monacoLanguage(format)}
      value={text}
      onChange={(next) => actions.setText(next ?? "")}
      onMount={onMount}
      options={editorOptions(readOnly)}
      theme="vs"
      height="100%"
      loading={<p className="text-muted-foreground p-4 text-sm">Loading the editor…</p>}
    />
  );
}
