/**
 * Settings → Profile (SAAS §8.4). WP20·2.
 *
 * "Self" permission: there is nothing here to authorise beyond having a principal, and every call the panel
 * makes acts on the caller's own user. A **guest** is not turned away — they see the real page with the §8.5
 * card over it, because "what would I get if I signed up" is a fair question to answer with the screen itself.
 */
import type { Metadata } from "next";
import { headers } from "next/headers";

import { AccountRequired } from "@/components/app-shell/account-required";
import { PageHeader } from "@/components/app-shell/bits";
import { ProfilePanel } from "@/components/settings/profile-panel";
import { appPrincipal } from "@/server/read-models/app-guard";
import { currentSessionId, loadProfile } from "@/server/read-models/profile";

export const metadata: Metadata = { title: "Profile" };
export const dynamic = "force-dynamic";

export default async function ProfileSettingsPage() {
  const principal = await appPrincipal("/app/settings/profile");
  const sessionId = await currentSessionId(await headers());
  const profile = await loadProfile(principal, { currentSessionId: sessionId });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Profile"
        description="Your account, your password and the devices you are signed in on."
      />

      {profile.isGuest ? (
        <AccountRequired
          title="Create your free account to keep this workspace"
          body="10 seconds, no card, no verification email. Your relays, runs and settings come with you, and this page becomes yours."
          next="/app/settings/profile"
        >
          <ProfilePanel profile={profile} />
        </AccountRequired>
      ) : (
        <ProfilePanel profile={profile} />
      )}
    </div>
  );
}
