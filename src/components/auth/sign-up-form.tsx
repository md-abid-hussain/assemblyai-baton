"use client";

/**
 * `/sign-up`'s form (SAAS §3.2, §3.4). WP20·2.
 *
 * The 10-second account. Three fields, one of them optional, no verification email, and one sentence that says
 * so — because the objection a visitor actually has at this point is "am I about to lose what I just built" and
 * "is a confirmation mail going to make me switch tabs".
 *
 * **The email field is prefilled from an invitation and left editable.** Better Auth accepts an invitation only
 * when the session user's email equals the invited one, so editing it away simply produces an account that
 * cannot accept — which the accept page then says in words. Locking the field would be a false constraint: the
 * person may genuinely want an account under a different address, and they are allowed to have one.
 *
 * **The terms checkbox gates the button, not the request.** It is a placeholder document (§8.6) on a demo, so
 * the honest implementation is a real checkbox with a real link and no server-side claim that it was recorded.
 */
import Link from "next/link";
import { useState } from "react";

import { emailProblem, passwordProblem, PASSWORD_MIN_LENGTH } from "@/core/contracts/ext/wp20-app";
import { isAuthFailure, signInWithGitHub, signUpWithPassword } from "@/client/app/auth-actions";

import { CarryOverNote } from "./auth-card";
import { FormMessage, TextField } from "./fields";

export interface SignUpFormProps {
  next: string;
  inviteId?: string;
  /** The invited address (SAAS §3.6). Never rendered anywhere but in this field. */
  emailPrefill?: string;
  showGitHub: boolean;
  isGuest: boolean;
}

export function SignUpForm({ next, inviteId, emailPrefill, showGitHub, isGuest }: SignUpFormProps) {
  const [email, setEmail] = useState(emailPrefill ?? "");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const destination = inviteId ? `/accept-invite/${encodeURIComponent(inviteId)}` : next;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const e = emailProblem(email);
    const p = passwordProblem(password);
    setEmailError(e);
    setPasswordError(p);
    setFormError(null);
    if (e || p) return;

    setPending(true);
    const res = await signUpWithPassword(email.trim(), password, name);
    if (isAuthFailure(res)) {
      setPending(false);
      setFormError(res.message);
      return;
    }
    window.location.assign(destination);
  }

  async function onGitHub() {
    if (pending) return;
    setPending(true);
    setFormError(null);
    const res = await signInWithGitHub(destination);
    if (isAuthFailure(res)) {
      setPending(false);
      setFormError(res.message);
    }
  }

  return (
    <div className="space-y-4">
      {isGuest ? <CarryOverNote /> : null}

      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <TextField
          id="signup-email"
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          autoFocus={!emailPrefill}
          required
          value={email}
          error={emailError}
          hint="No verification email. A throwaway address like you+changeover@example.com works."
          onChange={(e) => setEmail(e.currentTarget.value)}
        />
        <TextField
          id="signup-password"
          label="Password"
          type="password"
          name="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          value={password}
          error={passwordError}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
        <TextField
          id="signup-name"
          label={
            <>
              Name <span className="text-muted-foreground font-normal">(optional)</span>
            </>
          }
          type="text"
          name="name"
          autoComplete="name"
          value={name}
          hint="Used to name your workspace. Defaults to the first part of your email."
          onChange={(e) => setName(e.currentTarget.value)}
        />

        <label className="flex items-start gap-2.5 text-xs">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.currentTarget.checked)}
            className="border-input mt-0.5 size-4 shrink-0 rounded"
          />
          <span className="text-muted-foreground text-pretty">
            I agree to the{" "}
            <Link href="/legal/terms" className="text-foreground underline underline-offset-4">
              terms
            </Link>
            .
          </span>
        </label>

        <FormMessage tone="error">{formError}</FormMessage>

        <button
          type="submit"
          disabled={pending || !accepted}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 w-full items-center justify-center rounded-md text-sm font-medium transition-colors disabled:opacity-60"
        >
          {pending ? "Creating your account…" : "Create free account"}
        </button>
      </form>

      {showGitHub ? (
        <>
          <div className="flex items-center gap-3">
            <span className="bg-border h-px flex-1" aria-hidden="true" />
            <span className="text-muted-foreground text-xs">or</span>
            <span className="bg-border h-px flex-1" aria-hidden="true" />
          </div>
          <button
            type="button"
            onClick={() => void onGitHub()}
            disabled={pending}
            className="hover:bg-accent inline-flex h-10 w-full items-center justify-center rounded-md border text-sm font-medium transition-colors disabled:opacity-60"
          >
            Continue with GitHub
          </button>
        </>
      ) : null}

      <p className="text-muted-foreground text-xs">
        Already have an account?{" "}
        <Link
          href={`/sign-in?next=${encodeURIComponent(next)}${inviteId ? `&invite=${encodeURIComponent(inviteId)}` : ""}`}
          className="text-foreground font-medium underline underline-offset-4"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
