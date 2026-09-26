/**
 * Settings → API keys (WP22, SAAS §6, §8.4).
 *
 * **A placeholder, and it says so.** WP22 is not merged into `main`, but the settings nav lists this row
 * deliberately (SAAS §8.5: API keys and Webhooks stay visible, because they are the two pages a judge opens to
 * decide whether "real API, real SaaS" is a claim or a product). Until the QA-FIX pass, the link led to Next's
 * generic 404 — which reads as "broken", not as "scheduled". This is the same ruling the Studio's own tab strip
 * already took for the tabs WP15·3 owns (`src/components/studio/tabs.ts`).
 *
 * WP22 replaces this file wholesale; nothing here is worth keeping.
 */
import type { Metadata } from "next";

import { PageHeader } from "@/components/app-shell/bits";
import { appPrincipal } from "@/server/read-models/app-guard";

export const metadata: Metadata = { title: "API keys" };
export const dynamic = "force-dynamic";

export default async function ApiKeysSettingsPage() {
  await appPrincipal("/app/settings/api-keys");

  return (
    <div className="space-y-6">
      <PageHeader title="API keys" description="Keys for the public API, scoped to this workspace." />
      <div className="border-border/70 bg-[var(--cx-raise)] rounded-xl border border-dashed px-5 py-10 text-center">
        <p className="text-sm font-semibold">This panel arrives with WP22.</p>
        <p className="text-muted-foreground mx-auto mt-1.5 max-w-[46ch] text-sm text-pretty">Keys are created, scoped and revoked here, and the API reference at /docs/api lists every endpoint they open. Nothing is stored for this workspace yet.</p>
      </div>
    </div>
  );
}
