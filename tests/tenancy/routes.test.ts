/**
 * The cross-tenant suite, table-driven half (SAAS §10.1, TASKS-v3 §7 WP19·3). WP19·3.
 *
 * For every row of `manifest.ts`:
 *
 * | Assertion | §10.1 |
 * |---|---|
 * | B's principals get 404 on A's ids | "B's principals get 404 on A's ids (read and write)" |
 * | the viewer gets 403 on writes | "the viewer gets 403 on writes" |
 * | a key never works on `/api/app/**` | "a key never works on `/api/app/**` or `/api/relays/**`" |
 * | a cross-origin write with A's cookie → 403 `E_CSRF` | "CSRF" |
 * | a forged `activeOrganizationId` is ignored | "set-active … a forged `activeOrganizationId` cookie value" |
 * | no cookie at all → 401 with a `start` path | §2.3 |
 *
 * The point of the table is completeness: `coverage.test.ts` fails if a route file appears under
 * `src/app/api/app/**` without a row here, so "we forgot to check the new route" cannot happen quietly.
 *
 * **Nothing in this file may leave the world changed**, because every case shares one world. That is not a
 * limitation: a refusal is the assertion, so the principal chosen for each positive control is the one whose
 * request is refused for a reason *other* than tenancy — a viewer on a write (403), the last owner on a leave
 * (409), the wrong typed confirmation on a delete (400). `members.test.ts` owns the cases that actually mutate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ROLE_PERMISSIONS } from "@/core/contracts/v3/permissions";

import { call } from "./helpers/dispatch";
import { ROUTES, type RouteRow } from "./manifest";
import { bodyOf, buildWorld, codeOf, ctx, deviceCookie, HAS_DB, req, type World } from "./helpers/world";

let w: World;

/** Rows that address a resource id, so "B on A's id" is a question that can be asked. */
const addressed = ROUTES.filter((r) => r.idFor !== null);
/** Rows a viewer is not allowed to perform, derived from the §3.7 matrix rather than listed by hand. */
const forbiddenToViewer = ROUTES.filter(
  (r) => r.perm !== null && !ROLE_PERMISSIONS.viewer.includes(r.perm),
);
const readOnly = ROUTES.filter((r) => !r.mutates);

const idOf = (row: RouteRow, org: "A" | "B") => (row.idFor ? row.idFor(w, org) : "");
const named = (rows: readonly RouteRow[]) => rows.map((r) => [r.name, r] as const);
const rowNamed = (name: string): RouteRow => {
  const r = ROUTES.find((x) => x.name === name);
  if (!r) throw new Error(`no manifest row named ${name}`);
  return r;
};

