/**
 * WP2 acceptance 6: a case token with the wrong `vid` → 403; expired → 401; a cookie-less client works through the
 * `x-baton-visitor` header. Plus the visitor cookie/proxy, ipKey and the shared-secret guards.
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isBatonError } from "@/core/contracts/errors";
import { issueCaseToken, requireCase, verifyCaseToken } from "@/server/auth/case-token";
import { safeEqual } from "@/server/auth/crypto";
import { requireAdmin, requireCron, requireLimitsKey } from "@/server/auth/keys";
import { ipKeyOf, readCookie, requireVisitor, signVisitorId, verifyVisitorValue, VISITOR_COOKIE } from "@/server/auth/visitor";
import { resetEnvCache } from "@/server/env";
import { proxy } from "@/proxy";

const SECRETS = {
  CASE_TOKEN_SECRET: "auth-test-case-secret-0123456789abcdef",
  VISITOR_SECRET: "auth-test-visitor-secret-0123456789",
  ADMIN_KEY: "auth-test-admin-key-0123",
  CRON_SECRET: "auth-test-cron-secret-0123",
  LIMITS_AUTHORITY_KEY: "auth-test-limits-key-0123",
};
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [k, v] of Object.entries(SECRETS)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  saved.LIMITS_ROLE = process.env.LIMITS_ROLE;
  resetEnvCache();
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
});

const reqWith = (headers: Record<string, string>) => ({ headers: new Headers(headers) });
const cookieOf = (vid: string) => ({ cookie: `a=1; ${VISITOR_COOKIE}=${encodeURIComponent(signVisitorId(vid))}` });

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    throw new Error("expected a rejection");
  } catch (e) {
    if (!isBatonError(e)) throw e;
    expect(e.code).toBe(code);
  }
}

describe("visitor identity", () => {
  it("signs and verifies; a forged or truncated value is rejected", () => {
    const v = signVisitorId("V1StGXR8_Z5jdHi6B-myT");
    expect(verifyVisitorValue(v)).toBe("V1StGXR8_Z5jdHi6B-myT");
    expect(verifyVisitorValue(v.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBeNull();
    expect(verifyVisitorValue("other." + v.split(".")[1])).toBeNull();
    expect(verifyVisitorValue("nodot")).toBeNull();
    expect(verifyVisitorValue(signVisitorId("x", "another-secret-0123456789"))).toBeNull();
  });

  it("header wins over cookie (cookie-less browsers get a fresh proxy cookie on every request)", () => {
    const v = requireVisitor(reqWith({ ...cookieOf("from-cookie"), "x-baton-visitor": signVisitorId("from-header") }));
    expect(v).toMatchObject({ visitorId: "from-header", via: "header" });
    expect(requireVisitor(reqWith(cookieOf("from-cookie")))).toMatchObject({ visitorId: "from-cookie", via: "cookie" });
    expect(requireVisitor(reqWith({})).via).toBe("new");
  });

  it("ipKey: HMAC of day + the balancer hop (/24); the raw IP never appears; changes by day and by network", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    // Zerops: the balancer overwrites X-Real-IP and appends the client to X-Forwarded-For.
    const a = ipKeyOf(reqWith({ "x-forwarded-for": "10.9.9.9, 198.51.100.4", "x-real-ip": "198.51.100.4" }), { now });
    expect(a).toHaveLength(22);
    expect(a).not.toContain("198");
    expect(ipKeyOf(reqWith({ "x-real-ip": "198.51.100.4" }), { now })).toBe(a);
    expect(ipKeyOf(reqWith({ "x-forwarded-for": "198.51.100.4" }), { now })).toBe(a);
    expect(ipKeyOf(reqWith({ "x-real-ip": "198.51.100.77" }), { now })).toBe(a); // same /24
    expect(ipKeyOf(reqWith({ "x-real-ip": "198.51.101.4" }), { now })).not.toBe(a);
    expect(ipKeyOf(reqWith({ "x-real-ip": "198.51.100.4" }), { now: now + 86_400_000 })).not.toBe(a);
  });

  it("ipKey: a spoofed leftmost X-Forwarded-For entry no longer buys a fresh bucket (P-0)", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    const real = ipKeyOf(reqWith({ "x-forwarded-for": "198.51.100.4", "x-real-ip": "198.51.100.4" }), { now });
    for (const spoof of ["203.0.113.7", "192.0.2.1, 203.0.113.9", "garbage"]) {
      const h = { "x-forwarded-for": `${spoof}, 198.51.100.4`, "x-real-ip": "198.51.100.4" };
      expect(ipKeyOf(reqWith(h), { now })).toBe(real);
      expect(ipKeyOf(reqWith(h), { now, mode: "xff-right" })).toBe(real);
    }
    const off1 = ipKeyOf(reqWith({ "x-real-ip": "198.51.100.4" }), { now, mode: "off" });
    expect(ipKeyOf(reqWith({ "x-real-ip": "198.51.100.4" }), { now, mode: "off" })).not.toBe(off1);
  });

  it("the proxy sets bvid on the first request and injects it into that request; a valid cookie passes through", () => {
    const first = proxy(new NextRequest("http://localhost/call/s01"));
    const set = first.cookies.get(VISITOR_COOKIE);
    expect(set?.value).toBeTruthy();
    expect(verifyVisitorValue(set!.value)).toBeTruthy();
    expect(set).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    // The request override header carries the new cookie to the route handler of this same request.
    const forwarded = first.headers.get("x-middleware-request-cookie");
    expect(forwarded ?? "").toContain(VISITOR_COOKIE);
    const again = proxy(new NextRequest("http://localhost/call/s01", { headers: { cookie: `${VISITOR_COOKIE}=${encodeURIComponent(set!.value)}` } }));
    expect(again.cookies.get(VISITOR_COOKIE)).toBeUndefined();
    expect(readCookie(`x=1; ${VISITOR_COOKIE}=${encodeURIComponent(set!.value)}`, VISITOR_COOKIE)).toBe(set!.value);
  });
});

describe("case token (acceptance 6)", () => {
  it("valid for its visitor, case and scope; carries tko when issued for a takeover", async () => {
    const tok = await issueCaseToken({ caseId: "c1", visitorId: "v1", takeoverId: "t1" });
    const a = await requireCase(reqWith({ ...cookieOf("v1"), authorization: `Bearer ${tok}` }), { caseId: "c1", takeoverId: "t1", scope: "tools" });
    expect(a).toMatchObject({ caseId: "c1", visitorId: "v1", takeoverId: "t1" });
    expect(a.scopes).toEqual(["case", "tools"]);
  });

  it("wrong vid → 403 E_FORBIDDEN", async () => {
    const tok = await issueCaseToken({ caseId: "c1", visitorId: "v1" });
    await expectCode(requireCase(reqWith({ ...cookieOf("someone-else"), authorization: `Bearer ${tok}` }), { caseId: "c1" }), "E_FORBIDDEN");
  });

  it("other case, other takeover or a missing scope → 403", async () => {
    const tok = await issueCaseToken({ caseId: "c1", visitorId: "v1", scopes: ["case"] });
    const r = reqWith({ ...cookieOf("v1"), authorization: `Bearer ${tok}` });
    await expectCode(requireCase(r, { caseId: "c2" }), "E_FORBIDDEN");
    await expectCode(requireCase(r, { takeoverId: "t9" }), "E_FORBIDDEN");
    await expectCode(requireCase(r, { scope: "tools" }), "E_FORBIDDEN");
  });

  it("expired → 401 E_CASE_TOKEN; missing, malformed or wrongly signed → 401", async () => {
    const old = await issueCaseToken({ caseId: "c1", visitorId: "v1", now: Date.now() - 46 * 60_000 });
    await expectCode(requireCase(reqWith({ ...cookieOf("v1"), authorization: `Bearer ${old}` })), "E_CASE_TOKEN");
    await expectCode(requireCase(reqWith(cookieOf("v1"))), "E_CASE_TOKEN");
    await expectCode(requireCase(reqWith({ ...cookieOf("v1"), authorization: "Bearer not-a-jwt" })), "E_CASE_TOKEN");
    const forged = await issueCaseToken({ caseId: "c1", visitorId: "v1", secret: "another-secret-0123456789abcdef" });
    await expectCode(verifyCaseToken(forged), "E_CASE_TOKEN");
    // alg=none is never accepted
    const [, payload] = (await issueCaseToken({ caseId: "c1", visitorId: "v1" })).split(".");
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${payload}.`;
    await expectCode(verifyCaseToken(none), "E_CASE_TOKEN");
  });

  it("a cookie-less client works through the x-baton-visitor header", async () => {
    const tok = await issueCaseToken({ caseId: "c1", visitorId: "v-cookieless" });
    const a = await requireCase(reqWith({ "x-baton-visitor": signVisitorId("v-cookieless"), authorization: `Bearer ${tok}` }), { caseId: "c1" });
    expect(a.visitor.via).toBe("header");
    // …even when the proxy just minted a fresh (different) cookie for this request.
    const b = await requireCase(reqWith({ ...cookieOf("fresh-proxy-cookie"), "x-baton-visitor": signVisitorId("v-cookieless"), authorization: `Bearer ${tok}` }));
    expect(b.visitorId).toBe("v-cookieless");
  });
});

describe("shared-secret guards", () => {
  it("admin, cron (header or Bearer) and limits keys; constant-time compare", () => {
    expect(() => requireAdmin(reqWith({ "x-admin-key": SECRETS.ADMIN_KEY }))).not.toThrow();
    expect(() => requireAdmin(reqWith({ "x-admin-key": "nope" }))).toThrow();
    expect(() => requireAdmin(reqWith({}))).toThrow();
    expect(() => requireCron(reqWith({ "x-cron-secret": SECRETS.CRON_SECRET }))).not.toThrow();
    expect(() => requireCron(reqWith({ authorization: `Bearer ${SECRETS.CRON_SECRET}` }))).not.toThrow();
    expect(() => requireCron(reqWith({ "x-cron-secret": SECRETS.ADMIN_KEY }))).toThrow();
    process.env.LIMITS_ROLE = "remote";
    resetEnvCache();
    expect(() => requireLimitsKey(reqWith({ "x-limits-key": SECRETS.LIMITS_AUTHORITY_KEY }))).toThrow(/Not the limits authority/);
    process.env.LIMITS_ROLE = "authority";
    resetEnvCache();
    expect(() => requireLimitsKey(reqWith({ "x-limits-key": SECRETS.LIMITS_AUTHORITY_KEY }))).not.toThrow();
    expect(() => requireLimitsKey(reqWith({ "x-limits-key": "x" }))).toThrow();
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
