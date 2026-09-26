/**
 * `purgeIdleGuests()` — the 14-day guest lifetime (SAAS §3.3, §10.4). WP19·3.
 *
 * The cases that matter are the ones about *not* deleting: a guest who came back yesterday, a guest org that has
 * been claimed by a real account, and another org's rows sitting in the same tables. A purge that deletes too
 * much is worse than one that deletes too little, so those get the most coverage here.
 *
 * $0: no AssemblyAI, no OpenAI, no network beyond the local Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, HAS_DB, type TestDb } from "../cases/helpers/test-db";

type Mod = {
  purge: typeof import("@/server/identity/guest-purge");
  ids: typeof import("@/server/identity/ids");
  schema: typeof import("@/server/db/schema");
  schemaAuth: typeof import("@/server/db/schema-auth");
  schemaSaas: typeof import("@/server/db/schema-saas");
  drizzle: typeof import("drizzle-orm");
};

let t: TestDb;
let m: Mod;
const DAY = 86_400_000;
let n = 0;

interface SeedOpts {
  kind?: "guest" | "personal" | "team";
  anonymous?: boolean;
  idleDays: number;
  sessionDaysAgo?: number | null;
}

/** An org with an owner, a relay, a draft and a secret, aged as the options say. */
async function seedOrg(opts: SeedOpts): Promise<{ orgId: string; userId: string; relayId: string }> {
  const i = ++n;
  const at = new Date(Date.now() - opts.idleDays * DAY);
  const userId = `usr_seed_${i}`;
  const orgId = `org_seed_${i}`;
  await t.db.insert(m.schemaAuth.users).values({
    id: userId,
    name: `seed ${i}`,
    email: `seed-${i}@guest.changeover.invalid`,
    emailVerified: false,
    isAnonymous: opts.anonymous ?? true,
    createdAt: at,
    updatedAt: at,
  });
  await t.db.insert(m.schemaAuth.organizations).values({
    id: orgId, name: `Seed ${i}`, slug: `seed-${i}`, createdAt: at,
  });
  await t.db.insert(m.schemaAuth.members).values({
    id: `mem_seed_${i}`, organizationId: orgId, userId, role: "owner", createdAt: at,
  });
  await t.db.insert(m.schemaSaas.orgMeta).values({
    orgId, kind: opts.kind ?? "guest", createdVia: "guest_start", lastActiveAt: at, createdAt: at,
  });
  await t.db.insert(m.schemaSaas.orgEntitlements).values({
    orgId, plan: "guest", status: "active", source: "default",
  });
  if (opts.sessionDaysAgo !== null) {
    const sAt = new Date(Date.now() - (opts.sessionDaysAgo ?? opts.idleDays) * DAY);
    await t.db.insert(m.schemaAuth.sessions).values({
      id: `ses_seed_${i}`,
      token: `tok_seed_${i}`,
      userId,
      expiresAt: new Date(Date.now() + 30 * DAY),
      createdAt: sAt,
      updatedAt: sAt,
    });
  }
  const relayId = `rl_seed_${i}`;
  await t.db.insert(m.schema.relays).values({
    id: relayId, workspaceId: orgId, slug: `seed-relay-${i}`, title: `Seed ${i}`, origin: "user", draft: {},
  });
  await t.db.insert(m.schema.drafts).values({
    id: `drf_seed_${i}`, workspaceId: orgId, input: {}, status: "ok",
  });
  return { orgId, userId, relayId };
}

const orgExists = async (orgId: string): Promise<boolean> => {
  const { eq } = m.drizzle;
  const rows = await t.db
    .select({ id: m.schemaAuth.organizations.id })
    .from(m.schemaAuth.organizations)
    .where(eq(m.schemaAuth.organizations.id, orgId));
  return rows.length > 0;
};

