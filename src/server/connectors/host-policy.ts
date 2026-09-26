import "server-only";

/**
 * `ConnectorHostPolicy` (SAAS §5.6, §10.3; WP16·3). Which hosts an org's `http_action` connectors may reach.
 *
 *   allowed = the deployment allowlist  ∪  (the org's own hosts, on a plan whose `connectorHosts` limit is > 0)
 *
 * - **The deployment allowlist** is WP16·1's `destinationPolicy()`: `CONNECTOR_HOST_ALLOWLIST` (or the §6.2
 *   defaults) plus our own `APP_URL` host for the built-in echo, ENFORCED only on the public deployment. A dev or
 *   test build reaches any public host, exactly as before — this unit adds hosts, it never takes any away.
 * - **The org's hosts** live in `org_meta.connector_hosts` (WP19's `0002_saas`). They are exact lowercase host
 *   names: no wildcards, no IP literals, never our own origin, and each one must resolve to public unicast
 *   addresses when it is added. A downgrade does not delete them; it stops them being allowed, and the refusal
 *   says so, so an upgrade brings the same relays back to life.
 *
 * The SSRF guard is untouched and unconditional: being on this list only gets a host past the allowlist gate. The
 * address checks, the pinned DNS, the redirect and encoding refusals and the byte caps still run for every call
 * (`http.ts`), which is why an org host cannot be pointed at 169.254.169.254 to read cloud metadata.
 */
import { eq, sql } from "drizzle-orm";

import type { ConnectorHostPolicy } from "../../core/contracts/v3/services";
import { getDb, type Db } from "../db/client";
import { orgMeta } from "../db/schema-saas";
import { log } from "../log";
import { SaasError } from "../saas/errors";
import { getConnectorHostPolicy, getEntitlements, setConnectorHostPolicy, setOrgCounter } from "../saas/ports";
import { isIpLiteral } from "./address";
import { destinationPolicy, isHostAllowed, MAX_HOST_LENGTH } from "./destination";
import { createConnectorResolver, resolvePublic, type ConnectorResolver } from "./dns";

const hostLog = log.child({ component: "connector-hosts" });

/** A host name we accept in the org list: labels of letters/digits/hyphen, at least two of them, ≤ 253 chars. */
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// ------------------------------------------------------------------------------------------ validation (§5.6)

/**
 * Normalise and check one host the owner typed. Throws `SaasError("E_VALIDATION")` with a message that says what to
 * do instead — never a bare "invalid". Accepts `https://api.acme.com/hook` and keeps the host only.
 */
export function normalizeConnectorHost(raw: string, appUrl: string | undefined = process.env.APP_URL): string {
  let h = (raw ?? "").trim().toLowerCase();
  if (h === "") throw new SaasError("E_VALIDATION", "Enter a host name, for example api.your-company.com.");
  if (h.includes("://")) {
    try {
      h = new URL(h).hostname.toLowerCase();
    } catch {
      throw new SaasError("E_VALIDATION", "That does not look like a host name. Use the host only, e.g. api.your-company.com.");
    }
  }
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.includes("*")) {
    throw new SaasError("E_VALIDATION", "Wildcards are not allowed. Add each host name on its own, e.g. api.your-company.com.");
  }
  if (h.includes("/") || h.includes("@") || h.includes(":") || h.includes(" ")) {
    throw new SaasError("E_VALIDATION", "Enter the host name only — no scheme, port, path or credentials.");
  }
  if (h.length > MAX_HOST_LENGTH) throw new SaasError("E_VALIDATION", `A host name is at most ${MAX_HOST_LENGTH} characters.`);
  if (isIpLiteral(h)) {
    throw new SaasError("E_VALIDATION", "IP addresses are not allowed. Add the host name that points at your endpoint.");
  }
  if (h === "localhost" || h.endsWith(".localhost") || !h.includes(".")) {
    throw new SaasError("E_VALIDATION", `"${h}" is not a public host name.`);
  }
  if (!HOST_RE.test(h)) throw new SaasError("E_VALIDATION", "That does not look like a host name. Use letters, digits, hyphens and dots.");
  const own = ownHost(appUrl);
  if (own && (h === own || h.endsWith(`.${own}`))) {
    throw new SaasError("E_VALIDATION", "This app's own address is already reachable through the built-in echo; it cannot be added as your host.");
  }
  return h;
}

