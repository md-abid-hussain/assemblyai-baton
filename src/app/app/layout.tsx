/**
 * The `/app` layout (SAAS §8.1, §8.2). WP20·1.
 *
 * **It never redirects.** Next renders a layout and its page concurrently, so a redirect here would race the
 * page's and win with the wrong path — `/start?next=/app` instead of `/start?next=/app/runs?source=simulated`
 * (acceptance 1). Every page calls `appPrincipal` with its own route literal and owns the redirect;
 * `tests/unit/app/wp20-surface.test.ts` fails if one forgets. When there is no context, the layout renders the
 * children bare, and the page redirect that is already in flight is what the visitor actually gets.
 */
import type { Metadata } from "next";
import type * as React from "react";

import { AppShell } from "@/components/app-shell/app-shell";
import { appContextOrNull } from "@/server/read-models/app-guard";
import { loadShell } from "@/server/read-models/shell";

export const metadata: Metadata = {
  title: { default: "Changeover", template: "%s · Changeover" },
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await appContextOrNull("/app");
  if (!ctx) return <>{children}</>;

  const shell = await loadShell(ctx.principal);

  return (
    <AppShell
      viewer={shell.viewer}
      orgs={shell.orgs}
      activeOrg={shell.activeOrg}
      statusText={shell.statusText}
      statusLive={shell.statusLive}
      degraded={ctx.degraded}
    >
      {children}
    </AppShell>
  );
}
