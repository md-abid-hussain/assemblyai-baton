/**
 * `platform-stub.ts` ipKey swap (PLATFORM v2.1 §10.2, P-0; requests/wp12-to-wp14b.md §1): the stand-in no longer
 * hashes the client-controlled leftmost `X-Forwarded-For` itself; it uses WP12's `ipKeyOf`, so both paths give the
 * same key for the same request and follow WP12's balancer-hop fix without another change here. $0.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ipKeyOf, signVisitorId } from "@/server/auth/visitor";
import { createStubPlatform } from "@/server/cases/platform-stub";
import { SECRETS, withSecrets } from "../relays/helpers";

const reqOf = (h: Record<string, string>) => ({ headers: new Headers(h) });

describe("platform-stub ipKey = WP12 ipKeyOf", () => {
  let restore: () => void;
  beforeAll(() => {
    restore = withSecrets();
  });
  afterAll(() => restore?.());

  it("the same key as ipKeyOf for every header shape, whoever the visitor is", () => {
    const p = createStubPlatform();
    const shapes: Record<string, string>[] = [
      { "x-forwarded-for": "203.0.113.7" },
      { "x-forwarded-for": "198.51.100.9, 10.0.0.1" },
      { "x-real-ip": "192.0.2.44" },
      { "x-forwarded-for": "2001:db8::1", "x-real-ip": "2001:db8::1" },
      {},
    ];
    for (const h of shapes) {
      const anon = p.requireVisitor(reqOf(h));
      const known = p.requireVisitor(reqOf({ ...h, "x-baton-visitor": signVisitorId("visitorA", SECRETS.VISITOR_SECRET) }));
      expect(anon.ipKey, JSON.stringify(h)).toBe(ipKeyOf(reqOf(h)));
      expect(known.ipKey).toBe(anon.ipKey);
      expect(known.visitorId).toBe("visitorA");
      expect(anon.ipKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
    expect(p.requireVisitor(reqOf({ "x-real-ip": "192.0.2.44" })).ipKey).not.toBe(p.requireVisitor(reqOf({ "x-real-ip": "203.0.113.200" })).ipKey);
  });
});