function ownHost(appUrl: string | undefined): string | null {
  const raw = appUrl?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * §5.6: "a host must resolve to public unicast addresses when it is added". The same resolver the runtime uses, so
 * a host that passes here is one the runtime can actually reach — and one that resolves to a private address is
 * refused at add time rather than silently failing on the first call.
 */
let resolverFactory: () => ConnectorResolver = createConnectorResolver;

/** Tests inject a resolver here, exactly as the SSRF suite does for the runtime. `null` restores c-ares. */
export const setHostCheckResolver = (f: (() => ConnectorResolver) | null): void => void (resolverFactory = f ?? createConnectorResolver);

export async function assertHostResolvesPublic(host: string, resolver?: ConnectorResolver): Promise<string[]> {
  try {
    const r = await resolvePublic(host, resolver ?? resolverFactory());
    return r.all;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "E_CONN_ADDRESS") {
      throw new SaasError("E_VALIDATION", `${host} resolves to a private address, so it cannot be added.`);
    }
    throw new SaasError("E_VALIDATION", `${host} could not be resolved. Check the spelling and that it is public in DNS.`);
  }
}

// ------------------------------------------------------------------------------------------ the org's list

/** Does this org's plan include per-org allowed hosts at all (Pro and Business; SAAS §4.1)? */
export async function orgHostLimit(orgId: string): Promise<number> {
  try {
    const view = await getEntitlements().get(orgId);
    return view.limits.connectorHosts;
  } catch (err) {
    hostLog.warn("could not read the plan for connector hosts (treated as 0)", { orgId, err });
    return 0;
  }
}

/**
 * Where the org's hosts live. One port with the Postgres implementation below, so the policy, the routes and the
 * tests all go through the same three calls and a test needs no database (the WP14b/WP19 deps pattern).
 */
export interface OrgHostStore {
  list(orgId: string): Promise<string[]>;
  add(orgId: string, host: string): Promise<string[]>;
  remove(orgId: string, host: string): Promise<string[]>;
}

const pgOrgHostStore: OrgHostStore = {
  list: (orgId) => orgConnectorHosts(orgId),
  add: (orgId, host) => putOrgConnectorHost(orgId, host),
  remove: (orgId, host) => removeOrgConnectorHost(orgId, host),
};

let hostStore: OrgHostStore | null = null;

/** Tests register an in-memory store; `null` restores `org_meta`. */
export const setOrgHostStore = (s: OrgHostStore | null): void => void (hostStore = s);
export const getOrgHostStore = (): OrgHostStore => hostStore ?? pgOrgHostStore;

/** The raw `org_meta.connector_hosts` rows — the plan is NOT applied here (the settings page shows them anyway). */
export async function orgConnectorHosts(orgId: string, db: Db = getDb()): Promise<string[]> {
  if (!orgId || orgId.startsWith("ws_")) return []; // a legacy device workspace has no org_meta row
  try {
    const [row] = await db.select({ hosts: orgMeta.connectorHosts }).from(orgMeta).where(eq(orgMeta.orgId, orgId));
    return (row?.hosts ?? []).map((h) => h.toLowerCase());
  } catch (err) {
    // Before `0002_saas`, or on a deployment without the table: the deployment allowlist is the whole policy.
    hostLog.warn("could not read org_meta.connector_hosts (treated as empty)", { orgId, err });
    return [];
  }
}

/** Add one host. Validation, the plan limit and the DNS check have already run in the route. */
export async function putOrgConnectorHost(orgId: string, host: string, db: Db = getDb()): Promise<string[]> {
  const [row] = await db
    .update(orgMeta)
    .set({ connectorHosts: sql`(select array_agg(distinct h) from unnest(array_append(${orgMeta.connectorHosts}, ${host}::text)) as h)` })
    .where(eq(orgMeta.orgId, orgId))
    .returning({ hosts: orgMeta.connectorHosts });
  if (!row) throw new SaasError("E_NOT_FOUND", "This workspace no longer exists.");
  return (row.hosts ?? []).map((h) => h.toLowerCase()).sort();
}

