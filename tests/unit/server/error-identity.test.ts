/**
 * QA-FIX (docs/notes/qa-fix.md): errors and singletons are recognised by **brand, never by `instanceof` alone**.
 *
 * Next loads a module graph more than once in one process — the server-component graph, each route's chunk, dev
 * reloads — so a class can exist twice and an object built by one copy fails `instanceof` against the other.
 * `src/server/read-models/app-guard.ts` already had to learn this once (`isNoPrincipal` checks `.code`); the
 * adversarial QA pass found two more places that had not:
 *
 *  - a cross-tenant `PUT`/`DELETE /api/relays/:id` answered **500 `E_INTERNAL`** while the log showed the
 *    correct `BatonError E_NOT_FOUND "No such relay."` thrown by `registry.ownRow()` — a different chunk;
 *  - `POST /api/internal/limits/*` answered **404 "Not the limits authority."** on the very process that was the
 *    authority, because `getDbAuthority()` tested `instanceof DbLimitsAuthority` against the other copy. That is
 *    the documented remote kill-switch, dead, on a deployment whose `/api/admin/ledger` worked.
 *
 * Neither can be reproduced by importing the module twice in vitest (one instance, one registry), so every test
 * here builds the **foreign twin**: an object with the same `name`, `code` and fields that a duplicate class
 * would produce, and no prototype in common with ours.
 */
import { describe, expect, it } from "vitest";

import { ERROR_HTTP_STATUS, isBatonError } from "@/core/contracts/errors";
import { isSecretError } from "@/server/secrets/store";
import { isConnectorError } from "@/server/connectors/errors";
import { isRelayError, relayRoute } from "@/server/relays/http";
import { isSaasError } from "@/server/saas/errors";

/** What a second copy of the class produces: same shape, same `name`, unrelated prototype. */
class ForeignError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(name: string, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = name;
    this.code = code;
    Object.assign(this, extra);
  }
}

const ctx = { params: Promise.resolve({ id: "rl_other_org" }) };
const req = () => new Request("https://app.example.test/api/relays/rl_other_org", { method: "DELETE" });

describe("error predicates survive a duplicate module graph", () => {
  it("accepts a foreign BatonError, SaasError, RelayError, SecretError and ConnectorError", () => {
    expect(isBatonError(new ForeignError("BatonError", "E_NOT_FOUND", "No such relay."))).toBe(true);
    expect(isSaasError(new ForeignError("SaasError", "E_FORBIDDEN", "Nope.", { status: 403 }))).toBe(true);
    expect(isRelayError(new ForeignError("RelayError", "E_LINT", "Bad blueprint."))).toBe(true);
    expect(isSecretError(new ForeignError("SecretError", "E_SECRET_LIMIT", "Too many."))).toBe(true);
    expect(isConnectorError(new ForeignError("ConnectorError", "E_CONN_URL", "Bad url."))).toBe(true);
  });

  it("still refuses anything that is not ours, so a pg or fs error keeps becoming a logged 500", () => {
    expect(isBatonError(new ForeignError("Error", "E_NOT_FOUND", "not ours"))).toBe(false);
    expect(isBatonError(new ForeignError("BatonError", "ENOENT", "not our code"))).toBe(false);
    expect(isBatonError(Object.assign(new Error("pg"), { code: "23505" }))).toBe(false);
    expect(isBatonError(null)).toBe(false);
    expect(isBatonError("E_NOT_FOUND")).toBe(false);
    expect(isSaasError(new ForeignError("SaasError", "E_WHATEVER", "unknown code"))).toBe(false);
    expect(isRelayError(new ForeignError("RelayError", "E_NOPE", "unknown code"))).toBe(false);
    expect(isSecretError(new ForeignError("SecretError", "E_OTHER", "unknown code"))).toBe(false);
  });

  it("maps every ErrorCode the contract knows, so the duck check cannot drift from the status map", () => {
    for (const code of Object.keys(ERROR_HTTP_STATUS)) {
      expect(isBatonError(new ForeignError("BatonError", code, "x")), code).toBe(true);
    }
  });
});

