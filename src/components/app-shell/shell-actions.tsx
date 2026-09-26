"use client";

/**
 * The two shell controls that needed a browser to become real (SAAS §3.5, §3.8, §8.2). WP20·2.
 *
 * `AppShell` is a server component, so it cannot hand a function to a client island. These wrappers are the
 * seam: they are the client boundary, they own the `setActive` + `router.refresh()` pair and the sign-out, and
 * they pass plain handlers down to the presentational `OrgSwitcher` and `UserMenu` that WP20·1 already tested.
 *
 * **Why `router.refresh()` and not a reload.** Every `/app` page is a server component reading through the
 * principal, so the active org changes what the *server* renders, not what the browser filters. `refresh()`
 * re-runs those server components against the new cookie and keeps the scroll position; a `location.reload()`
 * would work too and would throw away the page the user was looking at.
 *
 * Failures surface as a toast rather than as silence. A switcher that appears to do nothing is the worst of the
 * three outcomes, because the user's next move is to assume the data they are looking at is the other org's.
 */
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { toast } from "sonner";

import { isAuthFailure, setActiveOrg, signOutNow } from "@/client/app/auth-actions";
import type { ViewerSummary } from "@/core/contracts/ext/wp20-app";
import type { OrgSummary } from "@/core/contracts/v3/identity";

import { OrgSwitcher } from "./org-switcher";
import { UserMenu } from "./user-menu";

export function LiveOrgSwitcher({
  orgs,
  activeId,
  canCreateOrg,
}: {
  orgs: readonly OrgSummary[];
  activeId: string | null;
  canCreateOrg: boolean;
}) {
  const router = useRouter();

  const onSwitch = useCallback(
    async (orgId: string) => {
      const res = await setActiveOrg(orgId);
      if (isAuthFailure(res)) {
        toast.error(res.message);
        return;
      }
      router.refresh();
    },
    [router],
  );

  // A single workspace has nothing to switch to, and a guest's workspace is not switchable at all: passing the
  // handler anyway would light up rows that cannot move. `OrgSwitcher` already says so when `onSwitch` is absent.
  const switchable = orgs.length > 1;

  return (
    <OrgSwitcher
      orgs={orgs}
      activeId={activeId}
      canCreateOrg={canCreateOrg}
      onSwitch={switchable ? onSwitch : undefined}
    />
  );
}

export function LiveUserMenu({ viewer }: { viewer: ViewerSummary }) {
  const router = useRouter();

  const onSignOut = useCallback(async () => {
    const res = await signOutNow();
    if (isAuthFailure(res)) {
      toast.error(res.message);
      return;
    }
    // Not `router.push("/")`: after sign-out the client cache still holds the signed-in render of every `/app`
    // page it has seen. `refresh()` first, then the hard navigation, so nothing stale can be shown on the way.
    router.refresh();
    window.location.assign("/");
  }, [router]);

  // A guest has nothing to sign out of; the menu offers "Create account" instead (SAAS §8.2).
  return <UserMenu viewer={viewer} onSignOut={viewer.isGuest ? undefined : onSignOut} />;
}
