import "server-only";

/**
 * Creating and reading organizations at the row level (SAAS §2.2, §2.7, §3.3 step 4, §3.5).
 *
 * One place writes the four rows that make an organization real — `organizations`, `members` (the owner),
 * `org_meta` and `org_entitlements` — so guest start, `ensurePersonalOrg` and WP19·3's `POST /api/app/orgs` cannot
 * drift apart. It is a plain Drizzle module: no `better-auth` import, so `/api/app/**` can use it directly.
 *
 * Better Auth's own `organization/create` endpoint is blocked for clients (§3.8) precisely so that every org is born
 * here, with its metadata and entitlements in the same transaction.
 */
import { and, count, eq, gt, sql } from "drizzle-orm";

import type { OrgKind, OrgSummary, PlanId, Role } from "../../core/contracts/v3/identity";
import type { Db } from "../db/client";
import { getDb } from "../db/client";
import { invitations, members, organizations } from "../db/schema-auth";
import { orgEntitlements, orgMeta } from "../db/schema-saas";
import { prefixedId } from "./ids";

/** The handle a Drizzle transaction callback receives. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that can run our writes: the pool or an open transaction. */
export type Runner = Db | Tx;

export type CreatedVia = "guest_start" | "onboarding" | "switcher" | "claim" | "auto_personal";

export interface NewOrg {
  name: string;
  slug: string;
  kind: OrgKind;
  createdVia: CreatedVia;
  ownerUserId: string;
  plan: PlanId;
  pinnedRelayIds?: readonly string[];
}

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  kind: OrgKind;
  plan: PlanId;
}

/** §2.2: a real user owns at most 3 orgs; a claimed guest org may push them over, and nothing is ever lost. */
export const MAX_OWNED_ORGS = 3;

const SLUG_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789"; // no l/1/0/o: slugs get read aloud

function randomSuffix(n: number): string {
  let s = "";
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) s += SLUG_ALPHABET[b % SLUG_ALPHABET.length];
  return s;
}

/** Lowercase, `[a-z0-9-]`, no leading/trailing dash, ≤ 40 characters. Empty input falls back to "workspace". */
export function slugify(raw: string): string {
  const base = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base || "workspace";
}

/** `guest-<8>` (§2.2). */
export const guestSlug = (): string => `guest-${randomSuffix(8)}`;
/** `<email-local>-<4>` (§2.2). */
export const personalSlug = (email: string): string => `${slugify(email.split("@")[0] ?? "workspace")}-${randomSuffix(4)}`;

/** "<Name>'s workspace" — the name a claimed guest org and an auto personal org both get (§3.1, §3.4). */
export function workspaceName(nameOrEmail: string | null | undefined): string {
  const raw = (nameOrEmail ?? "").trim();
  const display = raw.includes("@") ? (raw.split("@")[0] ?? raw) : raw;
  const clean = display || "Your";
  return `${clean}${clean.endsWith("s") ? "'" : "'s"} workspace`;
}

/**
 * Insert the organization, its owner membership, its metadata and its entitlements. The caller supplies the
 * transaction when it has one (guest start runs all of §3.3 step 4 in one).
 *
 * A slug collision retries with a fresh suffix rather than failing: the slug is cosmetic, the id is the identity.
 */
export async function createOrg(o: NewOrg, run: Runner = getDb()): Promise<OrgRow> {
  const id = prefixedId("organization");
  let slug = o.slug;
  for (let attempt = 0; ; attempt++) {
    try {
      await run
        .insert(organizations)
        .values({ id, name: o.name, slug, createdAt: new Date(), metadata: null });
      break;
    } catch (err) {
      if (attempt >= 3 || !isUniqueViolation(err)) throw err;
      slug = `${slugify(o.slug)}-${randomSuffix(4)}`;
    }
  }
  await run.insert(members).values({
    id: prefixedId("member"),
    organizationId: id,
    userId: o.ownerUserId,
    role: "owner" satisfies Role,
    createdAt: new Date(),
  });
  await run.insert(orgMeta).values({
    orgId: id,
    kind: o.kind,
    createdVia: o.createdVia,
    pinnedRelayIds: [...(o.pinnedRelayIds ?? [])],
    connectorHosts: [],
    onboarding: {},
  });
  await run.insert(orgEntitlements).values({
    orgId: id,
    plan: o.plan,
    status: "active",
    source: "default",
    overrides: {},
  });
  return { id, name: o.name, slug, kind: o.kind, plan: o.plan };
}

/**
 * Postgres 23505 (unique violation).
 *
 * **Drizzle does not re-throw the pg error bare.** Since 0.45 it wraps a failed query in `DrizzleQueryError`,
 * which carries `query`/`params` and puts the driver's error — the one with `code` — on `cause`. Reading `code`
 * off the top-level error therefore always saw `undefined`, which cost two things silently: `renameOrg` turned a
 * taken slug into a 500 instead of `E_CONFLICT`, and `createOrg`'s retry loop below gave up on the first
 * collision instead of trying a fresh suffix (so a guest start or a personal org could fail outright on a slug
 * that is only cosmetic). Walk the chain rather than pinning the shape to one driver or drizzle version.
 */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e !== null && e !== undefined && depth < 5; depth++) {
    if (typeof e !== "object") break;
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export async function getOrg(orgId: string, run: Runner = getDb()): Promise<OrgRow | null> {
  const [row] = await run
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      kind: orgMeta.kind,
      plan: orgEntitlements.plan,
    })
    .from(organizations)
    .leftJoin(orgMeta, eq(orgMeta.orgId, organizations.id))
    .leftJoin(orgEntitlements, eq(orgEntitlements.orgId, organizations.id))
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: (row.kind ?? "team") as OrgKind,
    plan: (row.plan ?? "free") as PlanId,
  };
}

