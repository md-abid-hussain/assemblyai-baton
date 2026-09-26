/**
 * WP16·3 acceptance (TASKS-v3 §7 WP16): the connector host policy (SAAS §5.6).
 *
 *  1. a host outside the policy → `blocked`, with NO DNS lookup (the resolver is never called);
 *  2. an org host on Pro → the call goes through;
 *  3. the same org host after a downgrade to Free → `blocked`, and the message names the plan;
 *  4. the T2 SSRF suite still applies to org hosts: an allowed host that resolves to a private address is refused
 *     with `E_CONN_ADDRESS`, and the address guard runs after the allowlist, never instead of it;
 *  5. the built-in echo (our own `APP_URL` host) stays reachable on every plan;
 *  6. `normalizeConnectorHost` refuses wildcards, IP literals, `localhost`, single labels and our own origin.
 *
 * Everything runs against 127.0.0.1 through the injected transport and a table resolver: no network, $0.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkConnectorHost, installConnectorHostPolicy, normalizeConnectorHost, OrgConnectorHostPolicy, setOrgHostStore,
  type OrgHostStore,
} from "@/server/connectors/host-policy";
import { resetConnectorPortsInstall } from "@/server/connectors/install";
import { executeHttpAction, type HttpActionInput } from "@/server/connectors/http";
import { destinationPolicy } from "@/server/connectors/destination";
import { SaasError } from "@/server/saas/errors";
import { resetSaasPorts, setPlanResolver } from "@/server/saas/ports";
import type { PlanId } from "@/core/contracts/v3/identity";

import { localTransport, PUBLIC_V4, startServer, tableResolver, type CapturedCall, type LocalServer } from "./helpers";

const ORG = "org_acme";
const OWN_HOST = "changeover.app";
const ENV_HOST = "postman-echo.com";
const ORG_HOST = "hooks.acme-dental.com";

/** An in-memory `org_meta.connector_hosts`. */
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

const input = (url: string): HttpActionInput => ({
  url,
  method: "POST",
  toolName: "notify_desk",
  args: { note: "hello" },
  run: { relay: "dental-deposit", version: 3, case: null, mode: "console" },
  headers: [],
  hmac: null,
  timeoutMs: 2000,
  responsePick: ["ok"],
});

describe("normalizeConnectorHost (SAAS §5.6 rules)", () => {
  const code = (raw: string): string | null => {
    try {
      normalizeConnectorHost(raw, `https://${OWN_HOST}`);
      return null;
    } catch (e) {
      return e instanceof SaasError ? e.code : `not a SaasError: ${String(e)}`;
    }
  };

  it.each([
    ["*.acme.com", "a wildcard"],
    ["203.0.113.9", "an IPv4 literal"],
    ["[2001:db8::1]", "an IPv6 literal"],
    ["localhost", "localhost"],
    ["intranet", "a single label"],
    ["api.acme.com:8443", "a port"],
    ["api.acme.com/hook?x=1", "a path"],
    [OWN_HOST, "our own origin"],
    [`api.${OWN_HOST}`, "a sub-domain of our own origin"],
    ["", "an empty string"],
  ])("refuses %s (%s)", (raw) => {
    expect(code(raw)).toBe("E_VALIDATION");
  });

  it("accepts a plain host name, and normalises case, a scheme, a path and a trailing dot", () => {
    expect(normalizeConnectorHost("HOOKS.Acme-Dental.com.", `https://${OWN_HOST}`)).toBe(ORG_HOST);
    expect(normalizeConnectorHost("https://hooks.acme-dental.com/relay/hook", `https://${OWN_HOST}`)).toBe(ORG_HOST);
  });
});

