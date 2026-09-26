/**
 * Members, invitations, roles and the org lifecycle, end to end (SAAS §3.5–§3.7, §9). WP19·3.
 *
 * This is the half of the suite that **does** mutate: each case owns its own users and orgs inside one world, so
 * ordering between cases never matters. It is also where the §7 acceptance "audit rows for every mutation in §9"
 * is checked — not against the in-memory port, but against the real `audit_log` table, because
 * `installIdentity()` registered the database writer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { call } from "./helpers/dispatch";
import { ROUTES, type RouteRow } from "./manifest";
import { bodyOf, buildWorld, codeOf, ctx, HAS_DB, req, type Who, type World } from "./helpers/world";

let w: World;

const rowNamed = (name: string): RouteRow => {
  const r = ROUTES.find((x) => x.name === name);
  if (!r) throw new Error(`no manifest row named ${name}`);
  return r;
};

/** The audit actions recorded for one org, newest first. Reads the real table. */
async function actionsFor(orgId: string): Promise<string[]> {
  const page = await w.m.audit.readAuditPage(orgId, { limit: 100 }, w.t.db);
  return page.rows.map((r) => r.action);
}

/** The newest audit row for one action in one org. */
async function lastRow(orgId: string, action: string) {
  const page = await w.m.audit.readAuditPage(orgId, { action, limit: 1 }, w.t.db);
  return page.rows[0] ?? null;
}

