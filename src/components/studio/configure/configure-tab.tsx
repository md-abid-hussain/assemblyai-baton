"use client";
/**
 * components/studio/configure/configure-tab.tsx - the Configure tab (SAAS §5.5, WP15·2).
 *
 * Six form sections over the same text the Code tab edits, plus an honest list of the six parts that have no form.
 *
 * **The read-only rule is the one thing to get right here.** §5.5: "if the text has a syntax error, the forms are
 * read-only with the banner 'Fix the code to use the forms'. The forms show the last valid parse." So the forms
 * never disappear and never show an empty shell — the store keeps the last blueprint that parsed, every control
 * renders from it, and only *writing* is switched off. A builder who breaks the YAML in Code and comes back here
 * sees the relay they know, greyed, with one sentence telling them why.
 *
 * Three separate things can make the forms read-only, and they are not the same thing to a person, so each gets
 * its own sentence: this viewer may not edit at all, the deployment is `STUDIO_MODE=readonly`, or the text does
 * not currently parse.
 */
import { CODE_ONLY_SECTIONS } from "@/client/studio/configure";
import { useSource } from "@/client/studio/use-source-store";
import type { PlanId } from "@/core/contracts/v3/identity";

import { CodeOnlyRow } from "./code-link";
import { useFormsEditable } from "./controls";
import { ConnectorsSection } from "./connectors-section";
import { DisclosuresSection } from "./disclosures-section";
import { FieldsSection } from "./fields-section";
import { GreetingSection } from "./greeting-section";
import { HandoffSection } from "./handoff-section";
import { StagesSection } from "./stages-section";

export interface ConfigureTabProps {
  relayId: string;
  /** False for a viewer, a flagship relay, or `STUDIO_MODE=readonly`; the banner then says which. */
  canEdit: boolean;
  plan: PlanId | null;
}

export function ConfigureTab({ relayId, canEdit, plan }: ConfigureTabProps) {
  const blueprint = useSource((s) => s.blueprint);
  const diagnostics = useSource((s) => s.diagnostics);
  const editable = useFormsEditable() && canEdit;
  const broken = diagnostics.some((d) => d.severity === "error" && d.source !== "lint");

  if (!blueprint) {
    return (
      <div className="h-full overflow-auto p-6">
        <p className="text-sm font-medium">The forms need a blueprint that parses.</p>
        <p className="text-muted-foreground mt-1 text-sm">
          This relay has never parsed in this session, so there is no last valid version to show. Fix it in{" "}
          <span className="text-foreground font-medium">Code</span> — the errors are listed under the editor — and
          this tab fills in.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      {broken ? (
        <p className="border-b bg-amber-50 px-4 py-2 text-sm dark:bg-amber-950/40">
          <span className="font-medium">Fix the code to use the forms.</span> These are the last version that
          parsed, so you can still read them.
        </p>
      ) : !canEdit ? (
        <p className="bg-muted/50 border-b px-4 py-2 text-sm">Read-only: you can read every setting here, but not change it.</p>
      ) : null}

      <div className="mx-auto max-w-3xl space-y-4 px-4 py-4">
        <FieldsSection editable={editable} />
        <HandoffSection editable={editable} relayId={relayId} />
        <GreetingSection editable={editable} relayId={relayId} />
        <StagesSection editable={editable} />
        <DisclosuresSection editable={editable} />
        <ConnectorsSection editable={editable} plan={plan} relayId={relayId} />

        <section aria-labelledby="code-only-h" className="rounded-xl border">
          <header className="border-b px-4 py-3">
            <h2 id="code-only-h" className="text-sm font-semibold">Only in Code</h2>
            <p className="text-muted-foreground text-xs">
              These have no form on purpose: each one is a list of patterns, prompts or raw JSON where a text box
              would be slower than the editor. They are listed so you know the relay has them.
            </p>
          </header>
          <ul className="divide-y px-4 py-2">
            {CODE_ONLY_SECTIONS.map((s) => (
              <CodeOnlyRow key={s.title} relayId={relayId} title={s.title} path={s.path} why={s.why} />
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

export default ConfigureTab;