describe("the policy decides before DNS (SAAS §5.6, §10.3)", () => {
  let server: LocalServer;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ["APP_ENV", "NODE_ENV", "CONNECTOR_HOST_ALLOWLIST", "APP_URL"]) saved[k] = process.env[k];
    // The public deployment: the allowlist is ENFORCED.
    process.env.APP_ENV = "production";
    process.env.CONNECTOR_HOST_ALLOWLIST = ENV_HOST;
    process.env.APP_URL = `https://${OWN_HOST}`;
    resetSaasPorts();
    resetConnectorPortsInstall();
    setOrgHostStore(memoryHostStore({ [ORG]: [ORG_HOST] }));
    installConnectorHostPolicy();
    server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  afterEach(async () => {
    await server.close();
    setOrgHostStore(null);
    resetSaasPorts();
    resetConnectorPortsInstall();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const plan = (p: PlanId) => setPlanResolver(() => p);

  const call = async (host: string, table: Record<string, { v4?: string[]; v6?: string[] }> = { [host]: { v4: [PUBLIC_V4] } }) => {
    const calls: CapturedCall[] = [];
    const resolver = tableResolver(table);
    const report = await executeHttpAction(input(`https://${host}/hook`), {
      policy: destinationPolicy(),
      checkHost: (h) => checkConnectorHost(ORG, h),
      resolver,
      request: localTransport(server.port, calls),
    });
    return { report, resolver, calls };
  };

  it("1. a host outside the policy is blocked, and nothing is resolved or dialled", async () => {
    plan("pro");
    const { report, resolver, calls } = await call("evil.example.com");
    expect(report.status).toBe("blocked");
    expect(report.errorCode).toBe("E_CONN_HOST_NOT_ALLOWED");
    expect(report.agentResult).toEqual({ status: "failed", reason: "destination_not_allowed" });
    expect(resolver.calls).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(report.address).toBeNull();
  });

  it("2. an org host on Pro goes through", async () => {
    plan("pro");
    const { report, calls } = await call(ORG_HOST);
    expect(report.status).toBe("ok");
    expect(report.agentResult).toEqual({ data: { ok: true }, http_status: 200 });
    expect(calls[0]!.options.servername).toBe(ORG_HOST);
    expect(calls[0]!.pinned.plain[0]).toBe(PUBLIC_V4);
  });

  it("3. the same host after a downgrade to Free is blocked, and the message names the plan", async () => {
    plan("free");
    const { report, resolver } = await call(ORG_HOST);
    expect(report.status).toBe("blocked");
    expect(report.errorCode).toBe("E_CONN_HOST_NOT_ALLOWED");
    expect(report.message).toMatch(/plan does not include custom connector hosts/i);
    expect(report.message).toMatch(/Upgrade to Pro/i);
    expect(resolver.calls).toEqual([]);
  });

  it("4. the SSRF guard still runs for an allowed org host (a private answer is refused)", async () => {
    plan("pro");
    const { report, resolver, calls } = await call(ORG_HOST, { [ORG_HOST]: { v4: ["10.0.0.5"] } });
    expect(report.status).toBe("blocked");
    expect(report.errorCode).toBe("E_CONN_ADDRESS");
    // The allowlist passed, so DNS DID run — and then refused the answer.
    expect(resolver.calls.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  });

  it("5. the deployment allowlist and the built-in echo host work on every plan", async () => {
    plan("guest");
    expect((await call(ENV_HOST)).report.status).toBe("ok");
    expect((await call(OWN_HOST)).report.status).toBe("ok");
  });

  it("6. `list` shows the org's hosts only while the plan includes them", async () => {
    const policy = new OrgConnectorHostPolicy();
    plan("pro");
    expect(await policy.list(ORG)).toEqual([ENV_HOST, ORG_HOST, OWN_HOST].sort());
    expect(await policy.isAllowed(ORG, ORG_HOST)).toBe(true);
    plan("free");
    expect(await policy.list(ORG)).toEqual([ENV_HOST, OWN_HOST].sort());
    expect(await policy.isAllowed(ORG, ORG_HOST)).toBe(false);
  });

  it("another org's host is never allowed here", async () => {
    plan("pro");
    const policy = new OrgConnectorHostPolicy();
    expect(await policy.isAllowed("org_other", ORG_HOST)).toBe(false);
  });
});

describe("a development build keeps reaching any public host (no allowlist)", () => {
  const saved = { APP_ENV: process.env.APP_ENV, LIST: process.env.CONNECTOR_HOST_ALLOWLIST };

  beforeEach(() => {
    process.env.APP_ENV = "development";
    delete process.env.CONNECTOR_HOST_ALLOWLIST;
    resetSaasPorts();
    resetConnectorPortsInstall();
    setOrgHostStore(memoryHostStore());
    installConnectorHostPolicy();
  });

  afterEach(() => {
    setOrgHostStore(null);
    resetSaasPorts();
    resetConnectorPortsInstall();
    if (saved.APP_ENV === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = saved.APP_ENV;
    if (saved.LIST !== undefined) process.env.CONNECTOR_HOST_ALLOWLIST = saved.LIST;
  });

  it("allows an unlisted public host off the allowlist, for any org", async () => {
    expect(await checkConnectorHost(ORG, "api.example.com")).toEqual({ ok: true });
  });
});
