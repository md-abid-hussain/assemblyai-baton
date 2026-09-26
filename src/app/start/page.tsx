/**
 * `/start?next=…` (SAAS §3.3). WP20·1.
 *
 * The one "wall" in the product, and it asks for nothing. It exists so that any `/app/**` deep link without a
 * session becomes a guest workspace instead of a sign-in form.
 */
import type { Metadata } from "next";

import { safeNextPath } from "@/core/contracts/ext/wp20-app";

import { StartClient } from "./start-client";

export const metadata: Metadata = {
  title: { absolute: "Setting up your workspace · Changeover" },
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function StartPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNextPath((await searchParams).next);

  return (
    <main className="bg-background text-foreground grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm space-y-4 text-center">
        <p className="text-sm font-semibold tracking-tight">Changeover</p>
        <div
          aria-hidden="true"
          className="border-muted border-t-foreground mx-auto size-6 animate-spin rounded-full border-2"
        />
        <StartClient next={next} />
        <noscript>
          <p className="text-muted-foreground text-sm">
            JavaScript is off, so we could not set the workspace up for you.
          </p>
          <a
            href={next}
            className="bg-primary text-primary-foreground mt-3 inline-flex h-9 items-center rounded-md px-4 text-sm font-medium"
          >
            Continue
          </a>
        </noscript>
        <p className="text-muted-foreground text-xs">
          No email, no card. You can create an account later and keep everything.
        </p>
      </div>
    </main>
  );
}
