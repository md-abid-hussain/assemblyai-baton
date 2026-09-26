/**
 * `/sign-in` (SAAS §8.1, §3.2). WP20·2.
 *
 * A signed-in visitor is sent on rather than shown a form they do not need — the common way to land here with a
 * session is a stale tab or a bookmarked link, and re-authenticating is not what that person wants.
 * **A guest is not redirected**: signing in is exactly how a guest turns into an account (§3.4).
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthCard } from "@/components/auth/auth-card";
import { SignInForm } from "@/components/auth/sign-in-form";
import { oneParam, safeNextPath } from "@/core/contracts/ext/wp20-app";
import { githubProvider } from "@/server/identity/config";
import { visitorAuthState } from "@/server/read-models/app-guard";

export const metadata: Metadata = {
  title: { absolute: "Sign in · Changeover" },
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const next = safeNextPath(search.next);
  const inviteId = oneParam(search.invite, 64);

  const state = await visitorAuthState("/sign-in");
  if (state.signedIn) redirect(inviteId ? `/accept-invite/${encodeURIComponent(inviteId)}` : next);

  return (
    <AuthCard
      title="Welcome back"
      subtitle={
        inviteId
          ? "Sign in to accept your invitation."
          : "Sign in to your Changeover workspace."
      }
      footer={
        <>
          No account?{" "}
          <a
            href={`/sign-up?next=${encodeURIComponent(next)}${inviteId ? `&invite=${encodeURIComponent(inviteId)}` : ""}`}
            className="text-foreground font-medium underline underline-offset-4"
          >
            Create one free
          </a>{" "}
          — or{" "}
          <a href="/start" className="text-foreground font-medium underline underline-offset-4">
            try it with no signup
          </a>
          .
        </>
      }
    >
      <SignInForm
        next={next}
        inviteId={inviteId}
        showGitHub={githubProvider() !== null}
        isGuest={state.isGuest}
      />
    </AuthCard>
  );
}
