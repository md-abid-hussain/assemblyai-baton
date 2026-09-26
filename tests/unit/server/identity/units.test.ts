/**
 * WP19·2 pure units: the §3.8 blocked-path matcher (acceptance 6), the prefixed ids, the §15 environment reading
 * and `?next=` sanitising. No database, no Better Auth instance, no network — these run everywhere and they are
 * the parts a route mistake would otherwise reach production through.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  AUTH_BASE_PATH,
  BLOCKED_CLIENT_AUTH_PATHS,
  authPathOf,
  isBlockedClientAuthPath,
} from "@/server/identity/blocked-paths";
import { ID_PREFIXES, prefixedId, saasId } from "@/server/identity/ids";
import { safeNext } from "@/server/identity/guest-start";
import {
  MIN_SECRET_LENGTH,
  authConfigured,
  authMissing,
  guestLimits,
  trustedOrigins,
} from "@/server/identity/config";
import { resetEnvCache } from "@/server/env";

const req = (url: string, method = "POST") => ({ method, url });

describe("§3.8 blocked client auth paths", () => {
  it("blocks exactly the §3.8 list on a mutating method", () => {
    for (const p of BLOCKED_CLIENT_AUTH_PATHS) {
      expect(isBlockedClientAuthPath(req(`https://app.test${AUTH_BASE_PATH}${p}`))).toBe(true);
    }
    // The list is the contract: if someone adds a path, this count moves deliberately.
    expect(BLOCKED_CLIENT_AUTH_PATHS.length).toBe(15);
    expect(new Set(BLOCKED_CLIENT_AUTH_PATHS).size).toBe(BLOCKED_CLIENT_AUTH_PATHS.length);
  });

  it("leaves the §3.8 read list alone — blocking every POST would break sign-in", () => {
    const allowed = [
      "/get-session",
      "/organization/list",
      "/organization/get-full-organization",
      "/organization/set-active",
      "/organization/accept-invitation",
      "/organization/list-invitations",
      "/sign-in/email",
      "/sign-up/email",
      "/sign-in/anonymous",
      "/sign-out",
      "/list-sessions",
      "/revoke-session",
      "/change-password",
    ];
    for (const p of allowed) {
      expect(isBlockedClientAuthPath(req(`https://app.test${AUTH_BASE_PATH}${p}`))).toBe(false);
    }
  });

  it("never blocks a safe method (the OpenAPI page is a GET on a blocked-looking path)", () => {
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(isBlockedClientAuthPath(req(`https://app.test${AUTH_BASE_PATH}/organization/create`, m))).toBe(false);
    }
  });

  it("normalises the path so the obvious evasions do not work", () => {
    const evasions = [
      "/organization//create", // duplicate slash
      "/organization/create/", // trailing slash
      "/Organization/Create", // case
      "/organization%2Fcreate", // percent-encoded separator
      "/organization/create?x=1", // query string
      "/organization/create#frag",
    ];
    for (const e of evasions) {
      expect(isBlockedClientAuthPath(req(`https://app.test${AUTH_BASE_PATH}${e}`))).toBe(true);
    }
  });

  it("returns null for a path outside the catch-all, and blocks nothing there", () => {
    expect(authPathOf("https://app.test/api/app/orgs")).toBeNull();
    expect(authPathOf("https://app.test/call/s01")).toBeNull();
    // A route that merely *contains* the blocked suffix is not under /api/auth and must not 403.
    expect(isBlockedClientAuthPath(req("https://app.test/api/app/organization/create"))).toBe(false);
  });

  it("survives a malformed percent-escape instead of throwing", () => {
    expect(() => authPathOf(`https://app.test${AUTH_BASE_PATH}/organization/%E0%A4%A`)).not.toThrow();
    expect(isBlockedClientAuthPath(req(`https://app.test${AUTH_BASE_PATH}/%E0%A4%A`))).toBe(false);
  });
});

describe("prefixed ids (§2.2, VERIFY b: generateId is called with the singular model)", () => {
  it("prefixes each model our config creates, and stays unique", () => {
    expect(prefixedId("organization").startsWith("org_")).toBe(true);
    expect(prefixedId("user").startsWith("usr_")).toBe(true);
    expect(prefixedId("session").startsWith("ses_")).toBe(true);
    expect(prefixedId("member").startsWith("mem_")).toBe(true);
    expect(prefixedId("invitation").startsWith("inv_")).toBe(true);
    expect(new Set(Array.from({ length: 200 }, () => prefixedId("organization"))).size).toBe(200);
  });

  it("falls back to a bare id for a model a later plugin brings", () => {
    const id = prefixedId("somethingNew");
    expect(id.length).toBeGreaterThan(10);
    expect(Object.values(ID_PREFIXES).some((p) => id.startsWith(p))).toBe(false);
  });

  it("saasId prefixes our own tables", () => {
    expect(saasId("aud_").startsWith("aud_")).toBe(true);
  });
});

describe("?next= sanitising (§3.9)", () => {
  it("accepts a same-origin relative path", () => {
    expect(safeNext("/app/relays")).toBe("/app/relays");
    expect(safeNext("/call/s01?express=1")).toBe("/call/s01?express=1");
  });

  it("drops anything that could leave the origin", () => {
    for (const bad of [
      "//evil.test/x", // protocol-relative
      "https://evil.test/x",
      "http://evil.test",
      "/\\evil.test", // backslash
      "\\\\evil.test",
      "app/relays", // not absolute
      "",
      "   ",
      null,
      undefined,
      42,
      {},
      `/${"a".repeat(600)}`, // over the length bound
    ]) {
      expect(safeNext(bad)).toBeUndefined();
    }
  });
});

describe("§15 environment", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    resetEnvCache();
  });

  it("treats a too-short BETTER_AUTH_SECRET as absent rather than truncating it", () => {
    process.env.BETTER_AUTH_SECRET = "x".repeat(MIN_SECRET_LENGTH - 1);
    resetEnvCache();
    expect(authConfigured()).toBe(false);
    expect(authMissing()).toContain("BETTER_AUTH_SECRET");

    process.env.BETTER_AUTH_SECRET = "x".repeat(MIN_SECRET_LENGTH);
    resetEnvCache();
    expect(authMissing()).not.toContain("BETTER_AUTH_SECRET");
  });

  it("authMissing names only variable names, never a value (DESIGN §3.4)", () => {
    process.env.BETTER_AUTH_SECRET = "super-secret-value-that-must-never-leak-0000";
    resetEnvCache();
    expect(authMissing().join(" ")).not.toContain("super-secret");
  });

  it("guest limits default to the §3.3 numbers and accept an override", () => {
    delete process.env.GUEST_PER_DEVICE_DAILY;
    delete process.env.GUEST_DAILY_CAP;
    resetEnvCache();
    expect(guestLimits()).toEqual({ perDeviceDaily: 10, perIpKeyHourly: 30, perIpKeyDaily: 120, globalDaily: 2000 });

    process.env.GUEST_PER_DEVICE_DAILY = "3";
    expect(guestLimits().perDeviceDaily).toBe(3);

    // Junk and negatives fall back to the default rather than locking the endpoint at 0.
    process.env.GUEST_PER_DEVICE_DAILY = "not-a-number";
    expect(guestLimits().perDeviceDaily).toBe(10);
    process.env.GUEST_PER_DEVICE_DAILY = "-5";
    expect(guestLimits().perDeviceDaily).toBe(10);
    // Zero is a real value: it is how the endpoint is switched off.
    process.env.GUEST_PER_DEVICE_DAILY = "0";
    expect(guestLimits().perDeviceDaily).toBe(0);
  });

  it("trustedOrigins carries the public origin without a trailing slash, plus dev localhost", () => {
    process.env.APP_URL = "https://app.example.test/";
    // `NODE_ENV` is typed read-only by @types/node; this is the standard test-side widening.
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    resetEnvCache();
    const prod = trustedOrigins();
    expect(prod).toContain("https://app.example.test");
    expect(prod.some((o) => o.endsWith("/"))).toBe(false);
    expect(prod).not.toContain("http://localhost:3190");
  });
});
