import "server-only";

/**
 * `GET|POST /api/secrets` and `DELETE /api/secrets/:id` (PLATFORM §6.4; SAAS §2.5, §4.1, §9). WP16·3.
 *
 * **A value goes in and never comes out.** The POST answers with `{id, name, createdAt, expiresAt}`, the list
 * answers with the same metadata, the audit row carries the name and never the value, and the error messages are
 * written so that no refusal can echo one back.
 *
 * Scoping: `requirePrincipal` decides the workspace — `secret:read` to list, `secret:write` to put or delete
 * (admin+, SAAS §3.7) — and the store is asked for `p.orgId` only, so one org can never see, overwrite or delete
 * another's secret. A `sec_…` id that belongs to someone else is simply not found in this workspace, which is a
 * 404 by construction rather than by a check.
 *
 * Limits, in the SAAS §4.2 order: the device rate limit (abuse), then the plan count (`Entitlements.assertCount`,
 * 402 with the upgrade line), then the store's own hard stop (`E_SECRET_LIMIT`, 429) and its 1 KiB / name rules
 * (`E_BAD_REQUEST`, 400).
 */
import { z } from "zod";

import { BatonError } from "../../core/contracts/errors";
import { ID_PREFIXES, V2_ERROR_STATUS } from "../../core/contracts/v2/api";
import { handler, json, paramsOf, readJson, type RouteCtx } from "../auth/http";
import { writeAudit } from "../identity/audit-hook";
import { getRateLimiter } from "../limits";
import { enforceRates, type RateSpec } from "../limits/rate-limiter";
import { log } from "../log";
import { isSaasError, saasErrorResponse } from "../saas/errors";
import { getEntitlements } from "../saas/ports";
import { requirePrincipal } from "../saas/principal";
import type { Principal } from "../../core/contracts/v3/identity";
import { installConnectorPorts } from "../connectors/install";
import { getSecretStore } from "./index";
import { SecretError } from "./store";

const routeLog = log.child({ component: "secrets-http" });

/** SAAS §10.4: a device may set a lot of secrets in a working session, but not thousands. */
export const SECRET_RATES = {
  put: { bucket: "secret:put", limit: 60, windowSec: 3600 },
} as const satisfies Record<string, RateSpec>;

const PutSecretBody = z.object({
  name: z.string().min(1).max(40),
  value: z.string().min(1).max(4096),
});

/** The v1/v2/v3 envelopes side by side, plus `SecretError` → 400 / 429 (contracts/v2 `V2_ERROR_STATUS`). */
function secretsRoute<P extends Record<string, string>>(
  name: string,
  fn: (req: Request, ctx: RouteCtx<P>) => Promise<Response>,
): (req: Request, ctx: RouteCtx<P>) => Promise<Response> {
  return handler<P>(name, async (req, ctx) => {
    installConnectorPorts();
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (isSaasError(e)) return saasErrorResponse(e);
      if (e instanceof SecretError) {
        // The v2 envelope with the v2 status (`V2_ERROR_STATUS`): 429 for the count, 400 for a name or a size.
        const status = e.code === "E_SECRET_LIMIT" ? V2_ERROR_STATUS.E_SECRET_LIMIT : 400;
        return json({ error: { code: e.code, message: e.message } }, { status });
      }
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

/** GET /api/secrets — names, ids and dates. Never a value, and never another workspace's row. */
export const listSecrets = secretsRoute("secrets.list", async (req) => {
  const p = await requirePrincipal(req, { perm: "secret:read" });
  const secrets = await getSecretStore().list(p.orgId!);
  return json({ secrets });
});

/** POST /api/secrets {name, value} → `{id, name, createdAt, expiresAt}`. Re-putting a name keeps its id. */
export const putSecret = secretsRoute("secrets.put", async (req) => {
  const p = await requirePrincipal(req, { perm: "secret:write" });
  const body = await readJson(req, PutSecretBody);
  await enforceRates(getRateLimiter(), [
    { spec: SECRET_RATES.put, key: p.visitorId ?? p.orgId!, message: "You have set a lot of secrets in the last hour. Try again shortly." },
  ]);
  const store = getSecretStore();
  const existing = (await store.list(p.orgId!)).find((s) => s.name === body.name);
  // A replacement does not consume a new slot, so the plan check runs for new names only (SAAS §4.2).
  if (!existing) await getEntitlements().assertCount(p.orgId!, "secrets");

  const meta = await store.put(p.orgId!, body.name, body.value);
  await writeAudit({
    orgId: p.orgId,
    ...actorOf(p),
    action: "secret.created",
    targetType: "secret",
    targetId: meta.id,
    metadata: { name: meta.name, replaced: !!existing },
  });
  routeLog.info("secret set", { orgId: p.orgId, id: meta.id, replaced: !!existing });
  return json(meta, { status: existing ? 200 : 201 });
});

/** DELETE /api/secrets/:id. Deleting a foreign or unknown id is a no-op with a 204: nothing is disclosed. */
export const deleteSecret = secretsRoute<{ id: string }>("secrets.delete", async (req, ctx) => {
  const p = await requirePrincipal(req, { perm: "secret:write" });
  const id = (await paramsOf(ctx)).id;
  if (!id || !id.startsWith(ID_PREFIXES.secret)) throw new BatonError("E_BAD_REQUEST", "That is not a secret id.");
  await getSecretStore().remove(p.orgId!, id);
  await writeAudit({ orgId: p.orgId, ...actorOf(p), action: "secret.deleted", targetType: "secret", targetId: id });
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
});