describe.skipIf(!HAS_DB)("tenancy: members, invitations and the org lifecycle", () => {
  beforeAll(async () => {
    w = await buildWorld("wp19_tenancy_members");
  }, 120_000);

  afterAll(async () => {
    await w?.t.drop();
  });

  // --------------------------------------------------------------------------------------------- invitations

  describe("invitations are copyable links (§3.6)", () => {
    it("an admin creates one, it appears in the list with its link, and the audit row is written", async () => {
      const res = await call(w, rowNamed("POST /api/app/invitations"), w.aAdmin, "", {
        body: { email: "New.Person@Tenancy.Test", role: "member" },
      });
      expect(res.status).toBe(201);
      const invite = await bodyOf(res);
      expect(invite.email, "the address is normalised before it is stored").toBe("new.person@tenancy.test");
      expect(String(invite.link)).toBe(`https://app.example.test/accept-invite/${String(invite.id)}`);
      expect(new Date(String(invite.expiresAt)).getTime()).toBeGreaterThan(Date.now());

      const list = await bodyOf(await call(w, rowNamed("GET /api/app/invitations"), w.aMember, ""));
      const rows = list.invitations as { id: string; link: string; invitedBy: string }[];
      expect(rows.map((r) => r.id)).toContain(invite.id);
      expect(rows.find((r) => r.id === invite.id)?.invitedBy).toBe("a-admin@tenancy.test");

      const row = await lastRow(w.orgA, "member.invited");
      expect(row?.target).toEqual({ type: "invitation", id: invite.id });
      expect(row?.actor.label, "the label is frozen at write time").toBe("a-admin@tenancy.test");
      expect(row?.metadata.email).toBe("new.person@tenancy.test");
    });

    /**
     * The link is a credential, so `member:read` is not enough to hold it (§3.6).
     *
     * `member:read` reaches down to a viewer. If a viewer could read a pending **admin** invitation's link, then
     * in a build where no address is verifiable (§3.2, `EMAIL_MODE=off`) they could register that address and
     * accept it — a role escalation that leaves no trace until `member.joined` is already written. Existence,
     * recipient and role stay visible to everyone who can see the Members page; only the copyable URL is gated.
     */
    it("the copyable link goes to inviters only, not to everyone who can read the roster", async () => {
      const invite = await bodyOf(
        await call(w, rowNamed("POST /api/app/invitations"), w.aOwner, "", {
          body: { email: "link-gate@tenancy.test", role: "admin" },
        }),
      );

      const seenBy = async (who: typeof w.aOwner) => {
        const list = await bodyOf(await call(w, rowNamed("GET /api/app/invitations"), who, ""));
        return (list.invitations as { id: string; link?: string; role: string }[]).find((r) => r.id === invite.id);
      };

      for (const who of [w.aOwner, w.aAdmin]) {
        expect((await seenBy(who))?.link, "an inviter needs the link").toBe(
          `https://app.example.test/accept-invite/${String(invite.id)}`,
        );
      }
      for (const who of [w.aMember, w.aViewer]) {
        const seen = await seenBy(who);
        expect(seen, "the invitation itself stays visible").toBeTruthy();
        expect(seen?.role, "including the role it grants").toBe("admin");
        expect(seen?.link, "but not the credential that redeems it").toBeUndefined();
      }
    });

    it("the same address twice is a conflict, not a second row", async () => {
      const body = { email: "twice@tenancy.test", role: "member" };
      expect((await call(w, rowNamed("POST /api/app/invitations"), w.aOwner, "", { body })).status).toBe(201);
      const again = await call(w, rowNamed("POST /api/app/invitations"), w.aOwner, "", { body });
      expect(again.status).toBe(409);
      expect(await codeOf(again)).toBe("E_CONFLICT");
    });

    it("inviting an existing member is a conflict too", async () => {
      const res = await call(w, rowNamed("POST /api/app/invitations"), w.aOwner, "", {
        body: { email: w.aViewer.email, role: "member" },
      });
      expect(res.status).toBe(409);
    });

    it("revoking removes it from the list and audits `member.invite_revoked`", async () => {
      const created = await bodyOf(
        await call(w, rowNamed("POST /api/app/invitations"), w.aOwner, "", {
          body: { email: "revoke-me@tenancy.test", role: "viewer" },
        }),
      );
      const id = String(created.id);
      expect((await call(w, rowNamed("DELETE /api/app/invitations/:id"), w.aOwner, id)).status).toBe(204);

      const list = await bodyOf(await call(w, rowNamed("GET /api/app/invitations"), w.aOwner, ""));
      expect((list.invitations as { id: string }[]).map((r) => r.id)).not.toContain(id);
      expect(await actionsFor(w.orgA)).toContain("member.invite_revoked");

      // Revoking twice is a 404: there is no longer a pending invitation with that id.
      expect((await call(w, rowNamed("DELETE /api/app/invitations/:id"), w.aOwner, id)).status).toBe(404);
    });

    /**
     * §4.1: the Free plan has three seats, and a seat is a member **or** a pending invitation. Org B is the Free
     * one (the fixtures put A on Pro so its four members are legal), and it starts with one member, so the third
     * seat is the one that is refused — at invite time, which is the honest place, rather than at accept time
     * when the invitee has already been told they are in.
     */
    it("seats are a plan limit, counted as members plus pending invitations", async () => {
      const before = await w.m.identity.countSeats(w.orgB, w.t.db);
      const statuses: number[] = [];
      for (let i = before; i < 4; i++) {
        const res = await call(w, rowNamed("POST /api/app/invitations"), w.bOwner, "", {
          body: { email: `seat-${i}@tenancy.test`, role: "member" },
        });
        statuses.push(res.status);
        if (res.status === 402) {
          expect(await codeOf(res)).toBe("E_PLAN_LIMIT");
          break;
        }
      }
      expect(statuses.at(-1), "E_PLAN_LIMIT is a 402").toBe(402);
      expect(await w.m.identity.countSeats(w.orgB, w.t.db)).toBe(3);
    });

    it("the invite is bound to the invited email: another account cannot accept it", async () => {
      // Better Auth owns `accept-invitation`; the property we depend on is that it compares the session user's
      // email to the invitation's. Asserted against the plugin itself rather than against our own copy of it.
      const created = await bodyOf(
        await call(w, rowNamed("POST /api/app/invitations"), w.aOwner, "", {
          body: { email: "someone-else@tenancy.test", role: "member" },
        }),
      );
      const auth = w.m.identity.getAuth()!;
      await expect(
        auth.api.acceptInvitation({
          body: { invitationId: String(created.id) },
          headers: new Headers({ cookie: w.bOwner.cookie }),
        }),
      ).rejects.toThrow();

      // And nothing moved: B's owner is not in A.
      expect(await w.m.identity.memberRow(w.orgA, w.bOwner.userId, w.t.db)).toBeNull();
    });

    /**
     * `member.joined` (§9) — the one org mutation with no route of ours behind it.
     *
     * §3.8 leaves `accept-invitation` on the client plugin on purpose, because the plugin is what enforces the
     * email match the test above relies on. That means nothing in `src/app/api/app/**` ever observes an accept,
     * and `member.joined` was a declared `AuditAction` that no code path wrote: the trail showed the invitation
     * and then the person's later actions, with the moment they gained access missing. It is written from the
     * plugin's `afterAcceptInvitation` hook now, and this is the test that says so.
     */
    it("accepting an invitation audits member.joined with the invitee as the actor", async () => {
      const created = await bodyOf(
        await call(w, rowNamed("POST /api/app/invitations"), w.aOwner, "", {
          body: { email: w.bOwner.email, role: "member" },
        }),
      );
      const auth = w.m.identity.getAuth()!;
      await auth.api.acceptInvitation({
        body: { invitationId: String(created.id) },
        headers: new Headers({ cookie: w.bOwner.cookie }),
      });

      // The membership is real...
      expect(await w.m.identity.memberRow(w.orgA, w.bOwner.userId, w.t.db)).not.toBeNull();

      // ...and it is on the record, in A's log, attributed to the person who accepted rather than the inviter.
      const row = await lastRow(w.orgA, "member.joined");
      expect(row, "no member.joined row was written").toBeTruthy();
      expect(row?.actor.id).toBe(w.bOwner.userId);
      expect(row?.actor.label).toBe(w.bOwner.email);
      expect(row?.metadata.role).toBe("member");
      expect(row?.metadata.invitationId).toBe(String(created.id));
    });
  });

  // -------------------------------------------------------------------------------------------------- roles

  describe("roles (§3.7)", () => {
    it("an owner promotes a member and the change is audited with both roles", async () => {
      const res = await call(w, rowNamed("PATCH /api/app/members/:userId"), w.aOwner, w.aMember.userId, {
        body: { role: "admin" },
      });
      expect(res.status).toBe(200);
      const row = await lastRow(w.orgA, "member.role_changed");
      expect(row?.metadata).toMatchObject({ from: "member", to: "admin" });

      // Put it back, so the rest of the file sees the roster it expects.
      await call(w, rowNamed("PATCH /api/app/members/:userId"), w.aOwner, w.aMember.userId, {
        body: { role: "member" },
      });
    });

    it("the last owner cannot be demoted", async () => {
      const res = await call(w, rowNamed("PATCH /api/app/members/:userId"), w.aOwner, w.aOwner.userId, {
        body: { role: "admin" },
      });
      expect(res.status).toBe(409);
      expect(await codeOf(res)).toBe("E_CONFLICT");
    });

    it("the last owner cannot leave either", async () => {
      const res = await call(w, rowNamed("POST /api/app/orgs/:id/leave"), w.aOwner, w.orgA);
      expect(res.status).toBe(409);
    });
  });

  // ------------------------------------------------------------------------------ leave, remove and transfer

  describe("leaving, removing and transferring", () => {
    /** A fresh org with an owner and one extra member, so these cases never disturb A or B. */
    async function freshOrg(tag: string): Promise<{ orgId: string; owner: Who; admin: Who }> {
      const org = await w.m.identity.createOrg({
        name: `Org ${tag}`,
        slug: `org-${tag}`,
        kind: "team",
        createdVia: "switcher",
        ownerUserId: w.aOwner.userId,
        plan: "free",
      });
      // Reuse two existing accounts in a brand-new org: the roles here are what the cases are about.
      const { eq } = w.m.drizzle;
      await w.t.db.insert(w.m.schemaAuth.members).values({
        id: w.m.identity.prefixedId("member"),
        organizationId: org.id,
        userId: w.aAdmin.userId,
        role: "admin",
        createdAt: new Date(),
      });
      const activate = async (who: Who) => {
        await w.t.db
          .update(w.m.schemaAuth.sessions)
          .set({ activeOrganizationId: org.id })
          .where(eq(w.m.schemaAuth.sessions.userId, who.userId));
      };
      await activate(w.aOwner);
      await activate(w.aAdmin);
      return { orgId: org.id, owner: { ...w.aOwner, orgId: org.id }, admin: { ...w.aAdmin, orgId: org.id } };
    }

    /** Put the two shared accounts back in org A, whatever a case did. */
    async function restore(): Promise<void> {
      const { eq } = w.m.drizzle;
      for (const who of [w.aOwner, w.aAdmin, w.aMember, w.aViewer]) {
        await w.t.db
          .update(w.m.schemaAuth.sessions)
          .set({ activeOrganizationId: w.orgA })
          .where(eq(w.m.schemaAuth.sessions.userId, who.userId));
      }
    }

    it("ownership transfers to an admin, and the old owner becomes one", async () => {
      const o = await freshOrg("transfer");
      try {
        const res = await call(w, rowNamed("POST /api/app/orgs/:id/transfer"), o.owner, o.orgId, {
          body: { userId: w.aAdmin.userId },
        });
        expect(res.status).toBe(204);
        expect((await w.m.identity.memberRow(o.orgId, w.aAdmin.userId, w.t.db))?.role).toBe("owner");
        expect((await w.m.identity.memberRow(o.orgId, w.aOwner.userId, w.t.db))?.role).toBe("admin");
        expect(await actionsFor(o.orgId)).toContain("org.ownership_transferred");
      } finally {
        await restore();
      }
    });

    it("ownership does not transfer to a plain member", async () => {
      const o = await freshOrg("transfer2");
      try {
        await w.t.db.insert(w.m.schemaAuth.members).values({
          id: w.m.identity.prefixedId("member"),
          organizationId: o.orgId,
          userId: w.aMember.userId,
          role: "member",
          createdAt: new Date(),
        });
        const res = await call(w, rowNamed("POST /api/app/orgs/:id/transfer"), o.owner, o.orgId, {
          body: { userId: w.aMember.userId },
        });
        expect(res.status).toBe(409);
      } finally {
        await restore();
      }
    });

    it("a member leaves: `member.left`, and the roster shrinks", async () => {
      const o = await freshOrg("leave");
      try {
        const res = await call(w, rowNamed("POST /api/app/orgs/:id/leave"), o.admin, o.orgId);
        expect(res.status).toBe(204);
        expect(await w.m.identity.memberRow(o.orgId, w.aAdmin.userId, w.t.db)).toBeNull();
        const row = await lastRow(o.orgId, "member.left");
        expect(row?.target).toEqual({ type: "user", id: w.aAdmin.userId });
      } finally {
        await restore();
      }
    });

    it("an owner removes a member: `member.removed`", async () => {
      const o = await freshOrg("remove");
      try {
        const res = await call(w, rowNamed("DELETE /api/app/members/:userId"), o.owner, w.aAdmin.userId);
        expect(res.status).toBe(204);
        expect(await actionsFor(o.orgId)).toContain("member.removed");
      } finally {
        await restore();
      }
    });
  });

  // ------------------------------------------------------------------------------------- the org lifecycle

  describe("creating and deleting organizations (§3.5)", () => {
    it("a guest cannot create one", async () => {
      const res = await call(w, rowNamed("POST /api/app/orgs"), w.guest, "", { body: { name: "Guest team" } });
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe("E_ACCOUNT_REQUIRED");
    });

    it("an account can, up to three owned", async () => {
      const created: string[] = [];
      // The account already owns one (its fixture org), so two more reach the cap.
      for (let i = 0; i < 2; i++) {
        const res = await call(w, rowNamed("POST /api/app/orgs"), w.bOwner, "", {
          body: { name: `B extra ${i}` },
        });
        expect([i, res.status]).toEqual([i, 201]);
        created.push(String((await bodyOf(res)).id));
      }
      const over = await call(w, rowNamed("POST /api/app/orgs"), w.bOwner, "", { body: { name: "B extra 3" } });
      expect(over.status).toBe(402);
      expect(await codeOf(over)).toBe("E_PLAN_LIMIT");

      for (const id of created) expect(await actionsFor(id)).toContain("org.created");
    });

    it("delete needs the typed confirmation, and then takes the org's data with it", async () => {
      const org = await w.m.identity.createOrg({
        name: "Doomed",
        slug: "doomed-org",
        kind: "team",
        createdVia: "switcher",
        ownerUserId: w.aViewer.userId,
        plan: "free",
      });
      const { eq } = w.m.drizzle;
      await w.t.db
        .update(w.m.schemaAuth.sessions)
        .set({ activeOrganizationId: org.id })
        .where(eq(w.m.schemaAuth.sessions.userId, w.aViewer.userId));
      await w.t.db.insert(w.m.schema.relays).values({
        id: `rl_doomed_${Date.now()}`,
        workspaceId: org.id,
        slug: `doomed-${Date.now()}`,
        title: "A doomed relay",
        origin: "user",
        draft: {},
      });

      try {
        const wrong = await call(w, rowNamed("DELETE /api/app/orgs/:id"), w.aViewer, org.id, {
          body: { confirm: "nope" },
        });
        expect(wrong.status, "the typed confirmation is checked server-side, not only in the UI").toBe(400);

        const ok = await call(w, rowNamed("DELETE /api/app/orgs/:id"), w.aViewer, org.id, {
          body: { confirm: "doomed-org" },
        });
        expect(ok.status).toBe(204);

        const orgs = await w.t.db
          .select({ id: w.m.schemaAuth.organizations.id })
          .from(w.m.schemaAuth.organizations)
          .where(eq(w.m.schemaAuth.organizations.id, org.id));
        expect(orgs).toHaveLength(0);

        const rels = await w.t.db
          .select({ deletedAt: w.m.schema.relays.deletedAt })
          .from(w.m.schema.relays)
          .where(eq(w.m.schema.relays.workspaceId, org.id));
        expect(rels.every((r) => r.deletedAt !== null), "relays are soft-deleted, not dropped").toBe(true);

        // §3.5, §2.7: the audit rows outlive the org — there is no foreign key precisely so they can.
        expect(await actionsFor(org.id)).toContain("org.deleted");
      } finally {
        await w.t.db
          .update(w.m.schemaAuth.sessions)
          .set({ activeOrganizationId: w.orgA })
          .where(eq(w.m.schemaAuth.sessions.userId, w.aViewer.userId));
      }
    });

    it("renaming is audited with the before and after", async () => {
      const res = await call(w, rowNamed("PATCH /api/app/orgs/:id"), w.aOwner, w.orgA, {
        body: { name: "Org A (renamed)" },
      });
      expect(res.status).toBe(200);
      const row = await lastRow(w.orgA, "org.renamed");
      expect(row?.metadata.from).toMatchObject({ name: "Org A" });
      expect(row?.metadata.to).toMatchObject({ name: "Org A (renamed)" });
    });

    it("a slug already in use is a conflict, not a 500", async () => {
      const res = await call(w, rowNamed("PATCH /api/app/orgs/:id"), w.aOwner, w.orgA, {
        body: { slug: "org-b" },
      });
      expect(res.status).toBe(409);
      expect(await codeOf(res)).toBe("E_CONFLICT");
    });

    /**
     * The other half of the same bug, and the one no route surfaces.
     *
     * `isUniqueViolation` used to read `code` off the error drizzle throws. Drizzle 0.45 wraps a failed query in
     * `DrizzleQueryError` and puts the pg error on `cause`, so the check was always false. That cost the 409
     * above *and* — silently — `createOrg`'s retry loop: a collision on a slug that is purely cosmetic aborted
     * the whole create instead of retrying with a fresh suffix. Guest start and `ensurePersonalOrg` both go
     * through that loop, so the failure would have landed on the judge path, not on an admin screen.
     */
    it("createOrg retries a taken slug with a fresh suffix instead of failing", async () => {
      const taken = `dupe-${Date.now().toString(36)}`;
      const first = await w.m.identity.createOrg({
        name: "First",
        slug: taken,
        kind: "team",
        createdVia: "switcher",
        ownerUserId: w.aOwner.userId,
        plan: "free",
      });
      expect(first.slug).toBe(taken);

      const second = await w.m.identity.createOrg({
        name: "Second",
        slug: taken,
        kind: "team",
        createdVia: "switcher",
        ownerUserId: w.aOwner.userId,
        plan: "free",
      });
      expect(second.id).not.toBe(first.id);
      expect(second.slug).not.toBe(taken);
      expect(second.slug.startsWith(`${taken}-`)).toBe(true);

      // The retry must persist the slug it returned, not the one it first tried.
      const [row] = await w.t.pool.query<{ slug: string }>("select slug from organizations where id = $1", [
        second.id,
      ]).then((r) => r.rows);
      expect(row?.slug).toBe(second.slug);
    });
  });

  // ------------------------------------------------------------------------------- §2.6 R1: the device claim

  describe("the shared-device claim (§2.6 R1)", () => {
    it("a forged or absent bvid claims nothing", async () => {
      const bare = req(w.m, w.aOwner, "POST", "/api/app/claim-device");
      // A cookie header with a session but a *tampered* device value: the HMAC is what refuses it.
      bare.headers.set("cookie", `${w.aOwner.cookie.split(";")[0]}; bvid=not-a-signed-value`);
      const res = await w.m.appClaim.postClaimDevice(bare, ctx({}));
      const claimed = (await bodyOf(res)).claimed as Record<string, number> | undefined;
      // The device falls back to a fresh visitor id, which owns nothing: the claim moves zero rows.
      expect(res.status).toBe(200);
      expect(claimed?.relays ?? 0).toBe(0);
      expect(claimed?.cases ?? 0).toBe(0);
    });

    it("declining is idempotent and permanent for that (org, device) pair", async () => {
      expect((await call(w, rowNamed("DELETE /api/app/claim-device"), w.aMember, "")).status).toBe(204);
      expect((await call(w, rowNamed("DELETE /api/app/claim-device"), w.aMember, "")).status).toBe(204);
      const offer = await bodyOf(await call(w, rowNamed("GET /api/app/claim-device"), w.aMember, ""));
      expect(offer.offer).toBe(false);
    });

    it("a signed-in user only ever claims their own device's work", async () => {
      // Legacy work made by A-member's device, and by a stranger's device.
      const ws = (v: string) => `ws_${v}`;
      for (const [vid, name] of [
        [w.aMember.visitorId, "mine"],
        [w.strangerVisitorId, "not mine"],
      ] as const) {
        await w.t.db.insert(w.m.schema.relays).values({
          id: `rl_claim_${name.replace(/\W/g, "")}_${Date.now()}`,
          workspaceId: ws(vid),
          slug: `claim-${name.replace(/\W/g, "")}-${Date.now()}`,
          title: name,
          origin: "user",
          draft: {},
        });
      }
      const res = await call(w, rowNamed("POST /api/app/claim-device"), w.aMember, "");
      expect(res.status).toBe(200);
      const { eq } = w.m.drizzle;
      const stranger = await w.t.db
        .select({ id: w.m.schema.relays.id })
        .from(w.m.schema.relays)
        .where(eq(w.m.schema.relays.workspaceId, ws(w.strangerVisitorId)));
      expect(stranger.length, "the other device's workspace is untouched").toBe(1);
    });
  });
});
