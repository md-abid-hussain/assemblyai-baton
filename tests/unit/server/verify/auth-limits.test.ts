import { describe, expect, it } from "vitest";

import { BatonError } from "@/core/contracts/errors";
import { tokenAuthorizer } from "@/server/qa/auth";
import { MemoryRateLimiter } from "@/server/qa/deps";
import { TEST_SECRET, tokenFor } from "./helpers";

const req = (token?: string) => ({ headers: new Headers(token ? { authorization: `Bearer ${token}` } : {}) });
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof BatonError ? e.code : String(e);
  }
};

describe("takeover authorizer (default until WP2's requireCase is wired)", () => {
  const auth = tokenAuthorizer({ secret: () => TEST_SECRET });

  it("accepts the takeover-scoped token and returns the principal", async () => {
    const tok = await tokenFor({ caseId: "c1", takeoverId: "t1", visitorId: "v9" });
    expect(await auth(req(tok), "t1")).toEqual({ caseId: "c1", visitorId: "v9", takeoverId: "t1" });
  });

  it("401 missing/expired/forged; 403 wrong takeover or scope", async () => {
    expect(await codeOf(auth(req(), "t1"))).toBe("E_CASE_TOKEN");
    expect(await codeOf(auth(req(await tokenFor({ caseId: "c1", takeoverId: "t1", expSec: -10 })), "t1"))).toBe("E_CASE_TOKEN");
    expect(await codeOf(tokenAuthorizer({ secret: () => "another-secret-another-secret-00" })(req(await tokenFor({ caseId: "c1", takeoverId: "t1" })), "t1"))).toBe("E_CASE_TOKEN");
    expect(await codeOf(auth(req(await tokenFor({ caseId: "c1", takeoverId: "t2" })), "t1"))).toBe("E_FORBIDDEN");
    expect(await codeOf(auth(req(await tokenFor({ caseId: "c1", takeoverId: "t1", scp: ["tools"] })), "t1"))).toBe("E_FORBIDDEN");
  });

  it("refuses to run without a secret", async () => {
    const tok = await tokenFor({ caseId: "c1", takeoverId: "t1" });
    expect(await codeOf(tokenAuthorizer({ secret: () => undefined })(req(tok), "t1"))).toBe("E_INTERNAL");
  });
});

describe("MemoryRateLimiter", () => {
  it("allows `limit` hits per window per key, then reports Retry-After", async () => {
    let now = 0;
    const l = new MemoryRateLimiter(() => now);
    expect((await l.hit("b", "k", 2, 1)).ok).toBe(true);
    expect((await l.hit("b", "k", 2, 1)).ok).toBe(true);
    expect(await l.hit("b", "k", 2, 1)).toEqual({ ok: false, retryAfterSec: 1 });
    expect((await l.hit("b", "other", 2, 1)).ok).toBe(true);
    now = 1001;
    expect((await l.hit("b", "k", 2, 1)).ok).toBe(true);
  });
});
