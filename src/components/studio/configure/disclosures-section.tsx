"use client";
/**
 * components/studio/configure/disclosures-section.tsx - Disclosures (SAAS §5.5, WP15·2).
 *
 * The text a relay reads **word for word**. That is the whole reason this section is not just another textarea:
 * the runtime resolves the placeholders server-side and hands the assistant the rendered string with an
 * instruction not to paraphrase it, and `criticalTokens` names the parts that may never be dropped.
 *
 * Removing a disclosure is the one edit here that can break another part of the relay — a `disclose` stage exits
 * on a disclosure id — so the confirmation says which stage will be left pointing at nothing rather than letting
 * lint explain it afterwards.
 */
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { appendEdit, newDisclosure, removeEdit, type Path } from "@/client/studio/configure";
import { useSource, useSourceActions } from "@/client/studio/use-source-store";
import { Button } from "@/components/ui/button";
import type { Blueprint } from "@/core/contracts/v2/blueprint";
import { cn } from "@/lib/utils";

import { CheckControl, CsvListControl, DiagnosticText, Grid, Row, SectionCard, TextControl, usePathDiagnostics } from "./controls";

const BASE: Path = ["playbook", "disclosures"];

/** Every id used anywhere: a disclosure shares the id namespace with fields, stages, connectors and values (L1). */
const allIds = (bp: Blueprint): string[] => [
  ...bp.fields.map((f) => f.id),
  ...bp.values.map((v) => v.id),
  ...bp.playbook.stages.map((s) => s.id),
  ...bp.playbook.disclosures.map((d) => d.id),
  ...bp.connectors.map((c) => c.id),
];

export function DisclosuresSection({ editable }: { editable: boolean }) {
  const bp = useSource((s) => s.blueprint);
  const actions = useSourceActions();
  const [open, setOpen] = useState<string | null>(null);
  if (!bp) return null;
  const list = bp.playbook.disclosures;

  return (
    <SectionCard
      id="disclosures"
      title="Disclosures"
      blurb="Text that is read word for word and has to be accepted."
      path={BASE}
      actions={
        editable ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={list.length >= 4}
            onClick={() => {
              const d = newDisclosure(allIds(bp));
              actions.applyFormEdits([appendEdit(BASE, list, d)]);
              setOpen(d.id);
            }}
          >
            <Plus aria-hidden className="size-4" /> Add disclosure
          </Button>
        ) : null
      }
    >
      {list.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No disclosures. A relay that only confirms and acts does not need one; a relay that charges or signs usually does.
        </p>
      ) : (
        <ul className="space-y-3">
          {list.map((d, i) => (
            <DisclosureCard
              key={`${d.id}-${i}`}
              bp={bp}
              index={i}
              editable={editable}
              expanded={open === d.id}
              onToggle={() => setOpen(open === d.id ? null : d.id)}
            />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function DisclosureCard({
  bp, index, editable, expanded, onToggle,
}: { bp: Blueprint; index: number; editable: boolean; expanded: boolean; onToggle: () => void }) {
  const actions = useSourceActions();
  const at = (...keys: (string | number)[]): Path => [...BASE, index, ...keys];
  const diagnostics = usePathDiagnostics([...BASE, index]);
  // Hoisted: the control it belongs to is inside the `expanded ?` branch, and a hook called from there would run
  // on some renders and not others.
  const orderDiagnostics = usePathDiagnostics([...BASE, index, "requiresAccepted"], "exact");
  const d = bp.playbook.disclosures[index];
  if (!d) return null;

  const dependents = bp.playbook.stages.filter((s) => s.exit.kind === "disclosure_accepted" && s.exit.disclosure === d.id);
  const others = bp.playbook.disclosures.filter((x) => x.id !== d.id);

  const remove = () => {
    const warning = dependents.length
      ? ` The ${dependents.map((s) => s.label || s.id).join(" and ")} stage would be left waiting for a disclosure that no longer exists.`
      : "";
    if (window.confirm(`Remove "${d.title || d.id}"?${warning}`)) actions.applyFormEdits([removeEdit(BASE, index)]);
  };

  return (
    <li className={cn("rounded-lg border", diagnostics.some((x) => x.severity === "error") && "border-destructive/50")}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="hover:bg-accent focus-visible:ring-ring/50 -ml-1 min-w-0 flex-1 rounded-md px-1 py-1 text-left focus-visible:ring-2 focus-visible:outline-none"
        >
          <span className="block truncate text-sm font-medium">{d.title || d.id}</span>
          <span className="text-muted-foreground block truncate text-xs">{d.text}</span>
        </button>
        {d.consent ? <span className="bg-muted rounded-full px-2 py-0.5 text-xs">Consent</span> : null}
        <Button type="button" size="icon" variant="ghost" className="text-destructive size-7" disabled={!editable}
          aria-label={`Remove ${d.title || d.id}`} onClick={remove}>
          <Trash2 aria-hidden className="size-4" />
        </Button>
      </div>

      {!expanded ? <div className="px-3 pb-2"><DiagnosticText diagnostics={diagnostics} /></div> : null}

      {expanded ? (
        <div className="space-y-4 border-t px-3 py-3">
          <Grid>
            <Row label="Title" path={at("title")} match="exact" hint="Shown on the console and in the stage's exit.">
              <TextControl path={at("title")} value={d.title} disabled={!editable} maxLength={60} />
            </Row>
            <Row label="Id" path={at("id")} match="exact">
              <TextControl path={at("id")} value={d.id} disabled={!editable} maxLength={40} mono />
            </Row>
          </Grid>

          <Row label="Read word for word" path={at("text")} match="exact" hint="Placeholders are resolved before the assistant sees it. End with a question: the stage exits on a yes.">
            <TextControl path={at("text")} value={d.text} disabled={!editable} rows={5} maxLength={2400} />
          </Row>

          <Row label="Parts that may never be dropped" path={at("criticalTokens")} match="exact" hint="Comma separated. Up to eight.">
            <CsvListControl path={at("criticalTokens")} value={d.criticalTokens} disabled={!editable} max={8} placeholder="the amount, the cancellation window" />
          </Row>

          <Grid>
            <CheckControl path={at("requiresReady")} value={d.requiresReady} label="Only once every required field is verified" disabled={!editable}
              hint="The assistant is refused the text until the case is complete." />
            <CheckControl path={at("consent")} value={d.consent} label="A yes here is consent to act" disabled={!editable}
              hint="Accepting it is what permits the act stage." />
          </Grid>

          <div className="min-w-0">
            <span className="mb-1 block text-sm font-medium">Only after another disclosure</span>
            <select
              aria-label="Requires another disclosure first"
              value={d.requiresAccepted ?? ""}
              disabled={!editable}
              onChange={(e) => actions.applyFormEdit(at("requiresAccepted"), e.target.value === "" ? null : e.target.value)}
              className="focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">No order required</option>
              {others.map((x) => (
                <option key={x.id} value={x.id}>After {x.title || x.id}</option>
              ))}
            </select>
            <DiagnosticText diagnostics={orderDiagnostics} />
          </div>
        </div>
      ) : null}
    </li>
  );
}
