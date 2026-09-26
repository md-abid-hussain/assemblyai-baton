/**
 * WP16·3: secrets per org and the two route families they need.
 *
 * - the plan decides the count and the TTL (SAAS §4.1): Guest 3 / 7 days, Pro 50 / never — the store keeps the v2
 *   constants only when no plan is wired;
 * - `GET|POST /api/secrets` and `DELETE /api/secrets/:id`: names only, `secret:write` for the mutations, the plan
 *   count as a 402, `SecretError` as 400 / 429, an audit row per mutation, and never a value in a response;
 * - `GET|POST|DELETE /api/app/connector-hosts`: Pro+ only, the §5.6 validation, the public-DNS check at add time,
 *   the plan count, and `connector.host_added` / `connector.host_removed`;
 * - the `SecretRebinder`: a claimed device workspace keeps its secret ids and its values (real Postgres).
 *
 * No network: a table resolver for the host check, memory stores for everything else.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Principal } from "@/core/contracts/v3/identity";
import type { Permission } from "@/core/contracts/v3/permissions";
import { setOrgHostStore, setHostCheckResolver, type OrgHostStore } from "@/server/connectors/host-policy";
import { resetConnectorPortsInstall } from "@/server/connectors/install";
import { addConnectorHost, listConnectorHosts, removeConnectorHost } from "@/server/connectors/routes";
import { setRateLimiter } from "@/server/limits";
import { SaasError } from "@/server/saas/errors";
import {
  createMemoryAuditWriter, resetSaasPorts, setAuditWriter, setPlanResolver, type MemoryAuditWriter,
} from "@/server/saas/ports";
import { secretKeyringFromEnv } from "@/server/secrets/crypto";
import { secretPlanLimits } from "@/server/secrets/plan";
import { ConnectorSecretRebinder } from "@/server/secrets/rebind";
import { MemorySecretRepo, PgSecretRepo } from "@/server/secrets/repo";
import { deleteSecret, listSecrets, putSecret } from "@/server/secrets/routes";
import { ConnectorSecretStore, MAX_SECRETS_PER_WORKSPACE, SECRET_TTL_MS } from "@/server/secrets/store";
import { setSecretStore } from "@/server/secrets";
import { memoryRateLimiter } from "@/server/tools/wiring";
import { setPrincipalResolver } from "@/server/saas/ports";
import { tableResolver, PUBLIC_V4 } from "../connectors/helpers";
import { createTestDb, HAS_DB, type TestDb } from "../cases/helpers/test-db";

const IKM = "agent-tool-secret-for-unit-tests-only-0123456789";
const ring = () => secretKeyringFromEnv({ AGENT_TOOL_SECRET: IKM });
const ORG = "org_acme";
const DAY = 24 * 60 * 60 * 1000;

const principal = (over: Partial<Principal> = {}): Principal => ({
  kind: "session", userId: "usr_1", isAnonymous: false, orgId: ORG, orgKind: "team", role: "owner", scopes: [],
  apiKeyId: null, plan: "pro", visitorId: "vid_1", ipKey: "ip_1", requestId: "req_1", ...over,
});

/** A resolver that grants only the listed permissions, and refuses the rest exactly as `applyNeed` would. */
function stubPrincipal(p: Principal, allowed: readonly Permission[] | "all" = "all"): void {
  setPrincipalResolver({
    async resolve(_req, need) {
      if (need?.perm && allowed !== "all" && !allowed.includes(need.perm)) {
        throw new SaasError("E_FORBIDDEN", `Your role does not allow ${need.perm}.`);
      }
      return p;
    },
  });
}

function memoryHostStore(initial: Record<string, string[]> = {}): OrgHostStore {
  const rows = new Map<string, string[]>(Object.entries(initial));
  return {
    async list(orgId) {
      return [...(rows.get(orgId) ?? [])];
    },
    async add(orgId, host) {
      const next = [...new Set([...(rows.get(orgId) ?? []), host])].sort();
      rows.set(orgId, next);
      return next;
    },
    async remove(orgId, host) {
      const next = (rows.get(orgId) ?? []).filter((h) => h !== host);
      rows.set(orgId, next);
      return next;
    },
  };
}