describe("relayRoute maps a foreign error to its own status, not to 500", () => {
  it("a cross-tenant BatonError('E_NOT_FOUND') from another chunk is a 404", async () => {
    const route = relayRoute("relay-delete", async () => {
      throw new ForeignError("BatonError", "E_NOT_FOUND", "No such relay.");
    });
    const res = await route(req(), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "E_NOT_FOUND", message: "No such relay." } });
  });

  it("a foreign SaasError keeps the §6.3 envelope and its status", async () => {
    const route = relayRoute("relay-put", async () => {
      throw new ForeignError("SaasError", "E_FORBIDDEN", "Not your workspace.", { status: 403 });
    });
    const res = await route(req(), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "E_FORBIDDEN" } });
  });

  it("a foreign RelayError keeps the v2 envelope and its status", async () => {
    const route = relayRoute("relay-put", async () => {
      throw new ForeignError("RelayError", "E_LINT", "2 errors.", { extra: { lint: [{ code: "x" }] } });
    });
    const res = await route(req(), ctx);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "E_LINT" } });
  });

  it("an error that is genuinely not ours is still a leak-free 500", async () => {
    const route = relayRoute("relay-put", async () => {
      throw new Error("connection terminated: password authentication failed for user 'baton'");
    });
    const res = await route(req(), ctx);
    expect(res.status).toBe(500);
    const body = (await res.text()).toLowerCase();
    expect(body).toContain("e_internal");
    expect(body).not.toContain("password");
  });
});

/**
 * Found while re-verifying the fixes on the built server: `POST /api/cases` answered **500 `E_INTERNAL`** for a
 * cross-origin request and for a foreign `relayId`, while the log showed the correct
 * `SaasError E_CSRF` / `E_NOT_FOUND`. The v1/v2 wrappers predate `SaasError` and only knew `BatonError` — but
 * `requirePrincipal` (and its same-origin check) is v3 and is called from v2 routes. Same shape as the relay
 * finding, one layer over.
 */
describe("the v1/v2 wrappers keep a v3 SaasError's own status", () => {
  const cases = async (err: unknown) => {
    const { route } = await import("@/server/cases/http");
    return route("cases.create", async () => {
      throw err;
    })(new Request("https://app.example.test/api/cases", { method: "POST" }), {});
  };

  it("a same-origin refusal is a 403 E_CSRF, not a 500 that says nothing", async () => {
    const { SaasError } = await import("@/server/saas/errors");
    const res = await cases(new SaasError("E_CSRF", "This request did not come from the app."));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "E_CSRF" } });
  });

  it("a foreign relay id is a 404, and a foreign SaasError (another chunk) is too", async () => {
    const res = await cases(new ForeignError("SaasError", "E_NOT_FOUND", "No such relay.", { status: 404 }));
    expect(res.status).toBe(404);
  });

  it("the generic handler() does the same", async () => {
    const { handler } = await import("@/server/auth/http");
    const { SaasError } = await import("@/server/saas/errors");
    const res = await handler("status", async () => {
      throw new SaasError("E_AUTH_REQUIRED", "Sign in.");
    })(new Request("https://app.example.test/api/status"), { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });
});

describe("getDbAuthority recognises the authority across module copies", () => {
  it("brands the class, so the internal limits routes cannot 404 on their own process", async () => {
    const { DbLimitsAuthority, isDbLimitsAuthority, getDbAuthority, setLimitsAuthority } = await import("@/server/limits");
    // The real class still passes (the `instanceof` leg).
    expect(isDbLimitsAuthority(Object.create(DbLimitsAuthority.prototype) as object)).toBe(true);
    // A twin from a second copy of the module: same brand, unrelated prototype.
    const twin = { isDbLimitsAuthority: true, ledger: {}, flagStore: {} };
    expect(isDbLimitsAuthority(twin)).toBe(true);
    // Anything else — the laptop file guard, the remote HTTP client — is still not the authority.
    expect(isDbLimitsAuthority({})).toBe(false);
    expect(isDbLimitsAuthority(null)).toBe(false);

    setLimitsAuthority(twin as never);
    try {
      expect(getDbAuthority()).toBe(twin);
    } finally {
      setLimitsAuthority(null);
    }
  });
});
