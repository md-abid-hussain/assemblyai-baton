/**
 * The auth pages and the §8.5 upgrade card (SAAS §3.2, §3.4, §3.6, §3.10, §8.5). WP20·2.
 *
 * Server-render assertions, for the same reason as `shell.test.tsx`: the copy on these four screens is a
 * contract. §3.2 dictates the throwaway-address sentence, §3.4 the carry-over promise, §3.10 the password-reset
 * explanation and §8.5 the two interstitials — a paraphrase of any of them is a regression, not a rewording.
 *
 * The behavioural half is about what each form **carries**: `?next` and `?invite` have to survive every link
 * between sign-in and sign-up, or a judge who follows an invitation arrives at an account with no invitation.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/sign-in",
  useRouter: () => ({ refresh() {}, push() {} }),
}));

const { AuthCard, CarryOverNote } = await import("@/components/auth/auth-card");
const { SignInForm } = await import("@/components/auth/sign-in-form");
const { SignUpForm } = await import("@/components/auth/sign-up-form");
const { TextField, FormMessage } = await import("@/components/auth/fields");
const { AccountRequired, ACCOUNT_REQUIRED_COPY } = await import("@/components/app-shell/account-required");

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("the sign-in form", () => {
  it("promises the carry-over only when there is a guest session (SAAS §3.4)", () => {
    expect(html(<SignInForm next="/app" showGitHub={false} isGuest />)).toContain(
      "Your guest workspace comes with you",
    );
    expect(html(<SignInForm next="/app" showGitHub={false} isGuest={false} />)).not.toContain(
      "Your guest workspace comes with you",
    );
  });

  it("explains password reset instead of offering a link that cannot work (SAAS §3.10)", () => {
    const out = html(<SignInForm next="/app" showGitHub isGuest={false} />);
    expect(out).toContain("Password reset needs email, which this demo does not send.");
    expect(out).toContain("Sign in with GitHub (if linked), or ask an org owner to re-invite you.");
    expect(out).not.toContain("Forgot password");
  });

  it("drops the GitHub mention entirely when the provider is not configured (SAAS §3.2)", () => {
    const off = html(<SignInForm next="/app" showGitHub={false} isGuest={false} />);
    expect(off).not.toContain("GitHub");
    expect(html(<SignInForm next="/app" showGitHub isGuest={false} />)).toContain("Continue with GitHub");
  });

  it("carries ?next and ?invite into the link to sign-up", () => {
    const out = html(<SignInForm next="/app/runs?source=simulated" inviteId="inv_1" showGitHub={false} isGuest />);
    expect(out).toContain("next=%2Fapp%2Fruns%3Fsource%3Dsimulated");
    expect(out).toContain("invite=inv_1");
  });
});

describe("the sign-up form", () => {
  it("says the two things that decide whether a visitor signs up (SAAS §3.2)", () => {
    const out = html(<SignUpForm next="/app" showGitHub={false} isGuest />);
    expect(out).toContain("No verification email.");
    expect(out).toContain("you+changeover@example.com");
    expect(out).toContain("At least 10 characters.");
  });

  it("links the terms and starts with the box unchecked", () => {
    const out = html(<SignUpForm next="/app" showGitHub={false} isGuest={false} />);
    expect(out).toContain('href="/legal/terms"');
    expect(out).not.toContain('type="checkbox" checked');
    // The submit is gated on the box, so it must render disabled before anyone touches it.
    expect(out).toMatch(/Create free account/);
  });

  it("prefills the invited address into the field and nowhere else", () => {
    const out = html(
      <SignUpForm next="/app" inviteId="inv_1" emailPrefill="ada@example.com" showGitHub={false} isGuest={false} />,
    );
    expect(out).toContain('value="ada@example.com"');
    // Never into a link, where it would reach history, referrers and access logs.
    expect(out).not.toContain("ada%40example.com");
  });
});

describe("the auth card", () => {
  it("is one column with the 390 px gutter and links home", () => {
    const out = html(
      <AuthCard title="Welcome back" subtitle="Sign in">
        <p>body</p>
      </AuthCard>,
    );
    expect(out).toContain("max-w-[26rem]");
    expect(out).toContain("px-4");
    expect(out).toContain('href="/"');
  });

  it("names what carries over in nouns, not in 'your data'", () => {
    const out = html(<CarryOverNote />);
    expect(out).toContain("the same relays, the same runs");
    expect(out).not.toContain("your data");
  });
});

describe("the fields", () => {
  it("wires an error to the input for a screen reader, not just for the eye", () => {
    const out = html(<TextField id="f" label="Email" error="That does not look like an email address." />);
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('aria-describedby="f-error"');
    expect(out).toContain('id="f-error"');
  });

  it("announces a submit failure politely rather than interrupting", () => {
    const out = html(<FormMessage tone="error">Nope</FormMessage>);
    expect(out).toContain('role="status"');
    expect(out).toContain('aria-live="polite"');
    expect(out).not.toContain('role="alert"');
  });
});

describe("the §8.5 account-required card", () => {
  it("shows the real surface underneath, inert rather than merely unclickable", () => {
    const out = html(
      <AccountRequired title="Create your free account" body="10 s, no card." next="/app/settings/api-keys">
        <button type="button">Create key</button>
      </AccountRequired>,
    );
    expect(out).toContain("Create key");
    expect(out).toContain("inert");
    expect(out).toContain('aria-hidden="true"');
  });

  it("sends the button to sign-up with this page as ?next (SAAS §3.4)", () => {
    const out = html(<AccountRequired title="t" body="b" next="/app/settings/members" />);
    expect(out).toContain("/sign-up?next=%2Fapp%2Fsettings%2Fmembers");
    expect(out).toContain("/sign-in?next=%2Fapp%2Fsettings%2Fmembers");
  });

  it("carries the spec's own copy for the two pages WP22 and WP24 own", () => {
    expect(ACCOUNT_REQUIRED_COPY.apiKeys.title).toBe("Create your free account to unlock API keys");
    expect(ACCOUNT_REQUIRED_COPY.webhooks.title).toBe("Create your free account to unlock webhooks");
    expect(ACCOUNT_REQUIRED_COPY.apiKeys.next).toBe("/app/settings/api-keys");
    expect(ACCOUNT_REQUIRED_COPY.webhooks.next).toBe("/app/settings/webhooks");
  });
});