const req = (method: string, url: string, body?: unknown): Request =>
  new Request(`http://localhost${url}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });

// ------------------------------------------------------------------------------------------ plan limits

describe("the plan decides the secret count and the TTL (SAAS §4.1)", () => {
  beforeEach(() => resetSaasPorts());
  afterEach(() => resetSaasPorts());

  const storeFor = (t: number) =>
    new ConnectorSecretStore({ repo: new MemorySecretRepo(), keyring: ring, clock: () => t, plan: secretPlanLimits });

  it("Guest: 3 secrets that expire in 7 days", async () => {
    setPlanResolver(() => "guest");
    const t = Date.parse("2026-09-26T10:00:00Z");
    const s = storeFor(t);
    const first = await s.put(ORG, "a", "v");
    expect(Date.parse(first.expiresAt) - t).toBe(7 * DAY);
    await s.put(ORG, "b", "v");
    await s.put(ORG, "c", "v");
    await expect(s.put(ORG, "d", "v")).rejects.toMatchObject({ code: "E_SECRET_LIMIT" });
    // Replacing a name never needs a free slot.
    await expect(s.put(ORG, "a", "v2")).resolves.toMatchObject({ id: first.id });
  });

  it("Pro: 50 secrets that do not expire", async () => {
    setPlanResolver(() => "pro");
    const t = Date.parse("2026-09-26T10:00:00Z");
    const meta = await storeFor(t).put(ORG, "a", "v");
    expect(Date.parse(meta.expiresAt) - t).toBeGreaterThan(365 * DAY);
  });

  it("without a plan the v2 constants still apply (10 / 7 days)", async () => {
    const t = Date.parse("2026-09-26T10:00:00Z");
    const s = new ConnectorSecretStore({ repo: new MemorySecretRepo(), keyring: ring, clock: () => t });
    for (let i = 0; i < MAX_SECRETS_PER_WORKSPACE; i++) await s.put(ORG, `k${i}`, "v");
    await expect(s.put(ORG, "one_more", "v")).rejects.toMatchObject({ code: "E_SECRET_LIMIT" });
    expect(Date.parse((await s.list(ORG))[0]!.expiresAt) - t).toBe(SECRET_TTL_MS);
  });
});

// ------------------------------------------------------------------------------------------ /api/secrets

describe("/api/secrets", () => {
  let audit: MemoryAuditWriter;
  let store: ConnectorSecretStore;

  beforeEach(() => {
    resetSaasPorts();
    resetConnectorPortsInstall();
    audit = createMemoryAuditWriter();
    setAuditWriter(audit);
    setRateLimiter(memoryRateLimiter);
    setPlanResolver(() => "guest"); // 3 secrets: the plan limit is reachable in a test
    store = new ConnectorSecretStore({ repo: new MemorySecretRepo(), keyring: ring, plan: secretPlanLimits });
    setSecretStore(store);
    stubPrincipal(principal({ plan: "guest" }));
  });

  afterEach(() => {
    setSecretStore(null);
    setRateLimiter(null);
    resetSaasPorts();
    resetConnectorPortsInstall();
  });

  it("puts, lists and deletes — and never returns a value", async () => {
    const created = await putSecret(req("POST", "/api/secrets", { name: "desk_token", value: "t0p-s3cret-value" }), ctx({}));
    expect(created.status).toBe(201);
    const meta = (await created.json()) as { id: string; name: string; expiresAt: string };
    expect(meta.id).toMatch(/^sec_[a-z0-9]{16}$/);
    expect(JSON.stringify(meta)).not.toContain("t0p-s3cret-value");

    const listed = await listSecrets(req("GET", "/api/secrets"), ctx({}));
    const body = (await listed.json()) as { secrets: { id: string; name: string }[] };
    expect(body.secrets).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("t0p-s3cret-value");

    const again = await putSecret(req("POST", "/api/secrets", { name: "desk_token", value: "rotated-value" }), ctx({}));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: string }).id).toBe(meta.id); // the blueprint ref stays valid

    const gone = await deleteSecret(req("DELETE", `/api/secrets/${meta.id}`), ctx({ id: meta.id }));
    expect(gone.status).toBe(204);
    expect(((await (await listSecrets(req("GET", "/api/secrets"), ctx({}))).json()) as { secrets: unknown[] }).secrets).toHaveLength(0);

    expect(audit.entries.map((e) => e.action)).toEqual(["secret.created", "secret.created", "secret.deleted"]);
    expect(JSON.stringify(audit.entries)).not.toContain("t0p-s3cret-value");
  });

  it("refuses a principal without `secret:write`, and lets a reader list", async () => {
    stubPrincipal(principal({ role: "member" }), ["secret:read"]);
    const res = await putSecret(req("POST", "/api/secrets", { name: "a", value: "v" }), ctx({}));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("E_FORBIDDEN");
    expect((await listSecrets(req("GET", "/api/secrets"), ctx({}))).status).toBe(200);
  });

  it("answers 402 with the upgrade line once the plan's count is used up", async () => {
    for (const n of ["a", "b", "c"]) {
      expect((await putSecret(req("POST", "/api/secrets", { name: n, value: "v" }), ctx({}))).status).toBe(201);
    }
    const res = await putSecret(req("POST", "/api/secrets", { name: "d", value: "v" }), ctx({}));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string }; limit?: { key: string; limit: number } };
    expect(body.error.code).toBe("E_PLAN_LIMIT");
    expect(body.limit).toMatchObject({ key: "secrets", limit: 3 });
  });

  it("maps a bad name or an oversized value to 400 (`SecretError`)", async () => {
    const bad = await putSecret(req("POST", "/api/secrets", { name: "not a name!", value: "v" }), ctx({}));
    expect(bad.status).toBe(400);
    const big = await putSecret(req("POST", "/api/secrets", { name: "big", value: "x".repeat(2000) }), ctx({}));
    expect(big.status).toBe(400);
    expect(((await big.json()) as { error: { code: string } }).error.code).toBe("E_BAD_REQUEST");
  });

  it("never touches another workspace's secret", async () => {
    const mine = (await (await putSecret(req("POST", "/api/secrets", { name: "k", value: "v" }), ctx({}))).json()) as { id: string };
    stubPrincipal(principal({ orgId: "org_other" }));
    expect((await deleteSecret(req("DELETE", `/api/secrets/${mine.id}`), ctx({ id: mine.id }))).status).toBe(204);
    stubPrincipal(principal());
    const still = (await (await listSecrets(req("GET", "/api/secrets"), ctx({}))).json()) as { secrets: unknown[] };
    expect(still.secrets).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------- /api/app/connector-hosts

describe("/api/app/connector-hosts", () => {
  let audit: MemoryAuditWriter;
  const HOST = "hooks.acme-dental.com";

  beforeEach(() => {
    resetSaasPorts();
    resetConnectorPortsInstall();
    audit = createMemoryAuditWriter();
    setAuditWriter(audit);
    setRateLimiter(memoryRateLimiter);
    setOrgHostStore(memoryHostStore());
    setHostCheckResolver(() => tableResolver({ [HOST]: { v4: [PUBLIC_V4] }, "private.acme.com": { v4: ["10.1.2.3"] } }));
    setPlanResolver(() => "pro");
    stubPrincipal(principal());
  });

  afterEach(() => {
    setOrgHostStore(null);
    setHostCheckResolver(null);
    setRateLimiter(null);
    resetSaasPorts();
    resetConnectorPortsInstall();
  });

  it("adds, lists and removes a host, with an audit row for each mutation", async () => {
    const added = await addConnectorHost(req("POST", "/api/app/connector-hosts", { host: `HTTPS://${HOST}/hook` }), ctx({}));
    expect(added.status).toBe(201);
    expect((await added.json()) as { hosts: string[] }).toEqual({ hosts: [HOST], limit: 10, enabled: true });

    const listed = (await (await listConnectorHosts(req("GET", "/api/app/connector-hosts"), ctx({}))).json()) as {
      hosts: string[]; limit: number; enabled: boolean;
    };
    expect(listed).toMatchObject({ hosts: [HOST], limit: 10, enabled: true });

    const removed = await removeConnectorHost(req("DELETE", `/api/app/connector-hosts?host=${HOST}`), ctx({}));
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { hosts: string[] }).hosts).toEqual([]);
    expect(audit.entries.map((e) => e.action)).toEqual(["connector.host_added", "connector.host_removed"]);
    expect(audit.entries[0]!.metadata).toMatchObject({ host: HOST });
  });

  it("is a Pro feature: Free gets 402 and sees the list disabled", async () => {
    setPlanResolver(() => "free");
    const res = await addConnectorHost(req("POST", "/api/app/connector-hosts", { host: HOST }), ctx({}));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("E_PLAN_LIMIT");
    expect(body.error.message).toMatch(/Pro/);
    const listed = (await (await listConnectorHosts(req("GET", "/api/app/connector-hosts"), ctx({}))).json()) as { enabled: boolean };
    expect(listed.enabled).toBe(false);
  });

  it("refuses a wildcard, an IP literal and a host that resolves to a private address", async () => {
    for (const host of ["*.acme.com", "203.0.113.9"]) {
      const res = await addConnectorHost(req("POST", "/api/app/connector-hosts", { host }), ctx({}));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("E_VALIDATION");
    }
    const priv = await addConnectorHost(req("POST", "/api/app/connector-hosts", { host: "private.acme.com" }), ctx({}));
    expect(priv.status).toBe(400);
    expect(((await priv.json()) as { error: { message: string } }).error.message).toMatch(/private address/);
    expect(audit.entries).toHaveLength(0);
  });

  it("refuses a member (`secret:write` is admin+) and counts against the plan limit", async () => {
    stubPrincipal(principal({ role: "member" }), ["secret:read"]);
    expect((await addConnectorHost(req("POST", "/api/app/connector-hosts", { host: HOST }), ctx({}))).status).toBe(403);

    stubPrincipal(principal());
    setOrgHostStore(memoryHostStore({ [ORG]: Array.from({ length: 10 }, (_, i) => `h${i}.acme.com`) }));
    const res = await addConnectorHost(req("POST", "/api/app/connector-hosts", { host: HOST }), ctx({}));
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("E_PLAN_LIMIT");
  });
});

