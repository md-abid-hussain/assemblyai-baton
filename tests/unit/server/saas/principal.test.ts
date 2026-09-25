/**
 * WP19·1 acceptance: the **legacy** principal is exactly v2's `workspaceFor`, and the SAAS §2.3 `need` rules
 * (401 `E_AUTH_REQUIRED` with a `start` path, 403 `E_ACCOUNT_REQUIRED` / `E_FORBIDDEN` / `E_SCOPE`, and the §3.9
 * same-origin check for sessions only) hold.
 *
 * The point of the "legacy" half is that C3 changes **no v2 behaviour**: a device with a `bvid` cookie lands in
 * `ws_<visitorId>` as owner, and a cross-origin POST from that device is still allowed, exactly as in v2.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { workspaceOf } from "@/core/contracts/v2/api";
import type { Principal } from "@/core/contracts/v3/identity";
import { requireVisitor, signVisitorId, VISITOR_COOKIE, VISITOR_HEADER } from "@/server/auth/visitor";
import { isSaasError, SaasError } from "@/server/saas/errors";
import {
  applyNeed, legacyVisitorPrincipal, orglessVisitorPrincipal, requestIdOf, requirePrincipal, startPathFor,
  tenancyMode,
} from "@/server/saas/principal";
import { resetSaasPorts, setPrincipalResolver } from "@/server/saas/ports";
import { checkSameOrigin } from "@/server/saas/same-origin";

const VISITOR_SECRET = "wp19-test-visitor-secret-0123456789abcdef";
const APP_URL = "https://app.example.test";
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ["VISITOR_SECRET", "APP_URL", "TENANCY_MODE", "NODE_ENV"]) saved[k] = process.env[k];
  process.env.VISITOR_SECRET = VISITOR_SECRET;
  process.env.APP_URL = APP_URL;
  delete process.env.TENANCY_MODE;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(() => {
  resetSaasPorts();
  delete process.env.TENANCY_MODE;
});

const VID = "visitor-abc123";
const req = (init: { method?: string; url?: string; headers?: Record<string, string>; vid?: string | null } = {}): Request => {
  const headers = new Headers(init.headers);
  const vid = init.vid === null ? null : (init.vid ?? VID);
  if (vid) headers.set("cookie", `${VISITOR_COOKIE}=${encodeURIComponent(signVisitorId(vid, VISITOR_SECRET))}`);
  return new Request(init.url ?? `${APP_URL}/api/relays`, { method: init.method ?? "GET", headers });
};

const sessionPrincipal = (over: Partial<Principal> = {}): Principal => ({
  kind: "session", userId: "u1", isAnonymous: false, orgId: "org_1", orgKind: "team", role: "member",
  scopes: [], apiKeyId: null, plan: "free", visitorId: VID, ipKey: "ip", requestId: "r", ...over,
});

const caught = async (fn: () => unknown): Promise<SaasError> => {
  try {
    await fn();
  } catch (e) {
    if (isSaasError(e)) return e;
    throw e;
  }
  throw new Error("expected a SaasError");
};

describe("SAAS §2.3 the legacy visitor principal (v2 behaviour unchanged)", () => {
  it("is `ws_<visitorId>`, owner, guest — the same composition as v2's workspaceFor", () => {
    const r = req();
    const p = legacyVisitorPrincipal(r);
    expect(p.orgId).toBe(workspaceOf(requireVisitor(r).visitorId));
    expect(p.orgId).toBe(`ws_${VID}`);
    expect(p).toMatchObject({ kind: "visitor", userId: null, isAnonymous: false, orgKind: "guest", role: "owner", plan: "guest", apiKeyId: null, visitorId: VID });
    expect(p.scopes).toEqual([]);
  });

  it("honours the `x-baton-visitor` header over the cookie, like v2", () => {
    const headers = new Headers({ [VISITOR_HEADER]: signVisitorId("header-vid", VISITOR_SECRET) });
    headers.set("cookie", `${VISITOR_COOKIE}=${encodeURIComponent(signVisitorId(VID, VISITOR_SECRET))}`);
    expect(legacyVisitorPrincipal(new Request(`${APP_URL}/x`, { headers })).orgId).toBe("ws_header-vid");
  });

  it("ignores a forged cookie and mints a fresh device rather than 401-ing", () => {
    const headers = new Headers({ cookie: `${VISITOR_COOKIE}=${VID}.not-a-real-hmac` });
    const p = legacyVisitorPrincipal(new Request(`${APP_URL}/x`, { headers }));
    expect(p.orgId).not.toBe(`ws_${VID}`);
    expect(p.orgId?.startsWith("ws_")).toBe(true);
  });

  it("always carries the device fields, so the v2 limits keep working", () => {
    const p = legacyVisitorPrincipal(req());
    expect(p.visitorId).toBe(VID);
    expect(p.ipKey).toMatch(/^[\w-]{22}$/);
    expect(p.requestId.length).toBeGreaterThan(0);
  });

  it("reuses an upstream x-request-id when there is one", () => {
    expect(requestIdOf(req({ headers: { "x-request-id": "req-42" } }))).toBe("req-42");
    expect(requestIdOf(req())).not.toBe("req-42");
  });
});

describe("TENANCY_MODE (SAAS §2.8)", () => {
  it("defaults to legacy and only `orgs` switches it", () => {
    expect(tenancyMode(undefined)).toBe("legacy");
    expect(tenancyMode("")).toBe("legacy");
    expect(tenancyMode("ORGS")).toBe("legacy");
    expect(tenancyMode("orgs")).toBe("orgs");
  });

  it("requirePrincipal returns the legacy workspace by default", async () => {
    await expect(requirePrincipal(req())).resolves.toMatchObject({ orgId: `ws_${VID}`, role: "owner", plan: "guest" });
  });

  it("in orgs mode a visitor has no org, so a route without allowVisitor gets 401", async () => {
    process.env.TENANCY_MODE = "orgs";
    expect(orglessVisitorPrincipal(req()).orgId).toBeNull();
    const e = await caught(() => requirePrincipal(req()));
    expect([e.code, e.status]).toEqual(["E_AUTH_REQUIRED", 401]);
    expect(e.extra).toEqual({ start: "/start?next=%2Fapi%2Frelays" });
    await expect(requirePrincipal(req(), { allowVisitor: true })).resolves.toMatchObject({ orgId: null });
  });

  it("the 401 start path carries the caller back", () => {
    expect(startPathFor({ url: `${APP_URL}/app/relays?tab=code` })).toBe("/start?next=%2Fapp%2Frelays%3Ftab%3Dcode");
    expect(startPathFor({})).toBe("/start?next=%2Fapp");
  });
});

describe("SAAS §2.3 need rules", () => {
  it("account: true refuses a visitor and an anonymous account", async () => {
    const e = await caught(() => requirePrincipal(req(), { account: true }));
    expect([e.code, e.status]).toEqual(["E_ACCOUNT_REQUIRED", 403]);
    expect(() => applyNeed(sessionPrincipal({ isAnonymous: true }), { account: true }, req())).toThrow(/account/i);
    expect(() => applyNeed(sessionPrincipal(), { account: true }, req())).not.toThrow();
  });

  it("a missing role permission is E_FORBIDDEN and a missing key scope is E_SCOPE", async () => {
    const viewer = await caught(async () => applyNeed(sessionPrincipal({ role: "viewer" }), { perm: "relay:write" }, req()));
    expect([viewer.code, viewer.status]).toEqual(["E_FORBIDDEN", 403]);
    const key = await caught(async () =>
      applyNeed(sessionPrincipal({ kind: "api_key", role: null, userId: null, scopes: ["relays:read"] }), { perm: "relay:write" }, req()),
    );
    expect([key.code, key.status]).toEqual(["E_SCOPE", 403]);
  });

  it("the legacy owner passes every permission, so no v2 route becomes forbidden", async () => {
    for (const perm of ["relay:read", "relay:write", "relay:publish", "run:start", "secret:write"] as const) {
      await expect(requirePrincipal(req({ method: "POST" }), { perm })).resolves.toMatchObject({ role: "owner" });
    }
  });
});

describe("SAAS §3.9 same-origin (CSRF)", () => {
  it("a cross-origin POST from a legacy device is still allowed (v2 unchanged)", async () => {
    const r = req({ method: "POST", headers: { origin: "https://evil.test" } });
    await expect(requirePrincipal(r, { perm: "relay:write" })).resolves.toMatchObject({ kind: "visitor" });
  });

  it("a cross-origin POST with a session is 403 E_CSRF", async () => {
    const e = await caught(async () =>
      applyNeed(sessionPrincipal(), undefined, req({ method: "POST", headers: { origin: "https://evil.test" } })),
    );
    expect([e.code, e.status]).toEqual(["E_CSRF", 403]);
  });

  it("Origin = APP_URL or Sec-Fetch-Site: same-origin passes; GET always passes", () => {
    const opts = { appUrl: APP_URL, nodeEnv: "production" };
    expect(checkSameOrigin({ method: "GET", headers: new Headers({ origin: "https://evil.test" }) }, opts)).toMatchObject({ ok: true, reason: "safe_method" });
    expect(checkSameOrigin({ method: "POST", headers: new Headers({ origin: APP_URL }) }, opts)).toMatchObject({ ok: true, reason: "origin_match" });
    expect(checkSameOrigin({ method: "POST", headers: new Headers({ "sec-fetch-site": "same-origin" }) }, opts)).toMatchObject({ ok: true, reason: "sec_fetch_site" });
    expect(checkSameOrigin({ method: "POST", headers: new Headers({ "sec-fetch-site": "cross-site", origin: "https://evil.test" }) }, opts)).toMatchObject({ ok: false });
    expect(checkSameOrigin({ method: "POST", headers: new Headers() }, opts)).toMatchObject({ ok: false, reason: "origin_missing" });
  });

  it("a trailing slash or a port-equal APP_URL still matches, and a look-alike host does not", () => {
    const opts = { appUrl: `${APP_URL}/`, nodeEnv: "production" };
    expect(checkSameOrigin({ method: "POST", headers: new Headers({ origin: APP_URL }) }, opts).ok).toBe(true);
    expect(checkSameOrigin({ method: "POST", headers: new Headers({ origin: "https://app.example.test.evil.test" }) }, opts).ok).toBe(false);
  });

  it("outside production an unset APP_URL does not block local runs", () => {
    expect(checkSameOrigin({ method: "POST", headers: new Headers() }, { appUrl: undefined, nodeEnv: "development" }).ok).toBe(true);
    expect(checkSameOrigin({ method: "POST", headers: new Headers() }, { appUrl: undefined, nodeEnv: "production" }).ok).toBe(false);
  });
});

describe("the principal resolver port", () => {
  it("requirePrincipal delegates, so WP19·2 swaps in the session resolver without touching routes", async () => {
    const stub = sessionPrincipal({ orgId: "org_from_session" });
    setPrincipalResolver({ resolve: async () => stub });
    await expect(requirePrincipal(req())).resolves.toBe(stub);
    resetSaasPorts();
    await expect(requirePrincipal(req())).resolves.toMatchObject({ orgId: `ws_${VID}` });
  });
});
