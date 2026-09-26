import "server-only";

/**
 * `GET|POST|DELETE /api/app/connector-hosts` (SAAS §5.6, §8.4, §9) and `POST /api/connectors/test`
 * (PLATFORM §6.5). WP16·3.
 *
 * **Allowed hosts.** Reading is `secret:read`, writing is `secret:write` (admin+, SAAS §3.7 "incl. the allowed
 * connector hosts"). A host is normalised and validated (§5.6: exact lowercase name, no wildcards, no IP literals,
 * never our own origin), counted against the plan (`connectorHosts`: 0 on Guest and Free, so the 402 carries the
 * upgrade line), then checked against DNS — it must resolve to public unicast addresses before it is stored, so a
 * name that points at 10.0.0.5 is refused at the Settings page rather than at 3 a.m. in a call. Both mutations
 * write `connector.host_added` / `connector.host_removed`.
 *
 * **The test console** runs one connector of one of the org's relays with `mode:"console"` and no case. It returns
 * what an owner needs to debug and nothing an agent should ever see: the redacted request line and headers
 * (secrets as `‹secret:name›`), the signature, status/ms/bytes, the picked result, and the raw body — capped at
 * 2 KiB on the public deployment. Money connectors are DRY RUNS: no checkout, no SMS, no e-sign, no case write.
 */
import { z } from "zod";

import { BatonError } from "../../core/contracts/errors";
import type { Principal } from "../../core/contracts/v3/identity";
import { errorResponse, handler, json, readJson, type RouteCtx } from "../auth/http";
import { writeAudit } from "../identity/audit-hook";
import { getRateLimiter } from "../limits";
import { enforceRates, type RateSpec } from "../limits/rate-limiter";
import { log } from "../log";
import { SaasError, isSaasError, saasErrorResponse } from "../saas/errors";
import { getEntitlements } from "../saas/ports";
import { requirePrincipal } from "../saas/principal";
import { runConsoleTest } from "./console";
import { assertHostResolvesPublic, getOrgHostStore, normalizeConnectorHost, orgHostLimit } from "./host-policy";
import { installConnectorPorts } from "./install";

const routeLog = log.child({ component: "connectors-http" });

/** PLATFORM §6.5: "20 per day per visitor". The org key stops one member burning another's quota. */
export const CONNECTOR_TEST_RATES = {
  visitor: { bucket: "connector-test", limit: 20, windowSec: 86_400 },
} as const satisfies Record<string, RateSpec>;

const HostBody = z.object({ host: z.string().min(1).max(300) });
const TestBody = z.object({
  relayId: z.string().min(1).max(64),
  connectorId: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).default({}),
});

function connectorsRoute<P extends Record<string, string>>(
  name: string,
  fn: (req: Request, ctx: RouteCtx<P>) => Promise<Response>,
): (req: Request, ctx: RouteCtx<P>) => Promise<Response> {
  return handler<P>(name, async (req, ctx) => {
    installConnectorPorts();
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (isSaasError(e)) return saasErrorResponse(e);
      throw e;
    }
  });
}

const actorOf = (p: Principal): { actorType: "user" | "guest" | "api_key"; actorId: string | null; actorLabel: string } =>
  p.kind === "api_key"
    ? { actorType: "api_key", actorId: p.apiKeyId, actorLabel: "API key" }
    : p.userId
      ? { actorType: "user", actorId: p.userId, actorLabel: p.userId }
      : { actorType: "guest", actorId: null, actorLabel: "guest device" };

// ------------------------------------------------------------------------------------ allowed hosts

/** GET /api/app/connector-hosts → the org's own hosts, the plan limit, and whether the plan allows them at all. */
export const listConnectorHosts = connectorsRoute("connector-hosts.list", async (req) => {
  const p = await requirePrincipal(req, { perm: "secret:read" });
  const [hosts, limit] = await Promise.all([getOrgHostStore().list(p.orgId!), orgHostLimit(p.orgId!)]);
  return json({ hosts: [...hosts].sort(), limit, enabled: limit > 0, plan: p.plan });
});

/** POST /api/app/connector-hosts {host}. */
export const addConnectorHost = connectorsRoute("connector-hosts.add", async (req) => {
  const p = await requirePrincipal(req, { perm: "secret:write", account: true });
  const body = await readJson(req, HostBody);
  const host = normalizeConnectorHost(body.host);

  const limit = await orgHostLimit(p.orgId!);
  if (limit <= 0) {
    throw new SaasError("E_PLAN_LIMIT", "Custom connector hosts are a Pro feature. Upgrade to call your own endpoints.", {
      extra: { limit: { key: "connectorHosts", used: 0, limit: 0, plan: p.plan } },
    });
  }
  const existing = await getOrgHostStore().list(p.orgId!);
  if (!existing.includes(host)) await getEntitlements().assertCount(p.orgId!, "connectorHosts");
  await assertHostResolvesPublic(host);

  const hosts = await getOrgHostStore().add(p.orgId!, host);
  await writeAudit({
    orgId: p.orgId, ...actorOf(p), action: "connector.host_added", targetType: "org", targetId: p.orgId!,
    metadata: { host },
  });
  routeLog.info("connector host added", { orgId: p.orgId, host });
  return json({ hosts, limit, enabled: true }, { status: 201 });
});

/** DELETE /api/app/connector-hosts?host=… (the body form is accepted too, for the settings page's fetch). */
export const removeConnectorHost = connectorsRoute("connector-hosts.remove", async (req) => {
  const p = await requirePrincipal(req, { perm: "secret:write", account: true });
  const fromQuery = new URL(req.url).searchParams.get("host");
  const raw = fromQuery ?? (await readJson(req, HostBody.partial())).host;
  if (!raw) throw new BatonError("E_BAD_REQUEST", "Name the host to remove.");
  const host = normalizeConnectorHost(raw);
  const hosts = await getOrgHostStore().remove(p.orgId!, host);
  await writeAudit({
    orgId: p.orgId, ...actorOf(p), action: "connector.host_removed", targetType: "org", targetId: p.orgId!,
    metadata: { host },
  });
  return json({ hosts, limit: await orgHostLimit(p.orgId!) });
});

// ------------------------------------------------------------------------------------ the test console

/** POST /api/connectors/test {relayId, connectorId, args} (PLATFORM §6.5). */
export const testConnector = connectorsRoute("connectors.test", async (req) => {
  const p = await requirePrincipal(req, { perm: "connector:test" });
  const body = await readJson(req, TestBody);
  await enforceRates(getRateLimiter(), [
    {
      spec: CONNECTOR_TEST_RATES.visitor,
      key: p.visitorId ?? p.orgId!,
      message: "You have run the connector test 20 times today. Try again tomorrow.",
    },
  ]);
  const report = await runConsoleTest({ orgId: p.orgId!, relayId: body.relayId, connectorId: body.connectorId, args: body.args });
  await writeAudit({
    orgId: p.orgId, ...actorOf(p), action: "connector.tested", targetType: "connector", targetId: body.connectorId,
    metadata: { relayId: body.relayId, status: report.status, dryRun: report.dryRun },
  });
  return json(report);
});

/** 405 for the verbs a route file must still answer (Next would otherwise 404 with no explanation). */
export const methodNotAllowed = (allow: string): Response =>
  errorResponse("E_BAD_REQUEST", `This endpoint accepts ${allow}.`, { status: 405, headers: { allow } });
