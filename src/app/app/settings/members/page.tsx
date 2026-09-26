/**
 * Settings → Members & invites (SAAS §8.4, §3.6). WP20·2.
 *
 * A **guest** gets §8.5's named case: "the same pattern covers Members → Invite (guest)". The real roster, the
 * real seat count and the real invite form render, inert, behind the upgrade card — a guest is the sole member
 * of their own workspace, so the page is truthful as well as legible.
 *
 * A **viewer** or a **member** sees the roster and nothing else offered; `loadMembers` resolves `canInvite` and
 * `canManage` through `can()`, and the panel only ever hides or disables.
 */
import type { Metadata } from "next";

import { AccountRequired } from "@/components/app-shell/account-required";
import { PageHeader } from "@/components/app-shell/bits";
import { MembersPanel } from "@/components/settings/members-panel";
import { appPrincipal } from "@/server/read-models/app-guard";
import { loadMembers } from "@/server/read-models/members";

export const metadata: Metadata = { title: "Members" };
export const dynamic = "force-dynamic";

export default async function MembersSettingsPage() {
  const principal = await appPrincipal("/app/settings/members");
  const view = await loadMembers(principal);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Members"
        description={`Who can see and build in ${view.orgName}, and the invites you have out.`}
      />

      {view.accountRequired ? (
        <AccountRequired
          title="Create your free account to invite teammates"
          body="10 seconds, no card. Your guest workspace comes with you, and the link you send puts them straight into it."
          next="/app/settings/members"
        >
          <MembersPanel view={view} />
        </AccountRequired>
      ) : (
        <MembersPanel view={view} />
      )}
    </div>
  );
}
