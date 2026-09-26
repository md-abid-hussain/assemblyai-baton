/**
 * The WP20·2 read models: Members, Organization, the audit log and the invitation card. WP20·2.
 *
 * These four use drizzle's **query builder** rather than the raw `db.execute` of `runs.ts`, so the fake here is
 * a chainable builder that records the table it read and the `where` condition it was given, and answers with
 * queued rows. Two properties are then assertable without a database, and they are the two that matter:
 *
 *  1. **every query carries the org predicate, with the org id as a bound parameter** — the condition is
 *     serialized with the real `PgDialect`, because "it looked right" is not a property a SQL string has;
 *  2. **the derived flags are what the page is allowed to offer** — last owner, admin-out-of-reach, seats
 *     including pending invites, transfer targets. Those are the rules a component must never re-invent, and a
 *     wrong one here becomes a 403 after a click or, worse, an ownerless organization.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import type { Db } from "@/server/db";
import type { Principal } from "@/core/contracts/v3/identity";
import { loadAudit, metadataDetail } from "@/server/read-models/audit";
import { inviteLink, loadMembers } from "@/server/read-models/members";
import { loadInvite } from "@/server/read-models/invite";
import { loadOrgSettings } from "@/server/read-models/org-settings";

const dialect = new PgDialect();

interface Query {
  where: { sql: string; params: unknown[] } | null;
}

/**
 * A drizzle-shaped stub. `select()` starts a chain; every chaining method returns the same object, and the
 * object is a thenable, so `await db.select()...limit(1)` resolves to the next queued row set.
 */
function stubDb(results: Record<string, unknown>[][]): { db: Db; queries: Query[] } {
  const queries: Query[] = [];
  let next = 0;

  const make = () => {
    const q: Query = { where: null };
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "leftJoin", "orderBy", "limit", "groupBy"]) {
      chain[m] = () => chain;
    }
    chain.where = (cond: unknown) => {
      if (cond) {
        const rendered = dialect.sqlToQuery(cond as never);
        q.where = { sql: rendered.sql, params: rendered.params };
      }
      return chain;
    };
    chain.then = (resolve: (rows: unknown) => unknown) => {
      queries.push(q);
      return Promise.resolve(results[next++] ?? []).then(resolve);
    };
    return chain;
  };

  const db = { select: () => make(), selectDistinct: () => make() } as unknown as Db;
  return { db, queries };
}

const principal = (over: Partial<Principal> = {}): Principal => ({
  kind: "session",
  userId: "u_me",
  isAnonymous: false,
  orgId: "org_1",
  orgKind: "team",
  role: "owner",
  scopes: [],
  apiKeyId: null,
  plan: "pro",
  visitorId: "vid_1",
  ipKey: "ip_1",
  requestId: "req_1",
  ...over,
});

const day = (s: string) => new Date(s);

