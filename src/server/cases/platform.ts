import "server-only";

import type { RateLimiter, SpendLedger } from "../../core/contracts/services";

/**
 * The platform services WP3's routes consume from WP2 (TASKS WP3 "Consumes": `requireVisitor`, `requireCase`,
 * `RateLimiter`, `getLimitsAuthority().ledger`), as a port. Before G1 `defaults.ts` binds `platform-stub.ts`; the
 * G1 binding to WP2's `src/server/auth` + `src/server/limits` is one file (docs/notes/requests/wp3-to-integrator.md).
 * WP2's functions fit these signatures as they are (checked against wp/wp2 aa251d8).
 */
export interface CasesVisitor {
  visitorId: string;
  ipKey: string;
}

export interface CasesPlatform {
  /** WP2 `requireVisitor(req)`: never throws for a missing identity (mints a fresh id). */
  requireVisitor(req: { headers: Headers }): CasesVisitor;
  /** WP2 `requireCase(req, {caseId})`: 401 E_CASE_TOKEN / 403 E_FORBIDDEN as BatonError. */
  requireCase(req: { headers: Headers }, want: { caseId: string }): Promise<CasesVisitor & { caseId: string }>;
  /** WP2 `issueCaseToken({caseId, visitorId})` (scopes case+tools, 45 min). */
  issueCaseToken(i: { caseId: string; visitorId: string }): Promise<string>;
  /** WP2 `issueVisitorToken(visitorId)` (`<id>.<hmac>`, returned as CreateCaseResponse.visitorToken). */
  issueVisitorToken(visitorId: string): string;
  rateLimiter(): RateLimiter;
  /** `getLimitsAuthority().ledger`; null = spend is not recorded (tests, stub). */
  ledger(): SpendLedger | null;
  /** BATON_DEPLOY_ID (ledger `env`). */
  deployId(): string;
}

/** DESIGN §4.4 / §7.3 buckets of WP3's routes. */
export const CASE_RATES = {
  /** #3: 10/h/visitor */
  createVisitor: { bucket: "cases", limit: 10, windowSec: 3600 },
  /** #3: 30/h/ipKey */
  createIp: { bucket: "cases-ip", limit: 30, windowSec: 3600 },
  /** #4: 120/min/case */
  viewCase: { bucket: "case-view", limit: 120, windowSec: 60 },
  /** #8: 5/s, burst 10 per case (a 10-per-2-s sliding window). */
  extractBurst: { bucket: "extract", limit: 10, windowSec: 2 },
  /** #8: 250 turns per case (lifetime of a case ≪ 1 day). */
  extractTotal: { bucket: "extract-total", limit: 250, windowSec: 86_400 },
} as const;