/** Remove one host. Removing a host that is not there is not an error (the end state is what was asked for). */
export async function removeOrgConnectorHost(orgId: string, host: string, db: Db = getDb()): Promise<string[]> {
  const [row] = await db
    .update(orgMeta)
    .set({ connectorHosts: sql`array_remove(${orgMeta.connectorHosts}, ${host}::text)` })
    .where(eq(orgMeta.orgId, orgId))
    .returning({ hosts: orgMeta.connectorHosts });
  if (!row) throw new SaasError("E_NOT_FOUND", "This workspace no longer exists.");
  return (row.hosts ?? []).map((h) => h.toLowerCase()).sort();
}

// ------------------------------------------------------------------------------------------ the port

export type HostVerdict =
  | { ok: true }
  | { ok: false; reason: "not_listed" | "plan"; message: string };

export class OrgConnectorHostPolicy implements ConnectorHostPolicy {
  constructor(private readonly deps: { store?: OrgHostStore } = {}) {}

  private get store(): OrgHostStore {
    return this.deps.store ?? getOrgHostStore();
  }

  async isAllowed(orgId: string, host: string): Promise<boolean> {
    return (await this.check(orgId, host)).ok;
  }

  /** The deployment allowlist first (it is the same for everyone), then the org's own hosts on a plan that has them. */
  async check(orgId: string, host: string): Promise<HostVerdict> {
    const h = (host ?? "").trim().toLowerCase();
    const env = destinationPolicy();
    if (isHostAllowed(h, env)) return { ok: true };

    const listed = orgId ? await this.store.list(orgId) : [];
    const limit = listed.length > 0 ? await orgHostLimit(orgId) : 0;
    if (listed.includes(h)) {
      if (limit > 0) return { ok: true };
      return {
        ok: false,
        reason: "plan",
        message: `${h} is one of this workspace's allowed hosts, but your current plan does not include custom connector hosts. Upgrade to Pro to call it again.`,
      };
    }
    return {
      ok: false,
      reason: "not_listed",
      message: env.enforceAllowlist
        ? `On this deployment, HTTP actions can reach these hosts only: ${[...env.hosts, ...(limit > 0 ? listed : [])].join(", ")}. Add ${h} under Settings → Connectors → Allowed hosts.`
        : `${h} is not one of this workspace's allowed hosts. Add it under Settings → Connectors → Allowed hosts.`,
    };
  }

  /** Everything this org may call today: the deployment allowlist plus its own hosts when the plan includes them. */
  async list(orgId: string): Promise<string[]> {
    const env = destinationPolicy();
    const mine = orgId ? await this.store.list(orgId) : [];
    const limit = mine.length > 0 ? await orgHostLimit(orgId) : 0;
    return [...new Set([...env.hosts, ...(limit > 0 ? mine : [])])].sort();
  }
}

/**
 * The check the connector runtime runs before any DNS lookup. It consults the REGISTERED port, so a test (or a
 * later WP) can swap the whole policy, and it explains a refusal when the registered policy is ours.
 */
export async function checkConnectorHost(orgId: string, host: string): Promise<{ ok: boolean; message?: string }> {
  const policy = getConnectorHostPolicy();
  if (policy instanceof OrgConnectorHostPolicy) {
    const v = await policy.check(orgId, host);
    return v.ok ? { ok: true } : { ok: false, message: v.message };
  }
  // A foreign policy (the C3 env default, or a test stub): the deployment allowlist still applies as before.
  if (isHostAllowed(host.trim().toLowerCase(), destinationPolicy())) return { ok: true };
  if (await policy.isAllowed(orgId, host)) return { ok: true };
  return { ok: false, message: `HTTP actions may not reach "${host}" from this workspace.` };
}

let installed = false;

/** Register the real policy and the `connectorHosts` plan counter (SAAS §4.1). Idempotent. */
export function installConnectorHostPolicy(): void {
  if (installed) return;
  installed = true;
  setConnectorHostPolicy(new OrgConnectorHostPolicy());
  setOrgCounter("connectorHosts", async (orgId) => (await getOrgHostStore().list(orgId)).length);
}

/** Tests re-install after `resetSaasPorts()`. */
export function resetConnectorHostPolicyInstall(): void {
  installed = false;
}
