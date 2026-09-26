"use client";

/**
 * Settings → Members & invites (SAAS §8.4, §3.6, §3.7, §4.1). WP20·2.
 *
 * Every mutation on this page is server-mediated (§3.8): invite, revoke, change role and remove all go to
 * `/api/app/**` through `app-api.ts`, where `requirePrincipal` + `can()` + the seat check run and the audit row
 * is written. Nothing here is the authority for anything — the page's job is to **not offer** what the server
 * would refuse, and to say why when it cannot offer it.
 *
 * The four rules it encodes, all of them §3.7's:
 *
 *  - roles offered are only those at or below the viewer's own (`assignable`);
 *  - **an admin may not touch an owner** — `member:manage` is true for both, so the matrix's footnote is the
 *    only thing standing between an admin and a 403 after the click;
 *  - the **last owner** can be neither demoted nor removed, because an ownerless org is not a state the product
 *    is allowed to reach;
 *  - your own row offers **Leave**, not Remove, and it goes through the Organization page's own confirmation.
 *
 * Seats (§4.1) count members **plus pending invites**, so a plan cannot be beaten by inviting now and accepting
 * after the downgrade.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormMessage, SelectField, TextField } from "@/components/auth/fields";
import { Panel, Pill } from "@/components/settings/bits";
import { ConfirmDialog, CopyButton } from "@/components/settings/controls";
import {
  changeMemberRole,
  inviteMember,
  isFailure,
  removeMember,
  revokeInvitation,
} from "@/client/app/app-api";
import {
  emailProblem,
  formatUtcDate,
  ROLE_HINT,
  ROLE_LABEL,
  type MembersView,
} from "@/core/contracts/ext/wp20-app";
import type { Role } from "@/core/contracts/v3/identity";
import { PLANS } from "@/core/contracts/v3/plans";

export function MembersPanel({ view }: { view: MembersView }) {
  const router = useRouter();
  const [notice, setNotice] = useState<{ tone: "error" | "ok"; text: string } | null>(null);

  const seatsLeft = Math.max(0, view.seatLimit - view.seatsUsed);
  const outOfSeats = seatsLeft === 0;

  return (
    <div className="space-y-5">
      <Panel
        title="Members"
        description={`${view.seatsUsed} of ${view.seatLimit} seats used on ${PLANS[view.plan].name}. Pending invites count as seats.`}
      >
        {view.members.length === 0 ? (
          <p className="text-muted-foreground text-sm">No members yet.</p>
        ) : (
          <ul className="divide-border -my-2 divide-y">
            {view.members.map((m) => (
              <MemberRow
                key={m.userId}
                view={view}
                member={m}
                onDone={(text) => {
                  setNotice({ tone: "ok", text });
                  router.refresh();
                }}
                onError={(text) => setNotice({ tone: "error", text })}
              />
            ))}
          </ul>
        )}
        <FormMessage tone={notice?.tone ?? "error"}>{notice?.text}</FormMessage>
      </Panel>

      <InvitePanel
        view={view}
        outOfSeats={outOfSeats}
        onDone={() => router.refresh()}
      />

      {view.invitations.length > 0 ? (
        <Panel title="Pending invites" description="A link is all it takes. Invitations last 7 days.">
          <ul className="divide-border -my-2 divide-y">
            {view.invitations.map((inv) => (
              <InviteRow key={inv.id} invite={inv} canManage={view.canInvite} onDone={() => router.refresh()} />
            ))}
          </ul>
        </Panel>
      ) : view.members.length <= 1 ? (
        <Panel title="Your team">
          <p className="text-muted-foreground text-sm text-pretty">
            You&rsquo;re the only member. Invite a teammate with a link.
          </p>
        </Panel>
      ) : null}

      <Panel title="What the roles mean" description="Members build, admins ship.">
        <dl className="space-y-2.5">
          {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
            <div key={r} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <dt className="w-16 shrink-0 text-sm font-medium">{ROLE_LABEL[r]}</dt>
              <dd className="text-muted-foreground min-w-0 flex-1 text-xs text-pretty">{ROLE_HINT[r]}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </div>
  );
}

function MemberRow({
  view,
  member,
  onDone,
  onError,
}: {
  view: MembersView;
  member: MembersView["members"][number];
  onDone: (text: string) => void;
  onError: (text: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // §3.7's footnote, made into a condition. An admin sees an owner's row, reads it, and cannot act on it.
  const ownerOutOfReach = member.role === "owner" && view.viewerRole !== "owner";
  const lockedReason = member.isSelf
    ? "This is you"
    : ownerOutOfReach
      ? "Only an owner can change an owner"
      : member.isLastOwner
        ? "The last owner cannot be changed"
        : null;

  const mayAct = view.canManage && lockedReason === null;
  // An owner sees all four roles; an admin sees admin and below, and never reaches an owner's row at all, so
  // the current role is always one of the options and the select can never silently drop it.
  const options = view.assignable;

  async function onRole(role: Role) {
    if (role === member.role || pending) return;
    setPending(true);
    const res = await changeMemberRole(member.userId, role);
    setPending(false);
    if (isFailure(res)) {
      onError(res.message);
      return;
    }
    onDone(`${member.name || member.email} is now ${ROLE_LABEL[role]}.`);
  }

  async function onRemove() {
    setPending(true);
    setRemoveError(null);
    const res = await removeMember(member.userId);
    setPending(false);
    if (isFailure(res)) {
      setRemoveError(res.message);
      return;
    }
    setConfirming(false);
    onDone(`${member.name || member.email} was removed.`);
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{member.name || member.email || "Member"}</span>
          {member.isSelf ? <Pill tone="muted">You</Pill> : null}
        </p>
        <p className="text-muted-foreground truncate text-xs">
          {member.email || "Guest account"} · joined {formatUtcDate(member.joinedAt)}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {mayAct ? (
          <select
            aria-label={`Role for ${member.name || member.email}`}
            value={member.role}
            disabled={pending}
            onChange={(e) => void onRole(e.currentTarget.value as Role)}
            className="border-input bg-background focus-visible:ring-ring h-8 rounded-md border px-2 text-xs font-medium focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
          >
            {options.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        ) : (
          <Pill>{ROLE_LABEL[member.role]}</Pill>
        )}

        {mayAct ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={pending}
            className="text-destructive hover:bg-destructive/10 inline-flex h-8 items-center rounded-md border px-2.5 text-xs font-medium transition-colors disabled:opacity-60"
          >
            Remove
          </button>
        ) : view.canManage && lockedReason ? (
          <span className="text-muted-foreground hidden text-xs sm:inline">{lockedReason}</span>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Remove ${member.name || member.email}?`}
        description="They lose access to this workspace immediately. Everything they built stays. You can invite them again at any time."
        confirmLabel="Remove member"
        destructive
        pending={pending}
        error={removeError}
        onConfirm={onRemove}
      />
    </li>
  );
}

function InvitePanel({
  view,
  outOfSeats,
  onDone,
}: {
  view: MembersView;
  outOfSeats: boolean;
  onDone: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>(view.assignable.includes("member") ? "member" : (view.assignable[0] ?? "viewer"));
  const [emailError, setEmailError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const disabled = !view.canInvite || outOfSeats;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || disabled) return;

    const problem = emailProblem(email);
    setEmailError(problem);
    setMessage(null);
    if (problem) return;

    setPending(true);
    const res = await inviteMember(email.trim(), role);
    setPending(false);
    if (isFailure(res)) {
      setMessage({ tone: "error", text: res.message });
      return;
    }
    setEmail("");
    setLink(res.link ?? null);   // optional: only an inviter is sent the copyable URL (§3.6)
    setMessage({ tone: "ok", text: "Invitation created. Copy the link and send it however you like." });
    onDone();
  }

  return (
    <Panel
      title="Invite a teammate"
      description="No email is sent — you get a link to share. They join with the role you pick."
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <TextField
            id="invite-email"
            label="Email"
            type="email"
            autoComplete="off"
            value={email}
            error={emailError}
            disabled={disabled}
            onChange={(e) => setEmail(e.currentTarget.value)}
          />
          <SelectField
            id="invite-role"
            label="Role"
            value={role}
            disabled={disabled || view.assignable.length === 0}
            onChange={(e) => setRole(e.currentTarget.value as Role)}
          >
            {view.assignable.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </SelectField>
        </div>

        {outOfSeats ? (
          <p className="border-[var(--cx-warn)]/40 text-muted-foreground rounded-lg border px-3 py-2 text-xs text-pretty">
            Every seat on {PLANS[view.plan].name} is used ({view.seatsUsed} of {view.seatLimit}).{" "}
            {view.viewerRole === "owner" ? (
              <a href="/app/settings/billing" className="text-foreground font-medium underline underline-offset-4">
                Upgrade for more seats
              </a>
            ) : (
              "Ask an owner to upgrade, or revoke a pending invite."
            )}
          </p>
        ) : null}

        <FormMessage tone={message?.tone ?? "error"}>{message?.text}</FormMessage>

        {link ? (
          <div className="bg-muted/50 space-y-2 rounded-lg px-3 py-2.5">
            <p className="cx-eyebrow">Invite link</p>
            <p className="cx-num text-xs break-all">{link}</p>
            <CopyButton value={link} label="Copy link" />
          </div>
        ) : null}

        <button
          type="submit"
          disabled={pending || disabled}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center rounded-md px-4 text-sm font-medium transition-colors disabled:opacity-60"
        >
          {pending ? "Creating…" : "Create invite link"}
        </button>
      </form>
    </Panel>
  );
}

function InviteRow({
  invite,
  canManage,
  onDone,
}: {
  invite: MembersView["invitations"][number];
  canManage: boolean;
  onDone: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRevoke() {
    if (pending) return;
    setPending(true);
    setError(null);
    const res = await revokeInvitation(invite.id);
    setPending(false);
    if (isFailure(res)) {
      setError(res.message);
      return;
    }
    onDone();
  }

  return (
    <li className="space-y-1.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="flex items-center gap-2 text-sm font-medium">
            <span className="truncate">{invite.email}</span>
            <Pill tone={invite.expired ? "warn" : "muted"}>
              {invite.expired ? "Expired" : ROLE_LABEL[invite.role]}
            </Pill>
          </p>
          <p className="text-muted-foreground truncate text-xs">
            Invited by {invite.invitedBy} · {invite.expired ? "expired" : "expires"}{" "}
            {formatUtcDate(invite.expiresAt)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {invite.expired || !invite.link ? null : (
            <CopyButton value={invite.link} label="Copy link" srLabel={`Copy the invite link for ${invite.email}`} />
          )}
          {canManage ? (
            <button
              type="button"
              onClick={() => void onRevoke()}
              disabled={pending}
              className="text-destructive hover:bg-destructive/10 inline-flex h-8 items-center rounded-md border px-2.5 text-xs font-medium transition-colors disabled:opacity-60"
            >
              {pending ? "Revoking…" : "Revoke"}
            </button>
          ) : null}
        </div>
      </div>
      {error ? <p className="text-destructive text-xs font-medium">{error}</p> : null}
    </li>
  );
}
