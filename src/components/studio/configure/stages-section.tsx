"use client";
/**
 * components/studio/configure/stages-section.tsx - Stages (SAAS §5.5, WP15·2).
 *
 * §5.5 asks for "a toggle per kind: confirm, disclose, act, close; goal; exit; tools checklist", and the toggle is
 * the interesting decision. A relay has between one and four stages in a fixed order, so "add a stage" is really
 * "turn this part of the call on", and a toggle says that in a way an Add button does not.
 *
 * Turning one on inserts it **in call order**, which `applyEdit` cannot do directly — there is a `setIn` and a
 * `deleteIn` and no "insert at". `stageToggleEdits` appends and then bubbles the new stage into place with swaps,
 * so only the stages that actually shift lose their comments (`client/studio/configure.ts`).
 *
 * The **exit** is written as one whole object rather than key by key: `ExitSchema` is a discriminated union whose
 * keys change with the kind, and a two-step write would leave a stale `disclosure:` beside a new `connector:` and
 * fail zod in between — which, since zod gates autosave, would be visible as "Unsaved: 1 error to fix".
 */
import {
  REQUIRED_STAGE_TOOLS, exitEdit, defaultExit, moveTarget, stageToggleEdits, stageToolEdit, swapEdits,
  toolInventory, STAGE_BLURB, STAGE_ORDER, type Path, type StageExit,
} from "@/client/studio/configure";
import { STAGE_KIND_LABEL, type StageKind } from "@/client/studio/overview";
import { useSource, useSourceActions } from "@/client/studio/use-source-store";
import { Button } from "@/components/ui/button";
import type { Blueprint } from "@/core/contracts/v2/blueprint";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp } from "lucide-react";

import { DiagnosticText, Grid, Row, SectionCard, TextControl, usePathDiagnostics } from "./controls";

const BASE: Path = ["playbook", "stages"];