/** How many orgs this user owns (the §2.2 cap, checked by WP19·3's create route). */
export async function countOwnedOrgs(userId: string, run: Runner = getDb()): Promise<number> {
  const [row] = await run
    .select({ n: count() })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.role, "owner")));
  return Number(row?.n ?? 0);
}

/**
 * The `seats` count limit (SAAS §4.1): **members plus pending invitations**. Counting only members would let an
 * org sit one accept away from being over its plan every time, which is the shape of limit that annoys a user
 * after they have already told someone "you're in".
 *
 * An expired invitation does not hold a seat: the row stays for the Members page's history, but it can no longer
 * be accepted, so it cannot become a member.
 */
export async function countSeats(orgId: string, run: Runner = getDb()): Promise<number> {
  const [m] = await run.select({ n: count() }).from(members).where(eq(members.organizationId, orgId));
  const [i] = await run
    .select({ n: count() })
    .from(invitations)
    .where(
      and(
        eq(invitations.organizationId, orgId),
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, new Date()),
      ),
    );
  return Number(m?.n ?? 0) + Number(i?.n ?? 0);
}

/** The plan of an org, for the principal. `free` when the row is missing (an org created outside `createOrg`). */
export async function planOf(orgId: string, run: Runner = getDb()): Promise<PlanId> {
  const [row] = await run
    .select({ plan: orgEntitlements.plan })
    .from(orgEntitlements)
    .where(eq(orgEntitlements.orgId, orgId))
    .limit(1);
  return (row?.plan ?? "free") as PlanId;
}

/** A single round trip for the session principal: role, kind and plan for one (user, org) pair. */
export async function principalFactsFor(
  userId: string,
  orgId: string,
  run: Runner = getDb(),
): Promise<{ role: Role; kind: OrgKind; plan: PlanId } | null> {
  const [row] = await run
    .select({ role: members.role, kind: orgMeta.kind, plan: orgEntitlements.plan })
    .from(members)
    .leftJoin(orgMeta, eq(orgMeta.orgId, members.organizationId))
    .leftJoin(orgEntitlements, eq(orgEntitlements.orgId, members.organizationId))
    .where(and(eq(members.userId, userId), eq(members.organizationId, orgId)))
    .limit(1);
  if (!row) return null;
  return {
    // A role outside our four is not a role: the principal gets nothing rather than something unexpected.
    role: (["owner", "admin", "member", "viewer"] as const).includes(row.role as Role) ? (row.role as Role) : "viewer",
    kind: (row.kind ?? "team") as OrgKind,
    plan: (row.plan ?? "free") as PlanId,
  };
}

/**
 * Every org this user belongs to, most recently active first — the org switcher's list (SAAS §3.5).
 *
 * One query with two left joins rather than a membership list plus a lookup per org: the switcher renders on
 * every app page, and N+1 there is N+1 on the whole app.
 */
export async function listOrgSummaries(userId: string, run: Runner = getDb()): Promise<OrgSummary[]> {
  const rows = await run
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      role: members.role,
      kind: orgMeta.kind,
      plan: orgEntitlements.plan,
      lastActiveAt: orgMeta.lastActiveAt,
    })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .leftJoin(orgMeta, eq(orgMeta.orgId, members.organizationId))
    .leftJoin(orgEntitlements, eq(orgEntitlements.orgId, members.organizationId))
    .where(eq(members.userId, userId))
    .orderBy(sql`coalesce(${orgMeta.lastActiveAt}, 'epoch'::timestamptz) desc`, organizations.id);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    kind: (r.kind ?? "team") as OrgKind,
    role: (["owner", "admin", "member", "viewer"] as const).includes(r.role as Role) ? (r.role as Role) : "viewer",
    plan: (r.plan ?? "free") as PlanId,
  }));
}

/** Rename and/or re-slug an org (§3.5, admin+). A slug already in use is a conflict, not a silent suffix. */
export async function renameOrg(
  orgId: string,
  patch: { name?: string; slug?: string },
  run: Runner = getDb(),
): Promise<void> {
  const values: { name?: string; slug?: string } = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.slug !== undefined) values.slug = patch.slug;
  if (Object.keys(values).length === 0) return;
  await run.update(organizations).set(values).where(eq(organizations.id, orgId));
}

/** Postgres 23505, re-exported so a route can turn a slug collision into `E_CONFLICT` rather than a 500. */
export const isSlugTaken = isUniqueViolation;

/**
 * Delete the organization row. `org_meta`, `org_entitlements`, `members` and `invitations` cascade; `audit_log`,
 * `usage_events` and `domain_events` deliberately do **not** (SAAS §2.7) — they are history, and §3.5 keeps them
 * for 30 days after the org is gone. The audit retention purge collects them.
 */
export async function deleteOrgRow(orgId: string, run: Runner = getDb()): Promise<void> {
  await run.delete(organizations).where(eq(organizations.id, orgId));
}

/** Advisory lock helper: serialize per-user org creation so `ensurePersonalOrg` cannot double-create (§3.1). */
export async function withUserLock<T>(userId: string, fn: (tx: Tx) => Promise<T>, db: Db = getDb()): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`org:user:${userId}`}))`);
    return fn(tx);
  });
}
