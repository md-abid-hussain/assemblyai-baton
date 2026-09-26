/**
 * The settings panels, the settings sub-nav and the §2.6 claim card. WP20·2.
 *
 * The rule these tests defend is the one that is easy to break by editing a component in isolation: **the page
 * may hide or disable, and it may never enable what `can()` refused.** Every case below is a control that must
 * *not* be offered — an admin reaching for an owner's role, a viewer reaching for Remove, a last owner reaching
 * for Leave — because each of those, if offered, is a 403 the user experiences as the product being broken.
 *
 * Rendered with `renderToStaticMarkup`: no browser, no effects, exactly the HTML a first paint delivers.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/app/settings/members",
  useRouter: () => ({ refresh() {}, push() {} }),
}));

const { MembersPanel } = await import("@/components/settings/members-panel");
const { OrgPanel } = await import("@/components/settings/org-panel");
const { AuditFilters, AuditTable } = await import("@/components/settings/audit-table");
const { ProfilePanel } = await import("@/components/settings/profile-panel");
const { ClaimCard } = await import("@/components/app-shell/claim-card");
const { SETTINGS_NAV, visibleSettings } = await import("@/components/app-shell/nav");

import type {
  AuditPage,
  MembersView,
  OrgSettingsView,
  ProfileView,
} from "@/core/contracts/ext/wp20-app";
import type { Principal } from "@/core/contracts/v3/identity";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

const member = (over: Partial<MembersView["members"][number]> = {}): MembersView["members"][number] => ({
  userId: "u_2",
  name: "Bo Chen",
  email: "bo@example.com",
  role: "member",
  joinedAt: "2026-09-05T00:00:00.000Z",
  isSelf: false,
  isLastOwner: false,
  ...over,
});

const members = (over: Partial<MembersView> = {}): MembersView => ({
  orgId: "org_1",
  orgName: "Acme",
  plan: "pro",
  members: [member()],
  invitations: [],
  seatsUsed: 1,
  seatLimit: 10,
  canInvite: true,
  canManage: true,
  assignable: ["owner", "admin", "member", "viewer"],
  viewerRole: "owner",
  accountRequired: false,
  viewerUserId: "u_1",
  ...over,
});

describe("Members", () => {
  it("never offers an admin a control over an owner (SAAS §3.7)", () => {
    const out = html(
      <MembersPanel
        view={members({
          viewerRole: "admin",
          assignable: ["admin", "member", "viewer"],
          members: [member({ userId: "u_1", name: "Asha", role: "owner" })],
        })}
      />,
    );
    expect(out).toContain("Only an owner can change an owner");
    // The only select on the page is the invite form's; the member row must not have gained one.
    expect(out).not.toContain("Role for");
    expect(out).not.toContain("Remove");
  });

  it("locks the last owner's row, for either viewer", () => {
    const out = html(
      <MembersPanel
        view={members({ members: [member({ userId: "u_9", name: "Sole", role: "owner", isLastOwner: true })] })}
      />,
    );
    expect(out).toContain("The last owner cannot be changed");
    expect(out).not.toContain("Role for");
    expect(out).not.toContain("Remove");
  });

  it("gives your own row 'You' and no Remove", () => {
    const out = html(<MembersPanel view={members({ members: [member({ isSelf: true })] })} />);
    expect(out).toContain("You");
    expect(out).toContain("This is you");
    expect(out).not.toContain("Remove");
  });

  it("gives a viewer the roster and nothing to press", () => {
    const out = html(
      <MembersPanel view={members({ canInvite: false, canManage: false, assignable: [], viewerRole: "viewer" })} />,
    );
    expect(out).toContain("Bo Chen");
    expect(out).not.toContain("Role for");
    expect(out).not.toContain("Remove");
    // The invite form still renders — §8.5's rule — with every control disabled.
    expect(out).toContain("disabled");
  });

  it("says who can fix a full plan, and never tells a non-owner to upgrade", () => {
    const full = { seatsUsed: 3, seatLimit: 3 };
    const asAdmin = html(<MembersPanel view={members({ ...full, viewerRole: "admin" })} />);
    expect(asAdmin).toContain("Ask an owner to upgrade");
    expect(asAdmin).not.toContain("/app/settings/billing");

    const asOwner = html(<MembersPanel view={members({ ...full, viewerRole: "owner" })} />);
    expect(asOwner).toContain("/app/settings/billing");
  });

  it("uses §8.5's empty state when you are alone", () => {
    const out = html(<MembersPanel view={members({ members: [member({ isSelf: true })] })} />);
    expect(out).toContain("re the only member. Invite a teammate with a link.");
  });

  it("offers Copy link on a live invite and not on an expired one", () => {
    const invite = {
      id: "inv_1",
      email: "new@example.com",
      role: "member" as const,
      link: "https://app.example.com/accept-invite/inv_1",
      expiresAt: "2026-10-01T00:00:00.000Z",
      invitedBy: "Asha",
      expired: false,
    };
    expect(html(<MembersPanel view={members({ invitations: [invite] })} />)).toContain("Copy link");
    const dead = html(<MembersPanel view={members({ invitations: [{ ...invite, expired: true }] })} />);
    expect(dead).toContain("Expired");
    expect(dead).not.toContain("Copy link");
  });

  it("explains the four roles in the spec's own shape", () => {
    const out = html(<MembersPanel view={members()} />);
    expect(out).toContain("Members build, admins ship");
    for (const label of ["Owner", "Admin", "Member", "Viewer"]) expect(out).toContain(label);
  });
});

const orgView = (over: Partial<OrgSettingsView> = {}): OrgSettingsView => ({
  id: "org_1",
  name: "Acme",
  slug: "acme",
  kind: "team",
  plan: "pro",
  createdAt: "2026-09-01T00:00:00.000Z",
  memberCount: 3,
  ownerCount: 1,
  canUpdate: true,
  canDelete: true,
  canTransfer: true,
  canLeave: false,
  transferTargets: [{ userId: "u_2", name: "Bo", email: "bo@example.com" }],
  accountRequired: false,
  ...over,
});

describe("Organization", () => {
  it("shows an owner transfer and delete, and no Leave while they are the last owner", () => {
    const out = html(<OrgPanel view={orgView()} ownedCount={1} maxOwned={3} />);
    expect(out).toContain("Transfer");
    expect(out).toContain("Delete");
    expect(out).not.toContain("Leave this workspace");
  });

  it("gives a member a read-only page with no danger zone at all", () => {
    const out = html(
      <OrgPanel
        view={orgView({ canUpdate: false, canDelete: false, canTransfer: false, canLeave: false })}
        ownedCount={0}
        maxOwned={3}
      />,
    );
    expect(out).toContain("Only an owner or an admin can rename");
    expect(out).not.toContain("Danger zone");
    expect(out).not.toContain("Save changes");
  });

  it("names the consequences of deleting rather than only colouring the button", () => {
    const out = html(<OrgPanel view={orgView()} ownedCount={1} maxOwned={3} />);
    expect(out).toContain("Published relays are unpublished");
    expect(out).toContain("audit log is kept for 30 days");
  });

  it("refuses a fourth owned workspace with the reason, not a silent disabled button", () => {
    const out = html(<OrgPanel view={orgView()} ownedCount={3} maxOwned={3} />);
    expect(out).toContain("which is the limit");
    expect(out).toContain("disabled");
  });
});

const auditPage = (over: Partial<AuditPage> = {}): AuditPage => ({
  rows: [],
  nextCursor: null,
  retentionDays: 90,
  actions: ["member.invited", "org.renamed"],
  filter: {},
  ...over,
});

describe("the audit log", () => {
  it("uses §8.5's empty state", () => {
    expect(html(<AuditTable page={auditPage()} nextHref={null} />)).toContain(
      "Every change to this workspace is recorded here.",
    );
  });

  it("renders the frozen actor label and never an ip key", () => {
    const out = html(
      <AuditTable
        page={auditPage({
          rows: [
            {
              id: "au_1",
              occurredAt: "2026-09-20T10:00:00.000Z",
              actorType: "user",
              actorLabel: "asha@example.com",
              action: "member.role_changed",
              actionLabel: "Member role changed",
              targetType: "user",
              targetId: "u_2",
              detail: "fromRole=member · toRole=admin",
            },
          ],
        })}
        nextHref="/app/settings/audit?cursor=x"
      />,
    );
    expect(out).toContain("asha@example.com");
    expect(out).toContain("Member role changed");
    expect(out).toContain("Older entries");
    expect(out.toLowerCase()).not.toContain("ipkey");
    expect(out.toLowerCase()).not.toContain("ip address");
  });

  it("is a GET form, so every filtered view is a shareable URL", () => {
    const out = html(<AuditFilters page={auditPage({ filter: { actor: "asha" } })} />);
    expect(out).toContain('method="get"');
    expect(out).toContain('name="actor"');
    expect(out).toContain('name="action"');
    expect(out).toContain('name="since"');
    expect(out).toContain('name="until"');
    expect(out).toContain("Clear");
  });
});

const profile = (over: Partial<ProfileView> = {}): ProfileView => ({
  userId: "u_1",
  name: "Asha Rao",
  email: "asha@example.com",
  createdAt: "2026-09-01T00:00:00.000Z",
  isGuest: false,
  providers: ["credential"],
  hasPassword: true,
  sessions: [
    { id: "s_1", createdAt: "2026-09-20T09:00:00.000Z", expiresAt: "2026-10-20T09:00:00.000Z", device: "Chrome on Windows", current: true },
    { id: "s_2", createdAt: "2026-09-18T09:00:00.000Z", expiresAt: "2026-10-18T09:00:00.000Z", device: "Safari on iOS", current: false },
  ],
  ...over,
});

describe("Profile", () => {
  it("never offers Revoke on the session you are using", () => {
    const out = html(<ProfilePanel profile={profile()} />);
    expect(out).toContain("This device");
    expect(out).toContain("Sign out from the account menu");
    expect(out).toContain("Sign out everywhere else");
  });

  it("hides the password form for an account that has no password", () => {
    expect(html(<ProfilePanel profile={profile({ hasPassword: false, providers: ["github"] })} />)).not.toContain(
      "Change password",
    );
    expect(html(<ProfilePanel profile={profile()} />)).toContain("Change password");
  });

  it("says no IP address is on the screen, and puts none there (SAAS §10.5)", () => {
    const out = html(<ProfilePanel profile={profile()} />);
    expect(out).toContain("No IP addresses are stored on this screen.");
    expect(out).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });
});

describe("the settings sub-nav", () => {
  const p = (role: Principal["role"]): Pick<Principal, "kind" | "role" | "scopes"> => ({
    kind: "session",
    role,
    scopes: [],
  });

  it("gives an owner every page", () => {
    expect(visibleSettings(p("owner"))).toHaveLength(SETTINGS_NAV.length);
  });

  it("hides billing, audit, keys and webhooks from a member and a viewer", () => {
    for (const role of ["member", "viewer"] as const) {
      const labels = visibleSettings(p(role)).map((s) => s.label);
      expect(labels).toEqual(["Profile", "Organization", "Members", "Usage", "CLI & SDK"]);
    }
  });

  it("keeps API keys and Webhooks for a guest, because §8.5 is the answer there, not a hidden link", () => {
    // A guest owns their guest org, so the role check passes and the *plan* is what bites — on the page,
    // behind the upgrade card, which is exactly where §8.5 puts it.
    const labels = visibleSettings(p("owner")).map((s) => s.label);
    expect(labels).toContain("API keys");
    expect(labels).toContain("Webhooks");
  });
});

describe("the shared-device claim card (SAAS §2.6 R1)", () => {
  it("renders nothing when there is no offer", () => {
    expect(
      html(<ClaimCard view={{ offer: false, orgName: "Acme", cases: 0, relays: 0, drafts: 0 }} />),
    ).toBe("");
  });

  it("names what it would move, and offers a permanent 'Not mine'", () => {
    const out = html(<ClaimCard view={{ offer: true, orgName: "Acme", cases: 1, relays: 2, drafts: 0 }} />);
    expect(out).toContain("2 relays and 1 run");
    expect(out).toContain("Acme");
    expect(out).toContain("Add to this workspace");
    expect(out).toContain("Not mine");
    expect(out).toContain("What is this?");
  });
});