export function StagesSection({ editable }: { editable: boolean }) {
  const bp = useSource((s) => s.blueprint);
  const actions = useSourceActions();
  if (!bp) return null;
  const stages = bp.playbook.stages;

  const move = (index: number, direction: "up" | "down") => {
    const to = moveTarget(stages.length, index, direction);
    if (to === null) return;
    actions.applyFormEdits(swapEdits(BASE, stages, index, to));
  };

  return (
    <SectionCard id="stages" title="Stages" blurb="The order the assistant works in, and what it may call in each one." path={BASE}>
      <ul className="grid gap-2 sm:grid-cols-2" aria-label="Stages in this relay">
        {STAGE_ORDER.map((kind) => {
          const on = stages.some((s) => s.kind === kind);
          const edits = stageToggleEdits(bp, kind, !on);
          return (
            <li key={kind}>
              <label className={cn("flex items-start gap-2 rounded-lg border p-2 text-sm", !on && "opacity-70")}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!editable || edits.length === 0}
                  onChange={() => actions.applyFormEdits(edits)}
                  className="mt-0.5 size-4 shrink-0"
                />
                <span className="min-w-0">
                  <span className="block font-medium">{STAGE_KIND_LABEL[kind]}</span>
                  <span className="text-muted-foreground block text-xs">{STAGE_BLURB[kind]}</span>
                  {on && edits.length === 0 ? (
                    <span className="text-muted-foreground block text-xs">A relay needs at least one stage.</span>
                  ) : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <ol className="space-y-3">
        {stages.map((stage, i) => (
          <StageCard
            key={`${stage.id}-${i}`}
            bp={bp}
            index={i}
            count={stages.length}
            editable={editable}
            onMove={move}
          />
        ))}
      </ol>
    </SectionCard>
  );
}

function StageCard({
  bp, index, count, editable, onMove,
}: { bp: Blueprint; index: number; count: number; editable: boolean; onMove: (i: number, d: "up" | "down") => void }) {
  const actions = useSourceActions();
  const stage = bp.playbook.stages[index];
  const at = (...keys: (string | number)[]): Path => [...BASE, index, ...keys];
  const diagnostics = usePathDiagnostics([...BASE, index]);
  // Hoisted above the early return: a hook must not sit in the JSX below it, or a card whose stage has just been
  // removed changes the hook count between renders.
  const toolDiagnostics = usePathDiagnostics([...BASE, index, "tools"]);
  if (!stage) return null;

  return (
    <li className={cn("rounded-lg border", diagnostics.some((d) => d.severity === "error") && "border-destructive/50")}>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="bg-muted rounded-full px-2 py-0.5 text-xs font-medium">{index + 1}</span>
        <span className="text-sm font-medium">{STAGE_KIND_LABEL[stage.kind]}</span>
        <span className="text-muted-foreground font-mono text-xs">{stage.id}</span>
        <span className="ml-auto flex shrink-0 gap-1">
          <Button type="button" size="icon" variant="ghost" className="size-7" disabled={!editable || index === 0}
            aria-label={`Move the ${STAGE_KIND_LABEL[stage.kind]} stage earlier`} onClick={() => onMove(index, "up")}>
            <ChevronUp aria-hidden className="size-4" />
          </Button>
          <Button type="button" size="icon" variant="ghost" className="size-7" disabled={!editable || index === count - 1}
            aria-label={`Move the ${STAGE_KIND_LABEL[stage.kind]} stage later`} onClick={() => onMove(index, "down")}>
            <ChevronDown aria-hidden className="size-4" />
          </Button>
        </span>
      </div>

      <div className="space-y-4 px-3 py-3">
        <Grid>
          <Row label="Name" path={at("label")} match="exact" hint="Shown on the console, never spoken.">
            <TextControl path={at("label")} value={stage.label} disabled={!editable} maxLength={40} />
          </Row>
          <Row label="Id" path={at("id")} match="exact" hint="Referenced by the compiled prompt.">
            <TextControl path={at("id")} value={stage.id} disabled={!editable} maxLength={40} mono />
          </Row>
        </Grid>

        <Row label="Goal" path={at("goal")} match="exact" hint="Dropped into the prompt as the instruction for this part of the call.">
          <TextControl path={at("goal")} value={stage.goal} disabled={!editable} rows={3} maxLength={2400} />
        </Row>

        <ExitControl bp={bp} index={index} editable={editable} />

        <fieldset>
          <legend className="text-sm font-medium">Tools it may call</legend>
          <p className="text-muted-foreground mb-2 text-xs">Between two and six. The two built-ins are always available.</p>
          <ul className="grid gap-1 sm:grid-cols-2">
            {toolInventory(bp).map((tool) => {
              const checked = stage.tools.includes(tool.name);
              const edit = stageToolEdit(index, stage.tools, tool.name, !checked);
              return (
                <li key={tool.name}>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!editable || tool.required || edit === null}
                      onChange={() => edit && actions.applyFormEdits([edit])}
                      className="mt-0.5 size-4 shrink-0"
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs">{tool.name}</span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {tool.from}
                        {REQUIRED_STAGE_TOOLS.includes(tool.name) ? " · always on" : ""}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <DiagnosticText diagnostics={toolDiagnostics} />
        </fieldset>
      </div>
    </li>
  );
}

const EXIT_KINDS = ["all_required_verified", "disclosure_accepted", "connector_succeeded", "end"] as const;

const EXIT_LABEL: Record<(typeof EXIT_KINDS)[number], string> = {
  all_required_verified: "every required field is verified",
  disclosure_accepted: "a disclosure is accepted",
  connector_succeeded: "a connector succeeds",
  end: "the call ends here",
};

/** The exit condition: a kind, and — for two of the four — which disclosure or connector it waits on. */
function ExitControl({ bp, index, editable }: { bp: Blueprint; index: number; editable: boolean }) {
  const actions = useSourceActions();
  const stage = bp.playbook.stages[index];
  const path: Path = [...BASE, index, "exit"];
  const diagnostics = usePathDiagnostics(path);
  if (!stage) return null;
  const exit = stage.exit;
  const referrers = bp.connectors.filter((c) => "toolName" in c);

  const pickKind = (kind: (typeof EXIT_KINDS)[number]) => {
    if (kind === exit.kind) return;
    // `defaultExit` fills the reference from what the relay has; a kind with nothing to point at falls back to
    // "every required field is verified" rather than writing an id that does not exist.
    const next: StageExit =
      kind === "all_required_verified" || kind === "end"
        ? { kind }
        : kind === "disclosure_accepted"
          ? (defaultExit("disclose", bp).kind === "disclosure_accepted" ? defaultExit("disclose", bp) : { kind: "all_required_verified" })
          : (defaultExit("act", bp).kind === "connector_succeeded" ? defaultExit("act", bp) : { kind: "all_required_verified" });
    actions.applyFormEdits([exitEdit(index, next)]);
  };

  return (
    <div className="min-w-0">
      <span className="mb-1 block text-sm font-medium">Moves on when…</span>
      <div className="grid gap-2 sm:grid-cols-2">
        <select
          aria-label="Exit condition"
          value={exit.kind}
          disabled={!editable}
          onChange={(e) => pickKind(e.target.value as (typeof EXIT_KINDS)[number])}
          className="focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        >
          {EXIT_KINDS.map((k) => (
            <option
              key={k}
              value={k}
              disabled={(k === "disclosure_accepted" && bp.playbook.disclosures.length === 0) || (k === "connector_succeeded" && referrers.length === 0)}
            >
              {EXIT_LABEL[k]}
            </option>
          ))}
        </select>

        {exit.kind === "disclosure_accepted" ? (
          <select
            aria-label="Which disclosure"
            value={exit.disclosure}
            disabled={!editable}
            onChange={(e) => actions.applyFormEdits([exitEdit(index, { kind: "disclosure_accepted", disclosure: e.target.value })])}
            className="focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          >
            {bp.playbook.disclosures.map((d) => (
              <option key={d.id} value={d.id}>{d.title || d.id}</option>
            ))}
          </select>
        ) : null}

        {exit.kind === "connector_succeeded" ? (
          <select
            aria-label="Which connector"
            value={exit.connector}
            disabled={!editable}
            onChange={(e) => actions.applyFormEdits([exitEdit(index, { kind: "connector_succeeded", connector: e.target.value })])}
            className="focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          >
            {referrers.map((c) => (
              <option key={c.id} value={c.id}>{c.label || c.id}</option>
            ))}
          </select>
        ) : null}
      </div>
      <DiagnosticText diagnostics={diagnostics} />
    </div>
  );
}
