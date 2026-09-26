/**
 * `/accept-invite/[id]` (SAAS §8.1, §3.6). WP20·2.
 *
 * Four audiences, one page:
 *
 *  - **signed out** → the org name and the role, then sign-up (email prefilled) or sign-in;
 *  - **a guest** → the same, plus §3.4's promise that the guest workspace comes along;
 *  - **signed in as the invited person** → one button;
 *  - **signed in as somebody else** → said plainly, *before* the click, with a way out. Better Auth would refuse
 *    the accept anyway; a product that only discovers that after the button is a product that blames the user.
 *
 * The invitation id in the URL is a capability to *see* the card, never to join. It is also the only identifier
 * this page renders: the invited address appears masked, and in full only inside the sign-up form's own field.
 */
import type { Metadata } from "next";

import { AcceptInviteButton } from "@/components/auth/accept-invite";
import { AuthCard } from "@/components/auth/auth-card";
import { formatUtcDate, ROLE_HINT, ROLE_LABEL } from "@/core/contracts/ext/wp20-app";
import { visitorAuthState } from "@/server/read-models/app-guard";
import { emailOfUser, loadInvite } from "@/server/read-models/invite";

export const metadata: Metadata = {
  title: { absolute: "Invitation · Changeover" },
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** The dead-end card. One shape for "never existed", "expired", "revoked" and "already used". */
function DeadEnd({ title, body }: { title: string; body: string }) {
  return (
    <AuthCard title={title} subtitle={body}>
      <div className="flex flex-col gap-2">
        <a
          href="/app"
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 w-full items-center justify-center rounded-md text-sm font-medium transition-colors"
        >
          Open your workspace
        </a>
        <a
          href="/sign-in"
          className="hover:bg-accent inline-flex h-10 w-full items-center justify-center rounded-md border text-sm font-medium transition-colors"
        >
          Sign in
        </a>
      </div>
    </AuthCard>
  );
}

export default async function AcceptInvitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const invite = await loadInvite(id).catch(() => null);

  // An unknown id and a malformed one produce the same card on purpose: the difference would be a free oracle
  // for anyone enumerating ids, and neither visitor can do anything different about it.
  if (!invite) {
    return (
      <DeadEnd
        title="This invitation is not valid"
        body="The link may be mistyped, or the invitation may have been revoked. Ask whoever invited you for a fresh link."
      />
    );
  }

  if (invite.status === "accepted") {
    return (
      <DeadEnd
        title="This invitation was already used"
        body={`Someone has already joined ${invite.orgName} with this link. If that was you, sign in and switch workspace from the top bar.`}
      />
    );
  }
  if (invite.status === "expired" || invite.status === "canceled" || invite.status === "unknown") {
    return (
      <DeadEnd
        title={invite.status === "expired" ? "This invitation has expired" : "This invitation is no longer active"}
        body={`Invitations to ${invite.orgName} last 7 days. Ask an admin there to send a new link.`}
      />
    );
  }

  const state = await visitorAuthState("/accept-invite");
  const myEmail = state.signedIn ? await emailOfUser(state.userId).catch(() => null) : null;
  const matches =
    myEmail !== null && myEmail.trim().toLowerCase() === invite.emailPrefill.trim().toLowerCase();

  const signUpHref = `/sign-up?invite=${encodeURIComponent(invite.id)}`;
  const signInHref = `/sign-in?invite=${encodeURIComponent(invite.id)}`;

  return (
    <AuthCard
      title={`Join ${invite.orgName}`}
      subtitle={`You have been invited as ${ROLE_LABEL[invite.role]}.`}
      footer={<>Invitations expire on {formatUtcDate(invite.expiresAt)}.</>}
    >
      <div className="space-y-4">
        <dl className="space-y-2 text-sm">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground text-xs">Workspace</dt>
            <dd className="min-w-0 truncate font-medium">{invite.orgName}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground text-xs">Role</dt>
            <dd className="font-medium">{ROLE_LABEL[invite.role]}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground text-xs">Invited</dt>
            <dd className="cx-num min-w-0 truncate font-medium">{invite.emailMasked}</dd>
          </div>
        </dl>

        <p className="bg-muted/50 text-muted-foreground rounded-lg px-3 py-2 text-xs text-pretty">
          {ROLE_HINT[invite.role]}
        </p>

        {state.signedIn && matches ? (
          <AcceptInviteButton invitationId={invite.id} orgName={invite.orgName} />
        ) : state.signedIn ? (
          <div className="space-y-3">
            <p className="text-sm text-pretty">
              You are signed in as <span className="font-medium">{myEmail}</span>, and this invitation was sent
              to a different address. Sign out and sign in with the invited one, or ask for a new invitation to
              the address you use.
            </p>
            <a
              href={signInHref}
              className="hover:bg-accent inline-flex h-10 w-full items-center justify-center rounded-md border text-sm font-medium transition-colors"
            >
              Use a different account
            </a>
          </div>
        ) : (
          <div className="space-y-3">
            {state.isGuest ? (
              <p className="bg-muted/50 text-muted-foreground rounded-lg px-3 py-2 text-xs text-pretty">
                Your guest workspace comes with you — you will be in both it and {invite.orgName}.
              </p>
            ) : null}
            <a
              href={signUpHref}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 w-full items-center justify-center rounded-md text-sm font-medium transition-colors"
            >
              Create an account to join
            </a>
            <a
              href={signInHref}
              className="hover:bg-accent inline-flex h-10 w-full items-center justify-center rounded-md border text-sm font-medium transition-colors"
            >
              I already have an account
            </a>
          </div>
        )}
      </div>
    </AuthCard>
  );
}
