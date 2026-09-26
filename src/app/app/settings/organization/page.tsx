/**
 * Settings → Organization (SAAS §8.4, §3.5). WP20·2.
 *
 * Every member may open it — leaving lives here, and "what plan is this workspace on" is a fair question for a
 * viewer. The *actions* are what `loadOrgSettings` resolves through `can()`, and WP19·3's routes re-check them.
 *
 * `?new=1` is the switcher's "New organization" link. It is a hint to open a dialog and nothing more: a guest
 * arriving with it still gets the §8.5 card, because the cap and the account requirement are decided by the
 * principal, never by the query string.
 */
import type { Metadata } from "next";

import { AccountRequired } from "@/components/app-shell/account-required";
import { PageHeader } from "@/components/app-shell/bits";
import { OrgPanel } from "@/components/settings/org-panel";
import { oneParam } from "@/core/contracts/ext/wp20-app";
import { MAX_OWNED_ORGS } from "@/server/identity";
import { appPrincipal } from "@/server/read-models/app-guard";
import { loadOrgSettings, ownedOrgCount } from "@/server/read-models/org-settings";

export const metadata: Metadata = { title: "Organization" };
export const dynamic = "force-dynamic";

export default async function OrganizationSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const principal = await appPrincipal("/app/settings/organization");
  const [view, owned] = await Promise.all([
    loadOrgSettings(principal),
    ownedOrgCount(principal).catch(() => 0),
  ]);
  const openNew = oneParam((await searchParams).new, 8) === "1";

  const panel = (
    <OrgPanel view={view} ownedCount={owned} maxOwned={MAX_OWNED_ORGS} openNew={openNew && !view.accountRequired} />
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Organization" description="The workspace itself: its name, its plan and who owns it." />

      {view.accountRequired ? (
        <AccountRequired
          title="Create your free account to manage this workspace"
          body="10 seconds, no card. Naming it, inviting people and adding a second workspace all need an account — and this one comes with you."
          next="/app/settings/organization"
        >
          {panel}
        </AccountRequired>
      ) : (
        panel
      )}
    </div>
  );
}
