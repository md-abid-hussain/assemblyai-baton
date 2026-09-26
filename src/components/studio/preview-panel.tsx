"use client";
/**
 * components/studio/preview-panel.tsx - the compiled relay, from the kernel in the browser (P§7.3, SAAS §5.5, P1).
 *
 * Five sections, in the order a builder checks them: the greeting the customer hears, the system prompt the model
 * gets per stage, the tools it may call, the extractor's strict schema, and the first `session.update`. Each carries
 * the number that decides whether it will work at runtime - words and seconds for the greeting, characters against
 * 8000 for the prompt, `assertStrictSchema` ✓ for the extractor, `validateFirstUpdate` ✓ for the update.
 *
 * The panel renders from the **last valid** compile, so a half-typed line never blanks it; the header says when what
 * is on screen is older than what is in the editor.
 */
import { useState } from "react";

import { CANNED_STATE_LABEL, greetingFor } from "@/client/studio/preview";
import { useSource } from "@/client/studio/use-source-store";
import { Badge } from "@/components/ui/badge";
import { CANNED_STATES, type CannedState } from "@/core/contracts/v2";
import { cn } from "@/lib/utils";

const PROMPT_CHAR_BUDGET = 8000;

function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <section className="border-b px-3 py-3 last:border-b-0">
      <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wide uppercase">
        {title}
        {note}
      </h3>
      <div className="mt-2 text-sm">{children}</div>
    </section>
  );
}

/**
 * QA-FIX: a scrollable block must be reachable by keyboard (axe `scrollable-region-focusable`, serious — the
 * same rule the break-it pass caught on `/call`). These panes hold the compiled greeting and prompt, which are
 * exactly the text a reviewer needs to read, and they clip at 16 rem.
 */
const Pre = ({ children, label }: { children: React.ReactNode; label: string }) => (
  <pre
    className="bg-muted/50 max-h-64 overflow-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap"
    tabIndex={0}
    role="region"
    aria-label={label}
  >
    {children}
  </pre>
);

export function PreviewPanel({ className }: { className?: string }) {
  const preview = useSource((s) => s.preview);
  const previewError = useSource((s) => s.previewError);
  const hash = useSource((s) => s.hash);
  const serverHash = useSource((s) => s.serverHash);
  const stale = useSource((s) => s.blueprint === null || s.status === "invalid");

  const [state, setState] = useState<CannedState>("one_pending");
  const [stageIndex, setStageIndex] = useState(0);

  if (!preview) {
    return (
      <div className={cn("text-muted-foreground p-4 text-sm", className)}>
        {previewError ? `This blueprint cannot be compiled: ${previewError}` : "Fix the errors in Code to see the compiled relay."}
      </div>
    );
  }

  const greeting = greetingFor(preview, state);
  const prompt = preview.prompts[Math.min(stageIndex, Math.max(0, preview.prompts.length - 1))];
  const tools = preview.tools[Math.min(stageIndex, Math.max(0, preview.tools.length - 1))];
  const mismatch = serverHash !== null && hash !== null && serverHash !== hash;

  return (
    <div className={cn("min-h-0 overflow-auto", className)} tabIndex={0} role="region" aria-label="Compiled preview">
      {mismatch ? (
        <p className="bg-destructive/10 text-destructive border-b px-3 py-2 text-xs">
          The browser and the server compiled this relay differently ({hash?.slice(0, 8)} vs {serverHash.slice(0, 8)}).
          That is a bug — please report it. The server's compile is the one that runs.
        </p>
      ) : null}
      {stale ? (
        <p className="border-b bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Showing the last version that compiled. The editor has errors.
        </p>
      ) : null}

      <Section
        title="Greeting"
        note={greeting ? <Badge variant="outline">{greeting.wordCount} words · {greeting.estSeconds}s</Badge> : null}
      >
        <div className="mb-2 flex flex-wrap gap-1">
          {CANNED_STATES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={state === s}
              onClick={() => setState(s)}
              className={cn(
                "rounded-md border px-2 py-0.5 text-xs",
                state === s ? "bg-primary text-primary-foreground border-transparent" : "hover:bg-accent",
              )}
            >
              {CANNED_STATE_LABEL[s]}
            </button>
          ))}
        </div>
        <Pre label="Compiled greeting">{greeting?.text ?? "—"}</Pre>
      </Section>

      <Section
        title="System prompt"
        note={
          prompt ? (
            <Badge variant={prompt.chars > PROMPT_CHAR_BUDGET ? "destructive" : "outline"}>
              {prompt.chars} / {PROMPT_CHAR_BUDGET} chars
            </Badge>
          ) : null
        }
      >
        <div className="mb-2 flex flex-wrap gap-1">
          {preview.prompts.map((p, i) => (
            <button
              key={p.stage}
              type="button"
              aria-pressed={i === stageIndex}
              onClick={() => setStageIndex(i)}
              className={cn(
                "rounded-md border px-2 py-0.5 text-xs",
                i === stageIndex ? "bg-primary text-primary-foreground border-transparent" : "hover:bg-accent",
              )}
            >
              {p.stage}
            </button>
          ))}
        </div>
        <Pre label="Compiled prompt for this stage">{prompt?.text ?? "—"}</Pre>
      </Section>

      <Section title="Tools" note={<Badge variant="outline">{tools?.tools.length ?? 0} for {tools?.stage ?? "—"}</Badge>}>
        <Pre label="Tools for this stage">{JSON.stringify(tools?.tools ?? [], null, 2)}</Pre>
      </Section>

      <Section
        title="Extractor"
        note={
          <Badge variant={preview.extractor.strictOk ? "outline" : "destructive"}>
            {preview.extractor.strictOk ? "strict ✓" : "not strict"}
          </Badge>
        }
      >
        {preview.extractor.strictReason ? (
          <p className="text-destructive mb-2 text-xs">{preview.extractor.strictReason}</p>
        ) : null}
        <p className="text-muted-foreground mb-2 text-xs">
          Format <code>{preview.extractor.formatName}</code> · version {preview.extractor.versionId}
        </p>
        <Pre label="Extractor schema">{JSON.stringify(preview.extractor.schema, null, 2)}</Pre>
      </Section>

      <Section
        title="First update"
        note={
          <Badge variant={preview.firstUpdate.ok ? "outline" : "destructive"}>
            {preview.firstUpdate.ok ? "valid ✓" : "invalid"}
          </Badge>
        }
      >
        <p className="text-muted-foreground text-xs">
          {preview.firstUpdate.ok
            ? "The first session.update the Voice Agent receives passes validateFirstUpdate."
            : preview.firstUpdate.reason}
        </p>
        <p className="text-muted-foreground mt-2 text-xs">
          Listening: {preview.listening.keyterms.length} keyterms · {preview.listening.languageCodes.join(", ")} ·{" "}
          {preview.listening.tuning}
        </p>
        <p className="text-muted-foreground mt-2 font-mono text-xs">
          hash {hash?.slice(0, 12) ?? "—"} · kernel {preview.kernelVersion}
        </p>
      </Section>
    </div>
  );
}
