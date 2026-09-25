/**
 * WP19·1: `SaasError` → the SAAS §6.3 error envelope, with the §14 status map.
 * The v1 `ApiError` envelope (`src/server/auth/http.ts`) is untouched, so no v2 route or test changes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { V3_ERROR_STATUS } from "@/core/contracts/v3/errors";
import { errorDocsUrl, isSaasError, SaasError, saasErrorBody, saasErrorResponse } from "@/server/saas/errors";

const savedAppUrl = process.env.APP_URL;
beforeAll(() => {
  process.env.APP_URL = "https://app.example.test";
});
afterAll(() => {
  if (savedAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedAppUrl;
});

describe("SaasError", () => {
  it("takes its status from the §14 map", () => {
    for (const [code, status] of Object.entries(V3_ERROR_STATUS)) {
      expect(new SaasError(code as keyof typeof V3_ERROR_STATUS, "m").status).toBe(status);
    }
  });

  it("is recognisable and keeps its cause", () => {
    const cause = new Error("inner");
    const e = new SaasError("E_CONFLICT", "clash", { cause });
    expect(isSaasError(e)).toBe(true);
    expect(isSaasError(new Error("no"))).toBe(false);
    expect(e.cause).toBe(cause);
  });
});

describe("the §6.3 envelope", () => {
  it("is { error: { code, message, docs_url } }", async () => {
    const res = saasErrorResponse(new SaasError("E_NOT_FOUND", "No such relay."));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: { code: "E_NOT_FOUND", message: "No such relay.", docs_url: "https://app.example.test/docs/api#errors" },
    });
  });

  it("carries the documented top-level companions, such as a 401's start path", async () => {
    const res = saasErrorResponse(
      new SaasError("E_AUTH_REQUIRED", "Sign in.", { extra: { start: "/start?next=%2Fapp" } }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ start: "/start?next=%2Fapp" });
  });

  it("adds Retry-After for a 429", () => {
    const res = saasErrorResponse(new SaasError("E_RATE_LIMITED", "Slow down.", { retryAfterSec: 12.2 }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("13");
  });

  it("echoes zod issue paths and codec diagnostics, never values", () => {
    const body = saasErrorBody(
      new SaasError("E_VALIDATION", "Invalid request.", {
        issues: [{ path: ["source", "text"], message: "Required" }],
        diagnostics: [{ source: "codec", code: "CODEC_SYNTAX" }],
      }),
    );
    expect(body).toEqual({
      error: {
        code: "E_VALIDATION", message: "Invalid request.", docs_url: "https://app.example.test/docs/api#errors",
        issues: [{ path: ["source", "text"], message: "Required" }],
        diagnostics: [{ source: "codec", code: "CODEC_SYNTAX" }],
      },
    });
    expect(JSON.stringify(body)).not.toContain("Required value");
  });

  it("docs_url falls back to a relative path when APP_URL is unset", () => {
    expect(errorDocsUrl("https://x.test/")).toBe("https://x.test/docs/api#errors");
    const appUrl = process.env.APP_URL;
    delete process.env.APP_URL;
    try {
      expect(errorDocsUrl()).toBe("/docs/api#errors");
      expect(saasErrorBody(new SaasError("E_NOT_FOUND", "no")).error).toMatchObject({ docs_url: "/docs/api#errors" });
    } finally {
      process.env.APP_URL = appUrl;
    }
  });
});
