/**
 * The frame every auth page renders inside (SAAS §8.1's Auth row). WP20·2.
 *
 * A server component with no state: the three auth pages differ in their form, not in their chrome, and a
 * judge who bounces between sign-up and sign-in should not see the page move. Centred, one column, capped at
 * 26 rem, with the 16 px gutter that the 390 px acceptance criterion requires.
 *
 * `/app`'s tokens are scoped to `.cx-app` and these pages are outside it, so everything here resolves from the
 * shadcn tokens in `globals.css` instead.
 */
import Link from "next/link";
import type * as React from "react";

export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="bg-background text-foreground flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-[26rem] space-y-6">
        <div className="space-y-1.5 text-center">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            Changeover
          </Link>
          <h1 className="text-xl font-semibold tracking-tight text-balance sm:text-2xl">{title}</h1>
          {subtitle ? (
            <p className="text-muted-foreground mx-auto max-w-[34ch] text-sm text-pretty">{subtitle}</p>
          ) : null}
        </div>

        <div className="bg-card rounded-xl border p-5 shadow-sm sm:p-6">{children}</div>

        {footer ? <div className="text-muted-foreground text-center text-sm">{footer}</div> : null}
      </div>
    </main>
  );
}

/**
 * The §3.4 promise, shown wherever a guest is about to create an account.
 *
 * It is the single most load-bearing sentence on the sign-up page: a visitor who has already built something
 * in a guest workspace will not sign up if they suspect it costs them that work, and `onLinkAccount` means it
 * genuinely does not. The copy says what carries over in concrete nouns, not "your data".
 */
export function CarryOverNote() {
  return (
    <p className="bg-muted/50 text-muted-foreground rounded-lg px-3 py-2 text-xs text-pretty">
      Your guest workspace comes with you — the same relays, the same runs, the same workspace name. Nothing is
      re-created and nothing is lost.
    </p>
  );
}