// ------------------------------------------------------------------------------------------ the rebinder

describe.skipIf(!HAS_DB)("SecretRebinder (SAAS §2.6 step 4)", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb("wp16rebind");
  });
  afterEach(async () => {
    await t?.drop();
  });

  it("re-seals a claimed workspace's secrets under the new AAD, keeping the ids", async () => {
    const repo = new PgSecretRepo(t.pool);
    const store = new ConnectorSecretStore({ repo, keyring: ring });
    const ws = "ws_vid_abc";
    const org = "org_claimed";
    const a = await store.put(ws, "desk_token", "value-a");
    const b = await store.put(ws, "hmac", "value-b");

    const moved = await new ConnectorSecretRebinder({ db: () => t.db, keyring: ring }).rebind(ws, org);
    expect(moved).toBe(2);

    // Same ids, same values, now in the org — and nothing left in the device workspace.
    expect(await store.resolve(org, { $secret: a.id })).toBe("value-a");
    expect(await store.resolve(org, { $secret: b.id })).toBe("value-b");
    await expect(store.resolve(ws, { $secret: a.id })).rejects.toMatchObject({ code: "E_CONN_SECRET_MISSING" });
    expect((await store.list(org)).map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("leaves a name the org already uses alone (the org's own secret wins)", async () => {
    const store = new ConnectorSecretStore({ repo: new PgSecretRepo(t.pool), keyring: ring });
    const ws = "ws_vid_def";
    const org = "org_has_one";
    await store.put(ws, "desk_token", "from-the-device");
    await store.put(org, "desk_token", "already-in-the-org");

    const moved = await new ConnectorSecretRebinder({ db: () => t.db, keyring: ring }).rebind(ws, org);
    expect(moved).toBe(0);
    const [mine] = await store.list(org);
    expect(await store.resolve(org, { $secret: mine!.id })).toBe("already-in-the-org");
  });

  it("is a no-op for an empty workspace and for a self-rebind", async () => {
    const r = new ConnectorSecretRebinder({ db: () => t.db, keyring: ring });
    expect(await r.rebind("ws_empty", "org_x")).toBe(0);
    expect(await r.rebind("org_x", "org_x")).toBe(0);
  });
});