describe("loadMembers", () => {
  const org = [{ name: "Acme relay desk" }];
  const roster = [
    { userId: "u_me", role: "owner", joinedAt: day("2026-09-01T00:00:00Z"), name: "Asha Rao", email: "asha@example.com", isAnonymous: false },
    { userId: "u_2", role: "admin", joinedAt: day("2026-09-05T00:00:00Z"), name: "Bo Chen", email: "bo@example.com", isAnonymous: false },
    { userId: "u_3", role: "member", joinedAt: day("2026-09-06T00:00:00Z"), name: "anon", email: "x@guest.local", isAnonymous: true },
  ];
  const invites = [
    {
      id: "inv_live", email: "new@example.com", role: "member",
      expiresAt: new Date(Date.now() + 86_400_000), inviterName: "Asha Rao", inviterEmail: "asha@example.com",
    },
    {
      id: "inv_dead", email: "old@example.com", role: "viewer",
      expiresAt: new Date(Date.now() - 86_400_000), inviterName: "Asha Rao", inviterEmail: "asha@example.com",
    },
  ];

  it("scopes every query to the principal's org, as a bound parameter", async () => {
    const { db, queries } = stubDb([org, roster, invites]);
    await loadMembers(principal(), db);

    expect(queries.length).toBe(3);
    for (const q of queries) {
      expect(q.where).not.toBeNull();
      expect(q.where?.params).toContain("org_1");
      // The id is never interpolated into the statement text.
      expect(q.where?.sql).not.toContain("org_1");
    }
  });

  it("counts a pending invite as a seat and an expired one as nothing (SAAS §4.1)", async () => {
    const { db } = stubDb([org, roster, invites]);
    const view = await loadMembers(principal(), db);
    expect(view.members).toHaveLength(3);
    expect(view.invitations).toHaveLength(2);
    expect(view.seatsUsed).toBe(4);
    expect(view.invitations.find((i) => i.id === "inv_dead")?.expired).toBe(true);
  });

  it("marks the viewer's own row and the last owner", async () => {
    const { db } = stubDb([org, roster, invites]);
    const view = await loadMembers(principal(), db);
    const me = view.members.find((m) => m.userId === "u_me");
    expect(me?.isSelf).toBe(true);
    expect(me?.isLastOwner).toBe(true);
    expect(view.members.find((m) => m.userId === "u_2")?.isLastOwner).toBe(false);
  });

  it("shows an anonymous account as Guest with no address", async () => {
    const { db } = stubDb([org, roster, invites]);
    const view = await loadMembers(principal(), db);
    const anon = view.members.find((m) => m.userId === "u_3");
    expect(anon?.name).toBe("Guest");
    expect(anon?.email).toBe("");
  });

  it("offers an admin every role at or below their own, and never owner", async () => {
    const { db } = stubDb([org, roster, invites]);
    const view = await loadMembers(principal({ role: "admin" }), db);
    expect(view.assignable).toEqual(["admin", "member", "viewer"]);
    expect(view.viewerRole).toBe("admin");
    expect(view.canInvite).toBe(true);
  });

  it("offers a viewer nothing, and a guest the §8.5 card instead of a refusal", async () => {
    const viewer = await loadMembers(principal({ role: "viewer" }), stubDb([org, roster, invites]).db);
    expect(viewer.canInvite).toBe(false);
    expect(viewer.canManage).toBe(false);
    expect(viewer.accountRequired).toBe(false);

    const guest = await loadMembers(
      principal({ isAnonymous: true, userId: "u_anon" }),
      stubDb([org, roster, invites]).db,
    );
    expect(guest.accountRequired).toBe(true);
    expect(guest.canInvite).toBe(false);
  });

  it("builds an absolute invite link when APP_URL is set, and a usable relative one when it is not", () => {
    expect(inviteLink("inv_1", "https://app.example.com/")).toBe("https://app.example.com/accept-invite/inv_1");
    expect(inviteLink("inv_1", undefined)).toBe("/accept-invite/inv_1");
  });
});

describe("loadOrgSettings", () => {
  const org = [{ name: "Acme", slug: "acme", createdAt: day("2026-09-01T00:00:00Z"), kind: "team" }];
  const owner = { userId: "u_me", role: "owner", name: "Asha", email: "asha@example.com" };
  const admin = { userId: "u_2", role: "admin", name: "Bo", email: "bo@example.com" };
  const plain = { userId: "u_3", role: "member", name: "Cy", email: "cy@example.com" };
  const roster = [owner, admin, plain];

  it("lets the only owner transfer but never leave", async () => {
    const { db } = stubDb([org, roster]);
    const view = await loadOrgSettings(principal(), db);
    expect(view.canTransfer).toBe(true);
    expect(view.transferTargets.map((t) => t.userId)).toEqual(["u_2"]);
    // Leaving would strand the org; §3.5 says transfer first, or delete it.
    expect(view.canLeave).toBe(false);
    expect(view.canDelete).toBe(true);
  });

  it("offers no transfer when there is no admin to transfer to", async () => {
    const { db } = stubDb([org, [owner, plain]]);
    const view = await loadOrgSettings(principal(), db);
    expect(view.canTransfer).toBe(false);
    expect(view.transferTargets).toEqual([]);
  });

  it("lets an admin rename but not delete or transfer", async () => {
    const { db } = stubDb([org, roster]);
    const view = await loadOrgSettings(principal({ userId: "u_2", role: "admin" }), db);
    expect(view.canUpdate).toBe(true);
    expect(view.canDelete).toBe(false);
    expect(view.canTransfer).toBe(false);
    expect(view.canLeave).toBe(true);
  });

  it("gives a member the page read-only", async () => {
    const { db } = stubDb([org, roster]);
    const view = await loadOrgSettings(principal({ userId: "u_3", role: "member" }), db);
    expect(view.canUpdate).toBe(false);
    expect(view.canDelete).toBe(false);
    expect(view.canLeave).toBe(true);
  });

  it("never enables an action for a guest, whatever their role says", async () => {
    const { db } = stubDb([org, roster]);
    const view = await loadOrgSettings(principal({ isAnonymous: true, role: "owner" }), db);
    expect(view.accountRequired).toBe(true);
    expect([view.canUpdate, view.canDelete, view.canTransfer, view.canLeave]).toEqual([false, false, false, false]);
  });
});

