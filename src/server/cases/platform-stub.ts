import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { SignJWT, jwtVerify } from "jose";

import { BatonError } from "../../core/contracts/errors";
import type { RateLimiter } from "../../core/contracts/services";
import { newId } from "../../lib/ids";
import { ipKeyOf } from "../auth/visitor";
import type { CasesPlatform, CasesVisitor } from "./platform";

/**
 * PRE-G1 STAND-IN for WP2's auth and limits (src/server/{auth,limits} on wp/wp2). Same token formats as WP2 (visitor
 * `<id>.<hmac>`; case token = HS256 JWT, iss "baton", sub caseId, `vid`, `scp`), so nothing changes for clients at G1.
 * The rate limiter is in-memory (one process) and there is no spend ledger. Replaced at G1 (wp3-to-integrator.md).
 */

const VISITOR_HEADER = "x-baton-visitor";
const VISITOR_COOKIE = "bvid";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function secretOf(name: "VISITOR_SECRET" | "CASE_TOKEN_SECRET"): string {
  const s = process.env[name]?.trim();
  if (!s) throw new BatonError("E_INTERNAL", `${name} is not configured (value never printed)`);
  return s;
}
const hmac = (secret: string, data: string): string => createHmac("sha256", secret).update(data).digest("base64url");
const sign = (id: string): string => `${id}.${hmac(secretOf("VISITOR_SECRET"), `bvid:${id}`)}`;

function verifyVisitor(value: string | null | undefined): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = value.slice(0, dot);
  if (!ID_RE.test(id)) return null;
  const a = Buffer.from(sign(id));
  const b = Buffer.from(value);
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}

function cookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/**
 * ipKey: WP12's `ipKeyOf` (PLATFORM v2.1 §10.2, P-0), the same material and hmac as every other route. The v2.0 code
 * here keyed on the client-controlled LEFTMOST `X-Forwarded-For` entry; WP12·0 moves `ipKeyOf` to the balancer-set hop
 * grouped by /24 or /48 (`src/server/auth/client-ip.ts`), and this stand-in follows it automatically.
 */
function visitorOf(req: { headers: Headers }): CasesVisitor {
  const ipKey = ipKeyOf(req);
  const id = verifyVisitor(req.headers.get(VISITOR_HEADER)) ?? verifyVisitor(cookie(req.headers.get("cookie"), VISITOR_COOKIE));
  return { visitorId: id ?? newId(), ipKey };
}

const key = (): Uint8Array => new TextEncoder().encode(secretOf("CASE_TOKEN_SECRET"));

/** In-memory sliding window (per process). */
export class MemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}
  async hit(bucket: string, k: string, limit: number, windowSec: number, cost = 1): Promise<{ ok: boolean; retryAfterSec: number }> {
    const id = `${bucket}\u0000${k}`;
    const t = this.now();
    const arr = (this.hits.get(id) ?? []).filter((x) => x > t - windowSec * 1000);
    if (arr.length + cost > limit) {
      this.hits.set(id, arr);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(((arr[0] ?? t) + windowSec * 1000 - t) / 1000)) };
    }
    for (let i = 0; i < cost; i++) arr.push(t);
    this.hits.set(id, arr);
    return { ok: true, retryAfterSec: 0 };
  }
}

export function createStubPlatform(): CasesPlatform {
  const limiter = new MemoryRateLimiter();
  return {
    requireVisitor: visitorOf,
    async requireCase(req, want) {
      const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization")?.trim() ?? "");
      if (!m?.[1]) throw new BatonError("E_CASE_TOKEN", "Missing case token.");
      let sub: string, vid: unknown, scp: unknown;
      try {
        const { payload } = await jwtVerify(m[1].trim(), key(), { algorithms: ["HS256"], issuer: "baton" });
        sub = String(payload.sub);
        vid = payload.vid;
        scp = payload.scp;
      } catch {
        throw new BatonError("E_CASE_TOKEN", "The case token is not valid.");
      }
      const v = visitorOf(req);
      if (typeof vid !== "string" || vid !== v.visitorId) throw new BatonError("E_FORBIDDEN", "This case belongs to another visitor.");
      if (sub !== want.caseId) throw new BatonError("E_FORBIDDEN", "The token is for another case.");
      if (!Array.isArray(scp) || !scp.includes("case")) throw new BatonError("E_FORBIDDEN", "The token lacks the required scope.");
      return { caseId: sub, visitorId: vid, ipKey: v.ipKey };
    },
    async issueCaseToken(i) {
      const nowS = Math.floor(Date.now() / 1000);
      return new SignJWT({ vid: i.visitorId, scp: ["case", "tools"] })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer("baton")
        .setSubject(i.caseId)
        .setIssuedAt(nowS)
        .setExpirationTime(nowS + 45 * 60)
        .sign(key());
    },
    issueVisitorToken: sign,
    rateLimiter: () => limiter,
    ledger: () => null,
    deployId: () => process.env.BATON_DEPLOY_ID?.trim() || "dev-local",
  };
}
