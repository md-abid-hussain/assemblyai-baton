"use client";
/**
 * components/studio/import-dialog.tsx - Import a blueprint file (SAAS §5.5: "Import (replace the draft after a diff
 * confirmation)", and the relays list's "Import blueprint").
 *
 * Two jobs, one component:
 *  - on the Code tab, it **replaces the current draft** and shows the unified diff first, because replacing someone's
 *    work on a paste is not something to do silently;
 *  - on `/app/relays`, it **creates a relay** from the file.
 *
 * In both cases the file is validated first and the diagnostics are shown **before** anything else, per
 * `requests/wp23-to-wp15.md` §4 — and a `CODEC_CREDENTIAL` error is called out by name, because the fix is not
 * "edit line 12", it is "store it as a secret and reference it".
 */
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { hasBlockingErrors, MAX_SOURCE_BYTES, sniffFormat, unifiedDiff, validateSource, type CodeDiagnostic, type SourceFormat } from "@/core/relay-code";

import { DiagnosticsList } from "./diagnostics-list";

export interface ImportDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The text the import would replace; when given, the dialog shows a unified diff before confirming. */
  currentText?: string;
  /** `replace` (Code tab) or `create` (the relays list). */
  mode: "replace" | "create";
  onConfirm(i: { text: string; format: SourceFormat }): void | Promise<void>;
}

interface Checked {
  text: string;
  format: SourceFormat;
  diagnostics: CodeDiagnostic[];
  blocked: boolean;
  diff: string;
}

const CREDENTIAL_HELP =
  "A credential cannot live in a blueprint file. Store it as a secret and reference it as { $secret: \"sec_…\" }, then import again.";

export function ImportDialog({ open, onOpenChange, currentText, mode, onConfirm }: ImportDialogProps) {
  const [raw, setRaw] = useState("");
  const [checked, setChecked] = useState<Checked | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const areaId = useId();

  const reset = () => {
    setRaw("");
    setChecked(null);
    setError(null);
  };

  const check = (text: string) => {
    setError(null);
    if (text.trim().length === 0) {
      setChecked(null);
      return;
    }
    if (new TextEncoder().encode(text).length > MAX_SOURCE_BYTES) {
      setError(`That file is larger than ${Math.round(MAX_SOURCE_BYTES / 1024)} KiB.`);
      setChecked(null);
      return;
    }
    const format = sniffFormat(text);
    const { diagnostics } = validateSource(text, format);
    setChecked({
      text,
      format,
      diagnostics,
      blocked: hasBlockingErrors(diagnostics),
      diff: currentText !== undefined ? unifiedDiff(currentText, text, { a: "current draft", b: "imported file" }) : "",
    });
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setRaw(text);
    check(text);
  };

  const confirm = async () => {
    if (!checked || checked.blocked) return;
    setBusy(true);
    try {
      await onConfirm({ text: checked.text, format: checked.format });
      reset();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const hasCredential = checked?.diagnostics.some((d) => d.code === "CODEC_CREDENTIAL") ?? false;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{mode === "replace" ? "Import a blueprint" : "Import blueprint"}</DialogTitle>
          <DialogDescription>
            {mode === "replace"
              ? "Paste or upload a YAML or JSON relay file. It replaces this relay's draft."
              : "Paste or upload a YAML or JSON relay file to create a relay from it."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <input
            type="file"
            accept=".yaml,.yml,.json,application/json,text/yaml"
            onChange={(e) => void onFile(e.target.files?.[0])}
            className="text-sm"
            aria-label="Blueprint file"
          />
          <label htmlFor={areaId} className="sr-only">
            Blueprint source
          </label>
          <textarea
            id={areaId}
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              check(e.target.value);
            }}
            rows={10}
            spellCheck={false}
            placeholder="# yaml-language-server: $schema=/schemas/blueprint-2.0.json&#10;meta:&#10;  schema: changeover.blueprint/2.0"
            className="focus-visible:ring-ring/50 w-full rounded-md border p-2 font-mono text-xs focus-visible:ring-2 focus-visible:outline-none"
          />

          {error ? <p className="text-destructive text-sm">{error}</p> : null}

          {checked ? (
            <>
              <div className="rounded-md border">
                <p className="border-b px-3 py-1.5 text-xs font-semibold tracking-wide uppercase">
                  {checked.format.toUpperCase()} · {checked.blocked ? "cannot be imported" : "ready to import"}
                </p>
                <DiagnosticsList diagnostics={checked.diagnostics} className="max-h-40 overflow-auto" />
              </div>
              {hasCredential ? <p className="text-destructive text-sm">{CREDENTIAL_HELP}</p> : null}
              {mode === "replace" && checked.diff ? (
                <details className="rounded-md border">
                  <summary className="cursor-pointer px-3 py-1.5 text-xs font-semibold tracking-wide uppercase">
                    What changes
                  </summary>
                  <pre className="bg-muted/50 max-h-60 overflow-auto p-2 font-mono text-xs">{checked.diff}</pre>
                </details>
              ) : null}
              {mode === "replace" && !checked.diff && !checked.blocked ? (
                <p className="text-muted-foreground text-sm">This file is identical to the current draft.</p>
              ) : null}
            </>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!checked || checked.blocked || busy} onClick={() => void confirm()}>
            {mode === "replace" ? "Replace the draft" : "Create relay"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
