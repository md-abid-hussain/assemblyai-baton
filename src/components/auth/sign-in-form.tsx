"use client";

/**
 * `/sign-in`'s form (SAAS §3.2, §3.10). WP20·2.
 *
 * **Why a full navigation and not `router.push`.** Signing in replaces the session cookie, and every `/app` page
 * is a server component that reads through the principal. `router.push` would reuse the client cache entries
 * rendered for the *previous* session — in the guest → account case, the guest's render of the page they were on.
 * `location.assign` throws the cache away, which is the only outcome that cannot show one identity's data under
 * another's name. It costs one document load on a page a person visits once.
 *
 * **What is deliberately not validated here.** The password is only checked for being non-empty. Applying
 * `passwordProblem`'s 10-character minimum to a *sign-in* would tell the holder of a shorter legacy password
 * that their own password is invalid, and it would leak the rule to someone guessing. Length belongs to sign-up.
 */
import Link from "next/link";
import { useState } from "react";

import { emailProblem } from "@/core/contracts/ext/wp20-app";
import { isAuthFailure, signInWithGitHub, signInWithPassword } from "@/client/app/auth-actions";

import { CarryOverNote } from "./auth-card";
import { FormMessage, TextField } from "./fields";

export interface SignInFormProps {
  /** Same-origin path, already through `safeNextPath` on the server. */
  next: string;
  /** When the visitor arrived from an invitation, the accept page is where a successful sign-in goes. */
  inviteId?: string;
  showGitHub: boolean;
  /** The browser holds an anonymous session, so §3.4 will carry the guest workspace over. */
  isGuest: boolean;
}

export function SignInForm({ next, inviteId, showGitHub, isGuest }: SignInFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const destination = inviteId ? `/accept-invite/${encodeURIComponent(inviteId)}` : next;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const e = emailProblem(email);
    const p = password.length === 0 ? "Enter your password." : null;
    setEmailError(e);
    setPasswordError(p);
    setFormError(null);
    if (e || p) return;

    setPending(true);
    const res = await signInWithPassword(email.trim(), password);
    if (isAuthFailure(res)) {
      setPending(false);
      setFormError(res.message);
      return;
    }
    // Stays `true` on purpose: the button must not become pressable again during the navigation.
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
          id="signin-email"
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          autoFocus
          required
          value={email}
          error={emailError}
          onChange={(e) => setEmail(e.currentTarget.value)}
        />
        <TextField
          id="signin-password"
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          error={passwordError}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />

        <FormMessage tone="error">{formError}</FormMessage>

        <button
          type="submit"
          disabled={pending}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 w-full items-center justify-center rounded-md text-sm font-medium transition-colors disabled:opacity-60"
        >
          {pending ? "Signing in…" : "Sign in"}
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

      {/*
        SAAS §3.10 asks for this sentence verbatim rather than a "Forgot password?" link to a page that cannot
        work. A dead link is the one thing that makes a demo feel unfinished; a plain explanation does not.
      */}
      <p className="text-muted-foreground text-xs text-pretty">
        Password reset needs email, which this demo does not send.{" "}
        {showGitHub ? "Sign in with GitHub (if linked), or ask an org owner to re-invite you." : "Ask an org owner to re-invite you."}
      </p>

      <p className="text-muted-foreground text-xs">
        New here?{" "}
        <Link
          href={`/sign-up?next=${encodeURIComponent(next)}${inviteId ? `&invite=${encodeURIComponent(inviteId)}` : ""}`}
          className="text-foreground font-medium underline underline-offset-4"
        >
          Create a free account
        </Link>
      </p>
    </div>
  );
}
