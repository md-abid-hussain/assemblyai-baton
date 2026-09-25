import "server-only";

/** Auth primitives (DESIGN §4.3) for every route owner: visitor, case token, shared-secret guards, route helpers. */
export {
  issueVisitorToken, ipKeyOf, readCookie, requireVisitor, signVisitorId, verifyVisitorValue, visitorSetCookie,
  VISITOR_COOKIE, VISITOR_HEADER, type Visitor,
} from "./visitor";
export {
  bearerOf, CASE_SCOPES, CASE_TOKEN_TTL_S, issueCaseToken, requireCase, verifyCaseToken,
  type CaseAuth, type CaseScope, type CaseTokenClaims,
} from "./case-token";
export { requireAdmin, requireCron, requireLimitsKey } from "./keys";
export { batonErrorResponse, errorResponse, handler, json, paramsOf, readJson, type RouteCtx } from "./http";
export { safeEqual } from "./crypto";
