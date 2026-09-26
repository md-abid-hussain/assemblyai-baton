/**
 * The `/app` guard's two failure modes (SAAS §8.1, §3.3 step 2). WP20·1.
 *
 * Both were found by running the app in `TENANCY_MODE=orgs`, and neither could have been found by reading the
 * code, so both are pinned here.
 */
import { describe, expect, it } from "vitest";

import { START_ATTEMPT_COOKIE } from "@/core/contracts/ext/wp20-app";
import { isNoPrincipal, pathWithQuery } from "@/server/read-models/app-guard";
import { SaasError } from "@/server/saas/errors";

describe("isNoPrincipal", () => {
  it("recognises the real error class", () => {
    expect(isNoPrincipal(new SaasError("E_AUTH_REQUIRED", "x"))).toBe(true);
    expect(isNoPrincipal(new SaasError("E_ACCOUNT_REQUIRED", "x"))).toBe(true);
  });

  it("recognises a SaasError from a SECOND copy of the module", () => {
    // Next loads the module graph more than once (server components, routes, dev reloads), so the error a
    // route throws can be an instance of a different class object than the one this module imported.
    // `instanceof` returned false there, and every anonymous /app visit became a 500 instead of a redirect.
    class OtherSaasError extends Error {
      constructor(readonly code: string) {
        super("from another module instance");
      }
    }
    expect(isNoPrincipal(new OtherSaasError("E_AUTH_REQUIRED"))).toBe(true);
    expect(isNoPrincipal({ code: "E_ACCOUNT_REQUIRED" })).toBe(true);
  });

  it("does not swallow anything else", () => {
    expect(isNoPrincipal(new SaasError("E_FORBIDDEN", "x"))).toBe(false);
    expect(isNoPrincipal(new Error("boom"))).toBe(false);
    expect(isNoPrincipal(null)).toBe(false);
    expect(isNoPrincipal(undefined)).toBe(false);
    expect(isNoPrincipal({ code: 42 })).toBe(false);
  });
});

describe("the /start loop breaker", () => {
  it("is a plain, non-authoritative cookie name shared by the page and the guard", () => {
    expect(START_ATTEMPT_COOKIE).toBe("cx_start_attempt");
  });
});

describe("pathWithQuery", () => {
  it("round-trips a filtered runs URL, so /start returns to the exact page", () => {
    expect(pathWithQuery("/app/runs", { source: "simulated", since: "2026-09-01" })).toBe(
      "/app/runs?source=simulated&since=2026-09-01",
    );
  });

  it("drops empty and absent values rather than emitting bare `?k=`", () => {
    expect(pathWithQuery("/app/runs", { source: undefined, since: "" })).toBe("/app/runs");
  });

  it("encodes a value that would otherwise break the query string", () => {
    expect(pathWithQuery("/app/runs", { relayId: "rl a&b=c" })).toBe("/app/runs?relayId=rl+a%26b%3Dc");
  });
});
