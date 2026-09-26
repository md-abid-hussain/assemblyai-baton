/**
 * The cross-tenant suite's fixtures (SAAS §10.1). WP19·3.
 *
 * Two organizations, A and B, and the six principals §10.1 names: A-owner, A-admin, A-member, A-viewer, B-owner
 * and a guest G with its own device. Everything is real — a throwaway Postgres, the real migrations, the real
 * Better Auth instance, the real route handlers — because a tenancy suite built on mocks proves that the mocks
 * are isolated.
 *
 * **How it points at a throwaway database.** `getDb()` memoizes a pool from `DATABASE_URL`, so the env var is
 * repointed *before* the server modules are imported and every import is dynamic, inside `buildWorld()`. Vitest
 * isolates each file in its own worker, so this cannot leak into another suite. (The same trick, and the same
 * reason, as `tests/unit/server/identity/flow.test.ts`.)
 *
 * **Only the session token cookie is sent.** Better Auth's `co.session_data` cache cookie would let a request
 * answer from a five-minute-old snapshot of the session, including its active organization — which is exactly
 * the thing several of these tests are trying to change and then observe. Dropping it makes every assertion read
 * the database.
 *
 * $0: no AssemblyAI, no OpenAI, no network beyond the local Postgres.
 */
import { createTestDb, HAS_DB, type TestDb } from "../../unit/server/cases/helpers/test-db";

/** ≥ 32 characters (§15). A literal test value: it is not a credential for anything. */
export const TEST_SECRET = "wp19-tenancy-secret-00000000000000000";
export const APP_URL = "https://app.example.test";
/** A password that satisfies §3.1's `minPasswordLength: 10`. Test-only, and never a real account's. */
const TEST_PASSWORD = "tenancy-suite-pw-1";

export { HAS_DB };

export interface Modules {
  identity: typeof import("@/server/identity");
  appHttp: typeof import("@/server/identity/app-http");
  appOrgs: typeof import("@/server/identity/app-orgs");
  appMembers: typeof import("@/server/identity/app-members");
  appInvitations: typeof import("@/server/identity/app-invitations");
  appAudit: typeof import("@/server/identity/app-audit");
  appClaim: typeof import("@/server/identity/app-claim");
  // Added at G3: WP21's billing routes and WP16's connector-host routes are `src/app/api/app/**` too, so the
  // manifest covers them and the dispatcher has to be able to reach their handlers.
  billingRoutes: typeof import("@/server/billing/routes");
  connectorRoutes: typeof import("@/server/connectors/routes");
  audit: typeof import("@/server/audit");
  events: typeof import("@/server/events");
  usageWriter: typeof import("@/server/saas/usage-writer");
  ports: typeof import("@/server/saas/ports");
  routes: typeof import("@/server/identity/routes");
  visitor: typeof import("@/server/auth/visitor");
  schemaAuth: typeof import("@/server/db/schema-auth");
  schemaSaas: typeof import("@/server/db/schema-saas");
  schema: typeof import("@/server/db/schema");
  drizzle: typeof import("drizzle-orm");
  db: typeof import("@/server/db/client");
}

export interface Who {
  label: string;
  userId: string;
  email: string;
  /** The `cookie:` header value: the session token, and the device cookie. */
  cookie: string;
  visitorId: string;
  orgId: string;
}

export interface World {
  t: TestDb;
  m: Modules;
  orgA: string;
  orgB: string;
  aOwner: Who;
  aAdmin: Who;
  aMember: Who;
  aViewer: Who;
  bOwner: Who;
  /** The guest: an anonymous account with its own guest org, started through the real `/api/guest/start`. */
  guest: Who;
  /** A device with no session at all. */
  strangerVisitorId: string;
  /** Fixture resource ids the manifest addresses, filled in by the suite once the world exists. */
  ids: Record<string, string>;
}

