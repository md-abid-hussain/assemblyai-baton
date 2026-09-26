import { permanentRedirect } from "next/navigation";

/**
 * `/studio/**` → `/app/relays/**`, permanently (SAAS §5.5: "`/studio/**` → 308").
 *
 * The v2 Studio lived at `/studio`, `/studio/new` and `/studio/[relayId]/[tab]`; v3 moves it under `/app` so it sits
 * inside the app shell with the org switcher and the checklist. Old links, the v2 e2e specs and anything a judge
 * bookmarked keep working, and `permanentRedirect` is the 308 the spec asks for (a 307/308 preserves the method, so
 * a POST to an old path is not silently turned into a GET).
 */
export const dynamic = "force-dynamic";

const TABS = new Set(["overview", "configure", "code", "preview", "versions", "test", "publish", "analytics"]);

export default async function StudioRedirect({ params }: { params: Promise<{ rest?: string[] }> }) {
  const { rest } = await params;
  const parts = (rest ?? []).map((p) => encodeURIComponent(p));
  if (parts.length === 0) permanentRedirect("/app/relays");
  if (parts.length === 1) permanentRedirect(parts[0] === "new" ? "/app/relays/new" : `/app/relays/${parts[0]}`);
  const [id, tab] = parts;
  // v2 tab names that v3 renamed: Track → Overview, Case/Handoff/Playbook/Connectors → Configure, Advanced → Code.
  const v3Tab = TABS.has(tab ?? "")
    ? tab
    : tab === "track"
      ? "overview"
      : tab === "advanced"
        ? "code"
        : ["case", "handoff", "playbook", "connectors", "listening"].includes(tab ?? "")
          ? "configure"
          : "overview";
  permanentRedirect(`/app/relays/${id}/${v3Tab}`);
}