describe.skipIf(!HAS_DB)("WP19·3 purgeIdleGuests", () => {
  beforeAll(async () => {
    t = await createTestDb("wp19_guestpurge");
    process.env.DATABASE_URL = t.url;
    (await import("@/server/env")).resetEnvCache();
    m = {
      purge: await import("@/server/identity/guest-purge"),
      ids: await import("@/server/identity/ids"),
      schema: await import("@/server/db/schema"),
      schemaAuth: await import("@/server/db/schema-auth"),
      schemaSaas: await import("@/server/db/schema-saas"),
      drizzle: await import("drizzle-orm"),
    };
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    for (const table of ["drafts", "relays", "relay_publications", "members", "organizations", "sessions", "users"]) {
      await t.pool.query(`delete from ${table}`);
    }
  });

  it("purges a guest idle past 14 days, with its relays and drafts", async () => {
    const g = await seedOrg({ idleDays: 20 });
    const out = await m.purge.purgeIdleGuests(t.db);
    expect(out.orgs).toBe(1);
    expect(out.relays).toBe(1);
    expect(out.drafts).toBe(1);
    expect(await orgExists(g.orgId)).toBe(false);

    const { eq } = m.drizzle;
    const [relay] = await t.db
      .select({ deletedAt: m.schema.relays.deletedAt })
      .from(m.schema.relays)
      .where(eq(m.schema.relays.id, g.relayId));
    expect(relay?.deletedAt, "relays are soft-deleted, not dropped").not.toBeNull();

    const users = await t.db
      .select({ id: m.schemaAuth.users.id })
      .from(m.schemaAuth.users)
      .where(eq(m.schemaAuth.users.id, g.userId));
    expect(users).toHaveLength(0);
  });

  it("keeps a guest who was active yesterday", async () => {
    const g = await seedOrg({ idleDays: 1 });
    expect((await m.purge.purgeIdleGuests(t.db)).orgs).toBe(0);
    expect(await orgExists(g.orgId)).toBe(true);
  });

  it("keeps a guest whose org looks idle but whose session is recent", async () => {
    const g = await seedOrg({ idleDays: 30, sessionDaysAgo: 2 });
    expect((await m.purge.purgeIdleGuests(t.db)).orgs).toBe(0);
    expect(await orgExists(g.orgId)).toBe(true);
  });

  it("never touches a claimed org: a real account's workspace has no expiry", async () => {
    const claimed = await seedOrg({ idleDays: 400, anonymous: false, kind: "personal" });
    const stillGuestKind = await seedOrg({ idleDays: 400, anonymous: false, kind: "guest" });
    expect((await m.purge.purgeIdleGuests(t.db)).orgs).toBe(0);
    expect(await orgExists(claimed.orgId)).toBe(true);
    expect(await orgExists(stillGuestKind.orgId), "the owner is a real account, so it stays").toBe(true);
  });

  it("never touches a team org, however idle", async () => {
    const team = await seedOrg({ idleDays: 400, kind: "team" });
    expect((await m.purge.purgeIdleGuests(t.db)).orgs).toBe(0);
    expect(await orgExists(team.orgId)).toBe(true);
  });

  it("leaves another org's rows alone while purging one", async () => {
    const doomed = await seedOrg({ idleDays: 20 });
    const alive = await seedOrg({ idleDays: 1 });
    const out = await m.purge.purgeIdleGuests(t.db);
    expect(out.orgs).toBe(1);
    expect(await orgExists(doomed.orgId)).toBe(false);
    expect(await orgExists(alive.orgId)).toBe(true);

    const { eq } = m.drizzle;
    const [relay] = await t.db
      .select({ deletedAt: m.schema.relays.deletedAt })
      .from(m.schema.relays)
      .where(eq(m.schema.relays.id, alive.relayId));
    expect(relay?.deletedAt, "the surviving org's relay is untouched").toBeNull();
    const drafts = await t.db
      .select({ id: m.schema.drafts.id })
      .from(m.schema.drafts)
      .where(eq(m.schema.drafts.workspaceId, alive.orgId));
    expect(drafts).toHaveLength(1);
  });

  it("hands live publications to WP18's `deleting` queue rather than deleting the agent itself", async () => {
    const g = await seedOrg({ idleDays: 20 });
    await t.db.insert(m.schema.relayPublications).values({
      id: "pub_seed_1",
      relayId: g.relayId,
      versionId: "rv_seed_1",
      shareSlug: "seed-share-1",
      keyHash: "hash",
      status: "live",
      orgId: g.orgId,
      aaiAgentId: "agent_1",
    });
    const out = await m.purge.purgeIdleGuests(t.db);
    expect(out.publicationsLeftToWp18).toBe(1);
    const { eq } = m.drizzle;
    const [pub] = await t.db
      .select({ status: m.schema.relayPublications.status })
      .from(m.schema.relayPublications)
      .where(eq(m.schema.relayPublications.id, "pub_seed_1"));
    expect(pub?.status).toBe("deleting");
  });

  it("is a no-op the second time, and reports zeroes rather than throwing", async () => {
    await seedOrg({ idleDays: 20 });
    expect((await m.purge.purgeIdleGuests(t.db)).orgs).toBe(1);
    expect(await m.purge.purgeIdleGuests(t.db)).toMatchObject({ orgs: 0, relays: 0, drafts: 0 });
  });

  it("honours the window the caller passes, so WP12 can tune it without a deploy", async () => {
    const g = await seedOrg({ idleDays: 5 });
    expect((await m.purge.purgeIdleGuests(t.db, Date.now(), { days: 30 })).orgs).toBe(0);
    expect((await m.purge.purgeIdleGuests(t.db, Date.now(), { days: 3 })).orgs).toBe(1);
    expect(await orgExists(g.orgId)).toBe(false);
  });

  it("the step shape WP12 mounts reports its counts", async () => {
    await seedOrg({ idleDays: 20 });
    const out = await m.purge.idleGuestStep({ db: t.db, now: Date.now() });
    expect(out).toMatchObject({ guestOrgs: 1, guestRelays: 1, guestDrafts: 1 });
  });
});