/** A request the app would make: same-origin, JSON, with this principal's cookies. */
export function req(
  m: Modules,
  who: Pick<Who, "cookie"> | null,
  method: string,
  path: string,
  body?: unknown,
  over: { origin?: string | null; headers?: Record<string, string> } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json", ...(over.headers ?? {}) });
  if (who) headers.set("cookie", who.cookie);
  if (over.origin === undefined) headers.set("sec-fetch-site", "same-origin");
  else if (over.origin !== null) headers.set("origin", over.origin);
  if (!headers.has("x-real-ip")) headers.set("x-real-ip", "198.51.100.9");
  return new Request(`${APP_URL}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A `RouteCtx` for a dynamic segment. */
export const ctx = <P extends Record<string, string>>(params: P): { params: Promise<P> } => ({
  params: Promise.resolve(params),
});

/** The parsed body of a response, or `null` for a 204. */
export async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  if (res.status === 204) return {};
  const text = await res.text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** The §6.3 error code of a response, or `null` when it is not an error envelope. */
export async function codeOf(res: Response): Promise<string | null> {
  const b = await bodyOf(res);
  const e = b.error as { code?: string } | undefined;
  return e?.code ?? null;
}

/** `Set-Cookie` values → a `cookie:` header, keeping only the session token (see the file header). */
function sessionCookieOf(setCookie: readonly string[]): string {
  return setCookie
    .map((c) => c.split(";")[0] ?? "")
    .filter((c) => c.startsWith("co.session_token="))
    .join("; ");
}

/** A request carrying a signed `bvid` cookie, like the v2 proxy sets. */
function deviceReq(m: Modules, visitorId: string, init: RequestInit & { url?: string } = {}): Request {
  const headers = new Headers(init.headers);
  const device = `${m.visitor.VISITOR_COOKIE}=${encodeURIComponent(m.visitor.signVisitorId(visitorId))}`;
  const existing = headers.get("cookie");
  headers.set("cookie", existing ? `${existing}; ${device}` : device);
  if (!headers.has("x-real-ip")) headers.set("x-real-ip", "198.51.100.9");
  return new Request(init.url ?? `${APP_URL}/api/guest/start`, { method: init.method ?? "POST", headers });
}

export const deviceCookie = (m: Modules, visitorId: string): string =>
  `${m.visitor.VISITOR_COOKIE}=${encodeURIComponent(m.visitor.signVisitorId(visitorId))}`;

/**
 * Sign a user up and put them in `orgId` with `role`, then make that org active.
 *
 * The active org is set with a direct `UPDATE` rather than through `auth.api.setActiveOrganization` on purpose:
 * the membership is created *after* sign-up, so the session hook's `pickActiveOrg` already ran and saw nothing,
 * and the suite needs the state to be exactly what it says it is, not what a second endpoint decided.
 */
async function makeUser(
  m: Modules,
  auth: NonNullable<ReturnType<Modules["identity"]["getAuth"]>>,
  db: TestDb,
  label: string,
  orgId: string,
  role: "owner" | "admin" | "member" | "viewer",
  opts: { createsOrg?: { name: string; slug: string } } = {},
): Promise<Who> {
  const email = `${label}@tenancy.test`;
  const visitorId = m.visitor.newVisitorId();
  const res = (await auth.api.signUpEmail({
    body: { email, password: TEST_PASSWORD, name: label },
    asResponse: true,
  })) as Response;
  if (res.status >= 400) throw new Error(`sign-up failed for ${label}: ${res.status} ${await res.text()}`);
  const token = sessionCookieOf(res.headers.getSetCookie());
  if (!token) throw new Error(`no session cookie for ${label}`);

  const { eq } = m.drizzle;
  const [user] = await db.db
    .select({ id: m.schemaAuth.users.id })
    .from(m.schemaAuth.users)
    .where(eq(m.schemaAuth.users.email, email))
    .limit(1);
  if (!user) throw new Error(`no user row for ${label}`);

  let targetOrg = orgId;
  if (opts.createsOrg) {
    const org = await m.identity.createOrg({
      name: opts.createsOrg.name,
      slug: opts.createsOrg.slug,
      kind: "team",
      createdVia: "onboarding",
      ownerUserId: user.id,
      plan: "free",
    });
    targetOrg = org.id;
  } else {
    await db.db.insert(m.schemaAuth.members).values({
      id: m.identity.prefixedId("member"),
      organizationId: orgId,
      userId: user.id,
      role,
      createdAt: new Date(),
    });
  }

  await db.db
    .update(m.schemaAuth.sessions)
    .set({ activeOrganizationId: targetOrg })
    .where(eq(m.schemaAuth.sessions.userId, user.id));

  return {
    label,
    userId: user.id,
    email,
    cookie: `${token}; ${deviceCookie(m, visitorId)}`,
    visitorId,
    orgId: targetOrg,
  };
}

/** Build the whole world. Called once per test file, in `beforeAll`. */
export async function buildWorld(tag: string): Promise<World> {
  const t = await createTestDb(tag);

  process.env.DATABASE_URL = t.url;
  process.env.BETTER_AUTH_SECRET = TEST_SECRET;
  process.env.BETTER_AUTH_URL = APP_URL;
  process.env.APP_URL = APP_URL;
  process.env.TENANCY_MODE = "orgs";
  // v2's device cookie signer. A literal test value, like TEST_SECRET above.
  process.env.VISITOR_SECRET ??= "wp19-tenancy-visitor-secret-00000000";
  (await import("@/server/env")).resetEnvCache();

  const m: Modules = {
    identity: await import("@/server/identity"),
    appHttp: await import("@/server/identity/app-http"),
    appOrgs: await import("@/server/identity/app-orgs"),
    appMembers: await import("@/server/identity/app-members"),
    appInvitations: await import("@/server/identity/app-invitations"),
    appAudit: await import("@/server/identity/app-audit"),
    appClaim: await import("@/server/identity/app-claim"),
    billingRoutes: await import("@/server/billing/routes"),
    connectorRoutes: await import("@/server/connectors/routes"),
    audit: await import("@/server/audit"),
    events: await import("@/server/events"),
    usageWriter: await import("@/server/saas/usage-writer"),
    ports: await import("@/server/saas/ports"),
    routes: await import("@/server/identity/routes"),
    visitor: await import("@/server/auth/visitor"),
    schemaAuth: await import("@/server/db/schema-auth"),
    schemaSaas: await import("@/server/db/schema-saas"),
    schema: await import("@/server/db/schema"),
    drizzle: await import("drizzle-orm"),
    db: await import("@/server/db/client"),
  };

  const auth = m.identity.getAuth();
  if (!auth) throw new Error("the identity layer should be configured in the tenancy suite");
  // Registers the session principal AND the database writers (`installWriters`), which is the point: this suite
  // asserts on real `audit_log`, `domain_events` and `usage_events` rows.
  m.identity.installIdentity();

  const aOwner = await makeUser(m, auth, t, "a-owner", "", "owner", {
    createsOrg: { name: "Org A", slug: "org-a" },
  });
  const orgA = aOwner.orgId;
  const bOwner = await makeUser(m, auth, t, "b-owner", "", "owner", {
    createsOrg: { name: "Org B", slug: "org-b" },
  });
  const orgB = bOwner.orgId;

  const aAdmin = await makeUser(m, auth, t, "a-admin", orgA, "admin");
  const aMember = await makeUser(m, auth, t, "a-member", orgA, "member");
  const aViewer = await makeUser(m, auth, t, "a-viewer", orgA, "viewer");

  // A is on Pro (10 seats) and B stays on Free (3). §10.1's fixture list says nothing about plans, but A has the
  // four members the suite needs and Free has three seats — so without this, every invitation in A would fail
  // the §4.1 seat check and the tenancy assertions would be testing the plan limit instead of tenancy. B is the
  // org the seat limit itself is proved against.
  {
    const { eq } = m.drizzle;
    await t.db
      .update(m.schemaSaas.orgEntitlements)
      .set({ plan: "pro" })
      .where(eq(m.schemaSaas.orgEntitlements.orgId, orgA));
  }

  // The guest: the real §3.3 path, so the org, its membership and its plan are the real ones.
  const guestVisitorId = m.visitor.newVisitorId();
  const gRes = await m.routes.guestStart(
    deviceReq(m, guestVisitorId, { headers: { "x-real-ip": "198.51.100.44" } }),
  );
  const gBody = (await gRes.json()) as { orgId: string };
  const guestToken = sessionCookieOf(gRes.headers.getSetCookie());
  const { eq } = m.drizzle;
  const [gMember] = await t.db
    .select({ userId: m.schemaAuth.members.userId })
    .from(m.schemaAuth.members)
    .where(eq(m.schemaAuth.members.organizationId, gBody.orgId))
    .limit(1);

  const guest: Who = {
    label: "guest",
    userId: gMember?.userId ?? "",
    email: "",
    cookie: `${guestToken}; ${deviceCookie(m, guestVisitorId)}`,
    visitorId: guestVisitorId,
    orgId: gBody.orgId,
  };

  return {
    t, m, orgA, orgB, aOwner, aAdmin, aMember, aViewer, bOwner, guest,
    strangerVisitorId: m.visitor.newVisitorId(),
    ids: {},
  };
}
