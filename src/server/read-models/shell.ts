import "server-only";

/**
 * Everything `src/app/app/layout.tsx` needs, in one call (SAAS §8.2). WP20·1.
 *
 * The shell renders on every `/app` page, so it has exactly one job beyond rendering: never be the reason a page
 * fails. The org list, the status pill and the plan badge each degrade on their own — a dead status endpoint
 * costs the bar its pill, not the user their runs.
 */
import { LANDING, statusPillText } from "../../content";
import type { OrgSummary, Principal } from "../../core/contracts/v3/identity";
import type { ViewerSummary } from "../../core/contracts/ext/wp20-app";
import { buildStatus } from "../health/status";
import { activeOrgOf, orgSummariesFor, viewerOf } from "./orgs";

export interface ShellData {
  viewer: ViewerSummary;
  orgs: OrgSummary[];
  activeOrg: OrgSummary | null;
  /** The v2 status pill: "Live AI calls available" / "Replay mode · next live window HH:MM IST". */
  statusText: string;
  statusLive: boolean;
}

export async function loadShell(
  p: Principal,
  profile?: { name?: string | null; email?: string | null },
): Promise<ShellData> {
  const [orgs, status] = await Promise.all([
    orgSummariesFor(p),
    buildStatus()
      .then((s) => ({ aiHalfAvailable: s.aiHalfAvailable, nextLiveAt: "nextLiveAt" in s ? (s as { nextLiveAt?: string | null }).nextLiveAt ?? null : null }))
      .catch(() => null),
  ]);
  return {
    viewer: viewerOf(p, profile),
    orgs,
    activeOrg: activeOrgOf(orgs, p),
    statusText: statusPillText(LANDING.statusPill, status),
    statusLive: status?.aiHalfAvailable === true,
  };
}
