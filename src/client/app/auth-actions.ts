import "client-only";

/**
 * The Better Auth client calls WP20's pages make (SAAS §3.2, §3.5, §3.6, §3.8, §3.10). WP20·2.
 *
 * §3.8 splits the auth surface in two: **mutations that need a plan check and an audit row** go to
 * `/api/app/**` (`app-api.ts`), and **reads plus the user's own credentials** stay on the client plugin. This
 * module is the second half — sign in, sign up, sign out, switch org, accept an invitation, change your own
 * password, list and revoke your own sessions — and it exists so that no component imports `better-auth`
 * directly and every call comes back in the same `{ ok }` envelope as `app-api.ts`.
 *
 * Every function is total: a rejected promise from the auth client becomes a failure value, because each caller
 * is a form submit handler and a throw there is a blank screen with a console message nobody reads.
 */
import { authClient } from "@/client/identity/auth-client";

export interface AuthFailure {
  ok: false;
  code: string;
  message: string;
}
export type AuthResult<T = Record<string, never>> = ({ ok: true } & T) | AuthFailure;

export const isAuthFailure = <T>(r: AuthResult<T>): r is AuthFailure => r.ok === false;

/**
 * Better Auth's own messages are decent but occasionally internal ("Invalid email or password" is fine,
 * "USER_NOT_FOUND" is not), so a known code gets our sentence and anything else gets the server's message.
 */
const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "That email and password do not match an account.",
  USER_ALREADY_EXISTS: "An account with that email already exists. Sign in instead.",
  USER_NOT_FOUND: "That email and password do not match an account.",
  INVALID_PASSWORD: "That current password is not right.",
  PASSWORD_TOO_SHORT: "That password is too short.",
  FAILED_TO_CREATE_USER: "The account could not be created. Please try again.",
  E_USE_APP_API: "That action is handled by the app, not the browser. Please reload and try again.",
};

interface BetterAuthError {
  code?: string;
  message?: string;
  status?: number;
}

function failure(err: BetterAuthError | null | undefined, fallback: string): AuthFailure {
  const code = err?.code ?? "E_UNKNOWN";
  return { ok: false, code, message: MESSAGES[code] ?? err?.message ?? fallback };
}

/** Wraps one auth-client call. `data`/`error` is the client's own result shape. */
async function run<T>(
  fn: () => Promise<{ data?: unknown; error?: BetterAuthError | null }>,
  fallback: string,
  shape: (data: unknown) => T = () => ({}) as T,
): Promise<AuthResult<T>> {
  try {
    const res = await fn();
    if (res?.error) return failure(res.error, fallback);
    return { ...shape(res?.data), ok: true } as AuthResult<T>;
  } catch (err) {
    const e = err as BetterAuthError;
    return failure(e, fallback);
  }
}

// ------------------------------------------------------------------------------------------------- accounts

export const signInWithPassword = (email: string, password: string) =>
  run(() => authClient.signIn.email({ email, password }), "Could not sign in. Please try again.");

/**
 * §3.2: no verification email, and the name defaults to the email's local part rather than being required.
 *
 * When the browser holds an anonymous session, Better Auth's `onLinkAccount` (§3.4) fires inside this call and
 * carries the guest workspace over — same org id, same relay ids, same run ids. Nothing extra is needed here,
 * which is exactly why the forms can promise it.
 */
export const signUpWithPassword = (email: string, password: string, name?: string) =>
  run(
    () => authClient.signUp.email({ email, password, name: name?.trim() || email.split("@")[0] || "You" }),
    "Could not create the account. Please try again.",
  );

export const signOutNow = () => run(() => authClient.signOut(), "Could not sign out. Please try again.");

export const signInWithGitHub = (callbackURL: string) =>
  run(() => authClient.signIn.social({ provider: "github", callbackURL }), "Could not start GitHub sign-in.");

// ------------------------------------------------------------------------------------------- organizations

/** §3.5: `setActive` (Better Auth checks the membership), then the caller refreshes the server components. */
export const setActiveOrg = (organizationId: string) =>
  run(
    () => authClient.organization.setActive({ organizationId }),
    "Could not switch workspace. Please try again.",
  );

/** §3.6. Better Auth accepts only when the session user's email equals the invitation's — the link is not enough. */
export const acceptInvitation = (invitationId: string) =>
  run(
    () => authClient.organization.acceptInvitation({ invitationId }),
    "Could not accept the invitation. Please try again.",
  );

// -------------------------------------------------------------------------------------- the user's own account

export const changeOwnPassword = (currentPassword: string, newPassword: string, revokeOtherSessions: boolean) =>
  run(
    () => authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions }),
    "Could not change the password. Please try again.",
  );

/**
 * Revoking one session by its **id**.
 *
 * Better Auth's `revokeSession` takes the session **token**, not its id — and a token is a live credential for
 * that device. The Profile page is server-rendered, so putting tokens in the row markup would ship every one of
 * the user's session credentials into the HTML of a page, where an XSS or a stray cache would collect the lot.
 * Instead the page renders ids, and the token is fetched at the moment of the click and used immediately. The
 * cost is one extra round trip on a button nobody presses twice; the alternative was a credential in the DOM.
 */
export async function revokeSessionById(sessionId: string): Promise<AuthResult> {
  try {
    const listed = await authClient.listSessions();
    if (listed?.error) return failure(listed.error, "Could not load your sessions.");
    const rows = (listed?.data ?? []) as { id?: string; token?: string }[];
    const token = rows.find((r) => r.id === sessionId)?.token;
    if (!token) {
      return { ok: false, code: "E_NOT_FOUND", message: "That session has already ended." };
    }
    return await run(() => authClient.revokeSession({ token }), "Could not revoke that session.");
  } catch (err) {
    return failure(err as BetterAuthError, "Could not revoke that session.");
  }
}

/** "Sign out everywhere else" — no token needed, so it is the one that always works. */
export const revokeOtherSessions = () =>
  run(() => authClient.revokeOtherSessions(), "Could not sign out the other sessions.");