describe.skipIf(!HAS_DB)("tenancy: the org routes", () => {
  beforeAll(async () => {
    w = await buildWorld("wp19_tenancy_routes");

    // One real pending invitation per org, so `DELETE /api/app/invitations/:id` addresses a real id and the 404
    // the other org gets means "not yours", not "not there".
    for (const [org, who] of [["A", w.aOwner], ["B", w.bOwner]] as const) {
      const res = await call(w, rowNamed("POST /api/app/invitations"), who, "", {
        body: { email: `pending-${org.toLowerCase()}@tenancy.test`, role: "member" },
      });
      expect(res.status, `the ${org} fixture invitation should be created`).toBe(201);
      w.ids[`invite${org}`] = String((await bodyOf(res)).id);
    }
  }, 120_000);

  afterAll(async () => {
    await w?.t.drop();
  });

  // --------------------------------------------------------- §10.1 rule 2: a foreign id is a 404, never a 403

  describe("B's principals get 404 on A's ids", () => {
    it.each(named(addressed))("%s", async (_name, row) => {
      const res = await call(w, row, w.bOwner, idOf(row, "A"), { org: "B" });
      expect([row.name, res.status]).toEqual([row.name, 404]);
      expect(await codeOf(res)).toBe("E_NOT_FOUND");
    });

    /**
     * The control. Without it, a route that 404s *everything* would pass the block above. Each principal here is
     * one whose request is refused for its own reason — never "no such thing", which is reserved for another
     * tenant — and therefore changes nothing.
     */
    it.each(named(addressed))("%s — and the same id inside A is not a 404", async (_name, row) => {
      // The last owner leaving is a 409; a viewer doing anything else is a 403. Neither mutates.
      const who = row.name === "POST /api/app/orgs/:id/leave" ? w.aOwner : w.aViewer;
      const res = await call(w, row, who, idOf(row, "A"));
      expect([row.name, res.status]).not.toEqual([row.name, 404]);
      expect([row.name, res.status < 500]).toEqual([row.name, true]);
    });
  });

  // ------------------------------------------------------------------- §3.7: the viewer reads, never writes

  describe("the permission matrix holds at the route", () => {
    it.each(named(forbiddenToViewer))("%s → 403 for the viewer", async (_name, row) => {
      const res = await call(w, row, w.aViewer, idOf(row, "A"));
      expect([row.name, res.status]).toEqual([row.name, 403]);
      expect(await codeOf(res)).toBe("E_FORBIDDEN");
    });

    it.each(named(readOnly))("%s → the viewer may read it, unless it is admin+", async (_name, row) => {
      const res = await call(w, row, w.aViewer, idOf(row, "A"));
      // `audit:read` is admin+ (§3.7), so the Audit route is the one read a viewer does not get.
      const expected = ROLE_PERMISSIONS.viewer.includes(row.perm!) || row.perm === null ? 200 : 403;
      expect([row.name, res.status]).toEqual([row.name, expected]);
    });

    it("a member may read the roster but not change a role", async () => {
      expect((await call(w, rowNamed("GET /api/app/members"), w.aMember, "")).status).toBe(200);
      const res = await call(w, rowNamed("PATCH /api/app/members/:userId"), w.aMember, w.aViewer.userId);
      expect(res.status).toBe(403);
    });

    it("an admin may not touch an owner (§3.7)", async () => {
      const res = await call(w, rowNamed("PATCH /api/app/members/:userId"), w.aAdmin, w.aOwner.userId, {
        body: { role: "member" },
      });
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe("E_FORBIDDEN");
    });

    it("an admin may not invite an owner: roles go up to one's own", async () => {
      const res = await call(w, rowNamed("POST /api/app/invitations"), w.aAdmin, "", {
        body: { email: "would-be-owner@tenancy.test", role: "owner" },
      });
      expect(res.status).toBe(403);
    });
  });

  // ------------------------------------------------------------------- §2.5: keys are a `/api/v1` thing

  describe("an API key never works on /api/app/**", () => {
    // Built at runtime: a `cko_…`-shaped literal in a test file is still a credential-shaped literal.
    const fakeKey = ["cko", "x".repeat(24)].join("_");

    it.each(named(ROUTES))("%s", async (_name, row) => {
      const res = await call(w, row, null, idOf(row, "A"), {
        headers: { authorization: `Bearer ${fakeKey}`, cookie: deviceCookie(w.m, w.strangerVisitorId) },
      });
      // Off `/api/v1` the key is not even looked at, so this is an unauthenticated request with no org.
      expect([row.name, res.status]).toEqual([row.name, 401]);
      expect(await codeOf(res)).toBe("E_AUTH_REQUIRED");
    });

    it("and a session that also presents one is still judged as the session", async () => {
      const res = await call(w, rowNamed("GET /api/app/members"), w.aViewer, "", {
        headers: { authorization: `Bearer ${fakeKey}` },
      });
      expect(res.status).toBe(200);
    });
  });

  // ------------------------------------------------------------------- §3.9: CSRF

  describe("CSRF", () => {
    it.each(named(ROUTES.filter((r) => r.mutates)))("%s → 403 E_CSRF from another origin", async (_n, row) => {
      const res = await call(w, row, w.aOwner, idOf(row, "A"), { origin: "https://evil.example" });
      expect([row.name, res.status]).toEqual([row.name, 403]);
      expect(await codeOf(res)).toBe("E_CSRF");
    });

    it("a cross-origin READ is not a CSRF problem: the response cannot be read back", async () => {
      const res = await call(w, rowNamed("GET /api/app/members"), w.aOwner, "", {
        origin: "https://evil.example",
      });
      expect(res.status).toBe(200);
    });

    it("`Sec-Fetch-Site: same-origin` passes with no Origin header at all", async () => {
      expect((await call(w, rowNamed("GET /api/app/claim-device"), w.aOwner, "")).status).toBe(200);
    });
  });

  // ------------------------------------------------------------------- §2.3: no principal, no org

  describe("no session at all", () => {
    it.each(named(ROUTES))("%s → 401 with a start path", async (_name, row) => {
      const res = await call(w, row, null, idOf(row, "A"), {
        headers: { cookie: deviceCookie(w.m, w.strangerVisitorId) },
      });
      expect([row.name, res.status]).toEqual([row.name, 401]);
      const body = await bodyOf(res);
      expect(String(body.start ?? "")).toMatch(/^\/start\?next=/);
    });

    it("a request with no cookies whatsoever is a 401, not a 500", async () => {
      const bare = req(w.m, null, "GET", "/api/app/members");
      bare.headers.delete("cookie");
      const res = await w.m.appMembers.listMembersRoute(bare, ctx({}));
      expect(res.status).toBe(401);
    });
  });

  // ------------------------------------------------------- §10.1 rule 3: the org comes only from the principal

  describe("the acting org comes only from the principal", () => {
    it("a body naming another org changes nothing in that org", async () => {
      const res = await call(w, rowNamed("PATCH /api/app/orgs/:id"), w.aOwner, w.orgA, {
        body: { name: "Set by A", orgId: w.orgB, organizationId: w.orgB },
      });
      expect(res.status).toBe(200);
      const { eq } = w.m.drizzle;
      const [b] = await w.t.db
        .select({ name: w.m.schemaAuth.organizations.name })
        .from(w.m.schemaAuth.organizations)
        .where(eq(w.m.schemaAuth.organizations.id, w.orgB));
      expect(b?.name, "B must be untouched by a write A aimed at it").toBe("Org B");
    });

    it("a forged active organization is ignored: the principal falls back to a real membership", async () => {
      const { eq } = w.m.drizzle;
      const setActive = (userId: string, orgId: string) =>
        w.t.db
          .update(w.m.schemaAuth.sessions)
          .set({ activeOrganizationId: orgId })
          .where(eq(w.m.schemaAuth.sessions.userId, userId));

      await setActive(w.aMember.userId, w.orgB);
      try {
        const res = await call(w, rowNamed("GET /api/app/members"), w.aMember, "");
        expect(res.status).toBe(200);
        const members = (await bodyOf(res)).members as { email: string }[];
        // A-member is not in B, so the forged value is dropped and A is used: B's roster never appears.
        expect(members.map((x) => x.email).sort()).toEqual([
          "a-admin@tenancy.test",
          "a-member@tenancy.test",
          "a-owner@tenancy.test",
          "a-viewer@tenancy.test",
        ]);
      } finally {
        await setActive(w.aMember.userId, w.orgA);
      }
    });

    it("a nonexistent active organization falls back too, rather than 500ing", async () => {
      const { eq } = w.m.drizzle;
      await w.t.db
        .update(w.m.schemaAuth.sessions)
        .set({ activeOrganizationId: "org_does_not_exist" })
        .where(eq(w.m.schemaAuth.sessions.userId, w.aViewer.userId));
      try {
        const res = await call(w, rowNamed("GET /api/app/members"), w.aViewer, "");
        expect(res.status).toBe(200);
      } finally {
        await w.t.db
          .update(w.m.schemaAuth.sessions)
          .set({ activeOrganizationId: w.orgA })
          .where(eq(w.m.schemaAuth.sessions.userId, w.aViewer.userId));
      }
    });
  });
});
