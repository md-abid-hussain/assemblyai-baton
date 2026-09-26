/**
 * Settings → Usage (WP21·2, SAAS §4.5, §8.4).
 *
 * **A placeholder, and it says so.** WP21·2 is not merged into `main`, but the settings nav lists this row
 * deliberately, beside Billing (which is merged and works). Until the QA-FIX pass, the link led to Next's
 * generic 404 — which reads as "broken", not as "scheduled". This is the same ruling the Studio's own tab strip
 * already took for the tabs WP15·3 owns (`src/components/studio/tabs.ts`).
 *
 * WP21·2 replaces this file wholesale; nothing here is worth keeping.
 */
import type { Metadata } from "next";

import { PageHeader } from "@/components/app-shell/bits";
import { appPrincipal } from "@/server/read-models/app-guard";

export const metadata: Metadata = { title: "Usage" };
export const dynamic = "force-dynamic";

export default async function UsageSettingsPage() {
  await appPrincipal("/app/settings/usage");

  return (
    <div className="space-y-6">
      <PageHeader title="Usage" description="Minutes, runs and API calls this workspace has used." />
      <div className="border-border/70 bg-[var(--cx-raise)] rounded-xl border border-dashed px-5 py-10 text-center">
        <p className="text-sm font-semibold">This panel arrives with WP21·2.</p>
        <p className="text-muted-foreground mx-auto mt-1.5 max-w-[46ch] text-sm text-pretty">The metered usage behind your plan's limits is summarised here. Billing already shows the plan and its limits, and the audit log already records what happened.</p>
      </div>
    </div>
  );
}
