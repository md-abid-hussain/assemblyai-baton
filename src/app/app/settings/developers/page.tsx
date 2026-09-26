/**
 * Settings → CLI & SDK (WP23, SAAS §5.4, §8.4).
 *
 * **A placeholder, and it says so.** WP23 is not merged into `main`, but the settings nav lists this row
 * deliberately (SAAS §8.5: API keys and Webhooks stay visible, because they are the two pages a judge opens to
 * decide whether "real API, real SaaS" is a claim or a product). Until the QA-FIX pass, the link led to Next's
 * generic 404 — which reads as "broken", not as "scheduled". This is the same ruling the Studio's own tab strip
 * already took for the tabs WP15·3 owns (`src/components/studio/tabs.ts`).
 *
 * WP23 replaces this file wholesale; nothing here is worth keeping.
 */
import type { Metadata } from "next";

import { PageHeader } from "@/components/app-shell/bits";
import { appPrincipal } from "@/server/read-models/app-guard";

export const metadata: Metadata = { title: "CLI & SDK" };
export const dynamic = "force-dynamic";

export default async function DevelopersSettingsPage() {
  await appPrincipal("/app/settings/developers");

  return (
    <div className="space-y-6">
      <PageHeader title="CLI & SDK" description="Pull a relay, edit it as code, push it back." />
      <div className="border-border/70 bg-[var(--cx-raise)] rounded-xl border border-dashed px-5 py-10 text-center">
        <p className="text-sm font-semibold">This panel arrives with WP23.</p>
        <p className="text-muted-foreground mx-auto mt-1.5 max-w-[46ch] text-sm text-pretty">The CLI tarball, the SDK and the Build key that authorises a push are served from here. The blueprint schema at /schemas is already published.</p>
      </div>
    </div>
  );
}
