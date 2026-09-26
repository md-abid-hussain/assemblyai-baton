/**
 * The `/app` shell and its empty states (SAAS §8.2, §8.5). WP20·1.
 *
 * Server-render smoke tests: the shell and the read-only views must produce correct HTML with no browser, both
 * because that is how a `/app` page is actually delivered and because the spec's copy is a contract — the
 * guest banner and the empty states are quoted in SAAS §8.2 and §8.5, and a paraphrase is a regression.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/app/runs", useRouter: () => ({ refresh() {} }) }));

const { AppShell } = await import("@/components/app-shell/app-shell");
const { EmptyState, PageHeader, Stat } = await import("@/components/app-shell/bits");
const { MinutesMeter, RelayCards } = await import("@/components/onboarding/minutes-meter");
const { GuestBanner } = await import("@/components/app-shell/guest-banner");
const { OrgSwitcher } = await import("@/components/app-shell/org-switcher");

import type { OrgSummary } from "@/core/contracts/v3/identity";
import type { MinutesMeterView, RelayCardView, ViewerSummary } from "@/core/contracts/ext/wp20-app";

const guest: ViewerSummary = { userId: null, name: "Guest", email: null, isGuest: true, role: "owner", plan: "guest" };
const member: ViewerSummary = {
  userId: "u_1", name: "Asha Rao", email: "asha@example.com", isGuest: false, role: "owner", plan: "pro",
};

const org = (over: Partial<OrgSummary> = {}): OrgSummary => ({
  id: "ws_vid", name: "Guest workspace", slug: "ws_vid", kind: "guest", role: "owner", plan: "guest", ...over,
});

const shell = (viewer: ViewerSummary, orgs: OrgSummary[] = [org()]) =>
  renderToStaticMarkup(
    <AppShell
      viewer={viewer}
      orgs={orgs}
      activeOrg={orgs[0] ?? null}
      statusText="Live AI calls available"
      statusLive
      currentPath="/app/runs"
    >
      <p>page body</p>
    </AppShell>,
  );

describe("the app shell", () => {
  it("renders the five nav sections and the page body", () => {
    const html = shell(member);
    for (const label of ["Relays", "Runs", "Analytics", "Connectors", "Settings"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("page body");
    expect(html).toContain("Changeover");
  });

  it("marks the current section for assistive tech", () => {
    expect(shell(member)).toContain('aria-current="page"');
  });

  it("has a skip link and one main landmark", () => {
    const html = shell(member);
    expect(html).toContain("Skip to content");
    expect(html).toContain('id="cx-main"');
    expect(html.match(/<main/g)).toHaveLength(1);
  });

  it("shows the status pill", () => {
    expect(shell(member)).toContain("Live AI calls available");
  });

  it("shows the guest banner to a guest, with SAAS §8.2's exact promise", () => {
    const html = shell(guest);
    expect(html).toContain("You’re in a guest workspace.");
    expect(html).toContain("Create a free account");
    expect(html).toContain("your relays and runs come with you");
    // The sign-up link returns to the page the guest was on.
    expect(html).toContain("/sign-up?next=%2Fapp%2Fruns");
  });

  it("does not show it to a signed-in member", () => {
    expect(shell(member)).not.toContain("guest workspace.");
  });

  it("never says 'no-code', 'drag-and-drop' or 'canvas' (TASKS-v3 §2 rule 19)", () => {
    const html = `${shell(guest)}${shell(member)}`.toLowerCase();
    for (const banned of ["no-code", "drag-and-drop", "canvas"]) expect(html).not.toContain(banned);
  });
});

describe("the guest banner", () => {
  it("is server-rendered visible, so the 'not saved yet' line never arrives late", () => {
    expect(renderToStaticMarkup(<GuestBanner />)).toContain("guest workspace");
  });

  it("has a labelled dismiss control", () => {
    expect(renderToStaticMarkup(<GuestBanner />)).toContain("Dismiss the guest workspace notice");
  });
});

describe("the org switcher", () => {
  it("shows the active workspace with its plan and kind", () => {
    const html = renderToStaticMarkup(<OrgSwitcher orgs={[org()]} activeId="ws_vid" />);
    expect(html).toContain("Guest workspace");
    expect(html).toContain("Guest");
  });

  it("renders without an active id rather than throwing", () => {
    expect(renderToStaticMarkup(<OrgSwitcher orgs={[]} activeId={null} />)).toContain("No workspace");
  });
});

describe("empty states (SAAS §8.5)", () => {
  it("always offers a next step, not just an absence", () => {
    const html = renderToStaticMarkup(
      <EmptyState
        title="No runs yet."
        body="Run the Dental template's simulated call, or watch Baton's recorded handoff."
        actions={<a href="/app/relays">Open the Dental template</a>}
      />,
    );
    expect(html).toContain("No runs yet.");
    expect(html).toContain("Run the Dental template");
    expect(html).toContain("/app/relays");
  });
});

describe("the minutes meter", () => {
  const meter = (over: Partial<MinutesMeterView> = {}): MinutesMeterView => ({
    plan: "free",
    usedMinutes: 3.5,
    allowanceMinutes: 15,
    byProvenance: { recorded: 2, simulated: 1.5, published: 0 },
    period: "2026-09",
    basis: "runs",
    ...over,
  });

  it("says out loud that a derived number is not a billing number", () => {
    const html = renderToStaticMarkup(<MinutesMeter meter={meter()} />);
    expect(html).toContain("not a billing figure");
    expect(html).toContain("3.5 min");
    expect(html).toContain("of 15 min");
  });

  it("switches its wording once WP21's metered usage is the source", () => {
    const html = renderToStaticMarkup(<MinutesMeter meter={meter({ basis: "metered" })} />);
    expect(html).toContain("Metered usage");
    expect(html).not.toContain("not a billing figure");
  });

  it("warns at 80% of the allowance", () => {
    expect(renderToStaticMarkup(<MinutesMeter meter={meter({ usedMinutes: 13 })} />)).toContain("87%");
    expect(renderToStaticMarkup(<MinutesMeter meter={meter({ usedMinutes: 1 })} />)).not.toContain("of this month");
  });
});

describe("relay cards", () => {
  const card = (over: Partial<RelayCardView> = {}): RelayCardView => ({
    id: "rl_1", slug: "dental-deposit", title: "Dental deposit (your copy)", industry: "dental",
    flagship: false, pinned: false, versionCount: 2, lintErrors: 0, lastRunAt: null,
    updatedAt: "2026-09-20T10:00:00.000Z", ...over,
  });

  it("labels the pinned flagship as read-only rather than as something to edit", () => {
    const html = renderToStaticMarkup(
      <RelayCards relays={[card({ id: "rl_baton", title: "Baton", flagship: true, pinned: true })]} />,
    );
    expect(html).toContain("Flagship · read-only");
  });

  it("offers Open and View code for an owned relay", () => {
    const html = renderToStaticMarkup(<RelayCards relays={[card()]} />);
    expect(html).toContain("/app/relays/rl_1");
    expect(html).toContain("/app/relays/rl_1/code");
    expect(html).toContain("View code");
  });

  it("surfaces lint errors", () => {
    expect(renderToStaticMarkup(<RelayCards relays={[card({ lintErrors: 2 })]} />)).toContain("2 lint errors");
  });
});

describe("Stat", () => {
  it("renders a labelled number", () => {
    const html = renderToStaticMarkup(<Stat label="Runs" value={12} hint="last 30 days" />);
    expect(html).toContain("Runs");
    expect(html).toContain("12");
  });
});

describe("PageHeader", () => {
  it("is the page's single h1", () => {
    const html = renderToStaticMarkup(<PageHeader title="Runs" description="Every handoff." />);
    expect(html.match(/<h1/g)).toHaveLength(1);
  });
});
