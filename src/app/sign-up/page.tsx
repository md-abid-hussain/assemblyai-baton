/**
 * `/sign-up` (SAAS §8.1, §3.2, §3.4, §3.6). WP20·2.
 *
 * **The invited address is looked up here, not carried in the URL.** `?invite=<id>` is the only thing the link
 * holds; the page reads the invitation server-side for the email to prefill. Putting the address in a query
 * string would write the invitee's email into browser history, the referrer of every asset on the page and any
 * access log in front of the deployment — for a value the page could simply fetch.
 *
 * A signed-in visitor is sent on. A guest is not: this page is how a guest becomes an account, and §3.4's
 * `onLinkAccount` runs inside the sign-up call itself.
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthCard } from "@/components/auth/auth-card";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { oneParam, safeNextPath } from "@/core/contracts/ext/wp20-app";
import { githubProvider } from "@/server/identity/config";
import { visitorAuthState } from "@/server/read-models/app-guard";
import { loadInvite } from "@/server/read-models/invite";

export const metadata: Metadata = {
  title: { absolute: "Create your account · Changeover" },
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const next = safeNextPath(search.next);
  const inviteId = oneParam(search.invite, 64);

  const state = await visitorAuthState("/sign-up");
  if (state.signedIn) redirect(inviteId ? `/accept-invite/${encodeURIComponent(inviteId)}` : next);

  // A dead or already-accepted invitation still lets the account be created; it just prefills nothing and says
  // nothing about an org. The page's job is the account, and refusing it would be a worse outcome than a
  // slightly emptier form.
  const invite = inviteId ? await loadInvite(inviteId).catch(() => null) : null;
  const usableInvite = invite && invite.status === "pending" ? invite : null;

  return (
    <AuthCard
      title={usableInvite ? `Join ${usableInvite.orgName}` : "Create your free account"}
      subtitle={
        usableInvite
          ? `Create an account with ${usableInvite.emailMasked} to accept the invitation.`
          : "10 seconds, no card, no verification email."
      }
      footer={
        <>
          Already have an account?{" "}
          <a
            href={`/sign-in?next=${encodeURIComponent(next)}${inviteId ? `&invite=${encodeURIComponent(inviteId)}` : ""}`}
            className="text-foreground font-medium underline underline-offset-4"
          >
            Sign in
          </a>
        </>
      }
    >
      <SignUpForm
        next={next}
        inviteId={usableInvite?.id}
        emailPrefill={usableInvite?.emailPrefill}
        showGitHub={githubProvider() !== null}
        isGuest={state.isGuest}
      />
    </AuthCard>
  );
}