describe("the audit viewer", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "au_1",
    occurredAt: day("2026-09-20T10:00:00Z"),
    actorType: "user",
    actorLabel: "asha@example.com",
    actorId: "u_me",
    action: "member.role_changed",
    targetType: "user",
    targetId: "u_2",
    metadata: { fromRole: "member", toRole: "admin" },
    ...over,
  });

  it("scopes to the org and binds every filter value", async () => {
    const { db, queries } = stubDb([[row()], [{ action: "member.role_changed" }]]);
    await loadAudit(principal(), { actor: "asha", action: "member.role_changed", since: "2026-09-01" }, db);

    const main = queries[0];
    expect(main?.where?.params).toContain("org_1");
    expect(main?.where?.params).toContain("%asha%");
    // The actor text never reaches the statement, only the parameter list.
    expect(main?.where?.sql).not.toContain("asha");
  });

  it("renders the frozen actor label and the plan's retention, never a resolved name", async () => {
    const { db } = stubDb([[row({ actorLabel: "gone@example.com" })], []]);
    const page = await loadAudit(principal(), {}, db);
    expect(page.rows[0]?.actorLabel).toBe("gone@example.com");
    expect(page.rows[0]?.actionLabel).toBe("Member role changed");
    expect(page.retentionDays).toBeGreaterThan(0);
  });

  it("drops metadata keys that are not on the allow-list", () => {
    expect(metadataDetail({ via: "confirmed", relays: 2 })).toBe("via=confirmed · relays=2");
    // Anything a writer should never have put there is invisible rather than rendered.
    expect(metadataDetail({ secretValue: "hunter2", ipKey: "abc", password: "x" })).toBeNull();
    expect(metadataDetail({ via: "cli", password: "x" })).toBe("via=cli");
  });

  it("returns an empty page rather than an unscoped query when there is no org", async () => {
    const { db, queries } = stubDb([[row()]]);
    const page = await loadAudit(principal({ orgId: null }), {}, db);
    expect(page.rows).toEqual([]);
    expect(queries).toEqual([]);
  });
});

describe("loadInvite", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "inv_abcdefgh",
    email: "ada.lovelace@example.com",
    role: "admin",
    status: "pending",
    expiresAt: new Date(Date.now() + 86_400_000),
    orgName: "Acme",
    ...over,
  });

  it("masks the address it displays and keeps the one the form needs", async () => {
    const { db } = stubDb([[row()]]);
    const view = await loadInvite("inv_abcdefgh", db);
    expect(view?.emailMasked).toMatch(/^ad•+@example\.com$/);
    expect(view?.emailMasked).not.toContain("lovelace");
    expect(view?.emailPrefill).toBe("ada.lovelace@example.com");
  });

  it("reports an elapsed pending invitation as expired", async () => {
    const { db } = stubDb([[row({ expiresAt: new Date(Date.now() - 1000) })]]);
    expect((await loadInvite("inv_abcdefgh", db))?.status).toBe("expired");
  });

  it("maps a rejected invitation to the same dead end as a canceled one", async () => {
    const { db } = stubDb([[row({ status: "rejected" })]]);
    expect((await loadInvite("inv_abcdefgh", db))?.status).toBe("canceled");
  });

  it("answers a malformed id without touching the database", async () => {
    const { db, queries } = stubDb([[row()]]);
    expect(await loadInvite("../../etc/passwd", db)).toBeNull();
    expect(await loadInvite("short", db)).toBeNull();
    expect(queries).toEqual([]);
  });
});
