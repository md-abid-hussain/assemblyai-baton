"use client";

/**
 * Settings → Profile (SAAS §8.4, §3.10). WP20·2.
 *
 * Change password, the linked providers and the active sessions. All three are §3.8 *reads or self-service*, so
 * they stay on the Better Auth client rather than going through `/api/app/**`: nothing here touches another
 * member, an entitlement or an org.
 *
 * **Revoking a session is the one control that can lock the user out of the tab they are in.** The current
 * session's row therefore has no Revoke — signing yourself out is the user menu's job and it says so — and
 * "Sign out everywhere else" is the deliberate way to do the same thing to the other devices.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormMessage, TextField } from "@/components/auth/fields";
import { DangerPanel, Fact, FactList, Panel, Pill, Row } from "@/components/settings/bits";
import {
  changeOwnPassword,
  isAuthFailure,
  revokeOtherSessions,
  revokeSessionById,
} from "@/client/app/auth-actions";
import {
  formatUtcDate,
  passwordProblem,
  PASSWORD_MIN_LENGTH,
  type ProfileView,
} from "@/core/contracts/ext/wp20-app";

const PROVIDER_LABEL: Record<string, string> = {
  credential: "Email and password",
  github: "GitHub",
};

export function ProfilePanel({ profile }: { profile: ProfileView }) {
  return (
    <div className="space-y-5">
      <Panel title="Account" description="Your name and email. The email cannot be changed in this build.">
        <FactList>
          <Fact label="Name">{profile.name}</Fact>
          <Fact label="Email">{profile.email ?? "No account yet"}</Fact>
          <Fact label="Joined">{profile.createdAt ? formatUtcDate(profile.createdAt) : "—"}</Fact>
          <Fact label="Sign-in methods">
            {profile.providers.length > 0
              ? profile.providers.map((p) => PROVIDER_LABEL[p] ?? p).join(", ")
              : "Guest — no sign-in method yet"}
          </Fact>
        </FactList>
      </Panel>

      {profile.hasPassword ? <PasswordPanel /> : null}

      <SessionsPanel sessions={profile.sessions} />

      {profile.isGuest ? null : (
        <DangerPanel>
          <Row
            title="Delete your account"
            body="Account deletion is not enabled in this build. An owner can delete a workspace from Organization, which removes its data."
            action={
              <button
                type="button"
                disabled
                className="border-destructive/40 text-destructive inline-flex h-9 cursor-not-allowed items-center rounded-md border px-3 text-sm font-medium opacity-50"
              >
                Delete account
              </button>
            }
          />
        </DangerPanel>
      )}
    </div>
  );
}

function PasswordPanel() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [revokeOthers, setRevokeOthers] = useState(true);
  const [nextError, setNextError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const router = useRouter();

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const problem = passwordProblem(next);
    setNextError(problem);
    setMessage(null);
    if (problem) return;
    if (current.length === 0) {
      setMessage({ tone: "error", text: "Enter your current password." });
      return;
    }

    setPending(true);
    const res = await changeOwnPassword(current, next, revokeOthers);
    setPending(false);
    if (isAuthFailure(res)) {
      setMessage({ tone: "error", text: res.message });
      return;
    }
    setCurrent("");
    setNext("");
    setMessage({ tone: "ok", text: "Password changed." });
    // The session list changes when the other sessions are revoked, so the server render is now stale.
    router.refresh();
  }

  return (
    <Panel title="Change password" description="You stay signed in on this device.">
      <form onSubmit={onSubmit} noValidate className="max-w-sm space-y-4">
        <TextField
          id="current-password"
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.currentTarget.value)}
        />
        <TextField
          id="new-password"
          label="New password"
          type="password"
          autoComplete="new-password"
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          value={next}
          error={nextError}
          onChange={(e) => setNext(e.currentTarget.value)}
        />
        <label className="flex items-start gap-2.5 text-xs">
          <input
            type="checkbox"
            checked={revokeOthers}
            onChange={(e) => setRevokeOthers(e.currentTarget.checked)}
            className="border-input mt-0.5 size-4 shrink-0 rounded"
          />
          <span className="text-muted-foreground text-pretty">Sign out of every other device.</span>
        </label>

        <FormMessage tone={message?.tone ?? "error"}>{message?.text}</FormMessage>

        <button
          type="submit"
          disabled={pending}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center rounded-md px-4 text-sm font-medium transition-colors disabled:opacity-60"
        >
          {pending ? "Changing…" : "Change password"}
        </button>
      </form>
    </Panel>
  );
}

function SessionsPanel({ sessions }: { sessions: ProfileView["sessions"] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const router = useRouter();
  const others = sessions.filter((s) => !s.current).length;

  async function onRevoke(id: string) {
    if (busy) return;
    setBusy(id);
    setMessage(null);
    const res = await revokeSessionById(id);
    setBusy(null);
    if (isAuthFailure(res)) {
      setMessage({ tone: "error", text: res.message });
      return;
    }
    setMessage({ tone: "ok", text: "That session was signed out." });
    router.refresh();
  }

  async function onRevokeOthers() {
    if (busy) return;
    setBusy("others");
    setMessage(null);
    const res = await revokeOtherSessions();
    setBusy(null);
    if (isAuthFailure(res)) {
      setMessage({ tone: "error", text: res.message });
      return;
    }
    setMessage({ tone: "ok", text: "Every other device was signed out." });
    router.refresh();
  }

  return (
    <Panel
      title="Active sessions"
      description="Where you are signed in. No IP addresses are stored on this screen."
      actions={
        others > 0 ? (
          <button
            type="button"
            onClick={() => void onRevokeOthers()}
            disabled={busy !== null}
            className="hover:bg-accent inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium transition-colors disabled:opacity-60"
          >
            {busy === "others" ? "Signing out…" : "Sign out everywhere else"}
          </button>
        ) : null
      }
    >
      {sessions.length === 0 ? (
        <p className="text-muted-foreground text-sm">No stored sessions — this browser is signed in as a guest.</p>
      ) : (
        <ul className="divide-border -my-2 divide-y">
          {sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
              <div className="min-w-0 space-y-0.5">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {s.device}
                  {s.current ? <Pill tone="good">This device</Pill> : null}
                </p>
                <p className="text-muted-foreground text-xs">
                  Started {formatUtcDate(s.createdAt)} · expires {formatUtcDate(s.expiresAt)}
                </p>
              </div>
              {s.current ? (
                <span className="text-muted-foreground text-xs">Sign out from the account menu</span>
              ) : (
                <button
                  type="button"
                  onClick={() => void onRevoke(s.id)}
                  disabled={busy !== null}
                  className="hover:bg-accent inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium transition-colors disabled:opacity-60"
                >
                  {busy === s.id ? "Revoking…" : "Revoke"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <FormMessage tone={message?.tone ?? "error"}>{message?.text}</FormMessage>
    </Panel>
  );
}
