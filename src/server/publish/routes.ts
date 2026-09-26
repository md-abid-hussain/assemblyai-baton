import "server-only";

/**
 * server/publish/routes.ts - WP18's route handlers (TASKS-v2 §5 "New routes"; PLATFORM §8; SAAS §2.5).
 *
 *   POST   /api/relays/:id/publish                                → PublishResponse (201)        `relay:publish`
 *   DELETE /api/publications/:pubId                               → 204                          `relay:publish`
 *   GET    /api/publications/:slug                                → PublicationPageView          public + device
 *   GET    /api/publications/:pubId/runs/:takeoverId/state?after= → PublishedRunState            the run's device
 *   POST   /api/connectors/pub/:pubId/:tool                       → the tool result JSON         publication key
 *
 * **Every org route resolves its principal here and nowhere else** (SAAS §10.1 rule 1): publish and unpublish need
 * `relay:publish` (admin+ in an org; the legacy visitor is `owner` of `ws_<visitorId>`, so v2 behaviour is unchanged),
 * and the org acted in is `principal.orgId` — never a body, query or header value.
 *
 * The gateway is authenticated by the publication key instead: AssemblyAI's servers carry no cookie and no session.
 */
import { BatonError } from "../../core/contracts/errors";
import { ID_PREFIXES, type PublicationPageView, type PublishResponse } from "../../core/contracts/v2";
import type { UiSpec } from "../../core/contracts/v2/relay";
import { batonErrorResponse, errorResponse, json, paramsOf, type RouteCtx } from "../auth/http";
import { EnvError } from "../env";
import { log } from "../log";
import { enforceRates, type RateSpec } from "../limits/rate-limiter";
import { isRelayError, relayErrorResponse } from "../relays/http";
import { isSaasError, saasErrorResponse } from "../saas/errors";
import { requirePrincipal } from "../saas/principal";
import { getPublishDeps } from "./deps";
import { PublishGateway } from "./gateway";
import { actorOf, PgPublisher, PUBLISH_LIMITS } from "./service";
import { readPublishedRunState } from "./state";

const routeLog = log.child({ component: "publish-http" });

/** PLATFORM §8.4 / SAAS §4.1: the global daily publish limit is the hard stop; the plan count is the per-org one. */
export const PUBLISH_RATES = {
  visitor: { bucket: "publish", limit: PUBLISH_LIMITS.publishesPerVisitorPerDay, windowSec: 86_400 },
  global: { bucket: "publish:global", limit: PUBLISH_LIMITS.publishesPerDayGlobal, windowSec: 86_400 },
} as const satisfies Record<string, RateSpec>;

export const publisherOf = (): PgPublisher => new PgPublisher(getPublishDeps());

/** The v1/v2/v3 error envelopes side by side: a v2 route may now throw a `SaasError` (a plan limit, a 401, a 403). */
export function publishRoute<P extends Record<string, string>>(
  name: string,
  fn: (req: Request, ctx: RouteCtx<P>) => Promise<Response>,
): (req: Request, ctx: RouteCtx<P>) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (isSaasError(e)) return saasErrorResponse(e);
      if (isRelayError(e)) return relayErrorResponse(e);
      if (e instanceof BatonError) return batonErrorResponse(e);
      if (e instanceof EnvError) {
        routeLog.error("route misconfigured", { route: name, err: e });
        return errorResponse("E_INTERNAL", "The server is missing configuration.", { status: 503 });
      }
      routeLog.error("route failed", { route: name, err: e });
      return errorResponse("E_INTERNAL", "Something went wrong on our side.");
    }
  };
}

const paramOf = async <P extends Record<string, string>>(ctx: RouteCtx<P>, key: keyof P): Promise<string> => {
  const p = await paramsOf(ctx);
  const v = p[key];
  if (!v) throw new BatonError("E_BAD_REQUEST", `Missing ${String(key)}.`);
  return decodeURIComponent(v);
};

// ============================================================================================ publish / unpublish

/** POST /api/relays/:id/publish (PLATFORM §8.1). Mounted by WP14b under `src/app/api/relays/[id]/publish/route.ts`. */
export const publishRelay = publishRoute("publications.publish", async (req: Request, ctx: RouteCtx<{ id: string }>) => {
  const p = await requirePrincipal(req, { perm: "relay:publish" });
  const d = getPublishDeps();
  const relayId = await paramOf(ctx, "id");
  await enforceRates(d.rateLimiter(), [
    { spec: PUBLISH_RATES.visitor, key: p.visitorId, message: "You have published a lot today. Try again tomorrow." },
    { spec: PUBLISH_RATES.global, key: "all", message: "This demo has published its daily limit of agents. Try again tomorrow." },
  ]);
  const r = await publisherOf().publishFor(relayId, actorOf(p));
  return json(
    {
      shareUrl: r.shareUrl,
      agentId: r.view.agentId,
      version: r.version,
      configRedacted: r.configRedacted,
      publication: r.view,
    } satisfies PublishResponse,
    { status: 201 },
  );
});

/** DELETE /api/publications/:pubId (the agent is deleted; the share link stops working). */
export const deletePublication = publishRoute("publications.delete", async (req: Request, ctx: RouteCtx<{ id: string }>) => {
  const p = await requirePrincipal(req, { perm: "relay:publish" });
  const id = await paramOf(ctx, "id");
  if (!id.startsWith(ID_PREFIXES.publication)) throw new BatonError("E_NOT_FOUND", "No such publication.");
  await publisherOf().unpublishFor(id, actorOf(p));
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
});

// ============================================================================================ the share page

/** GET /api/publications/:slug - the `/a/[shareSlug]` page data. Public: no session, and the mic is never enabled. */
export const getPublication = publishRoute("publications.get", async (_req: Request, ctx: RouteCtx<{ id: string }>) => {
  const d = getPublishDeps();
  const publisher = publisherOf();
  const ref = await paramOf(ctx, "id");
  const j = ref.startsWith(ID_PREFIXES.publication) ? await publisher.byId(ref) : await publisher.joinBySlug(ref);
  if (!j || j.pub.deletedAt || j.pub.status === "deleted" || j.pub.status === "failed") {
    throw new BatonError("E_NOT_FOUND", "This share link is not live any more.");
  }
  let ui: UiSpec;
  try {
    ui = (await d.engine.forVersion(j.versionId)).ui;
  } catch {
    throw new BatonError("E_MAINTENANCE", "This published relay cannot be shown right now.");
  }
  const gallery = j.visibility === "gallery";
  const view: PublicationPageView = {
    publication: publisher.view(j, await publisher.fullRedactedConfig(j).catch(() => undefined)),
    relay: {
      id: j.relayId,
      slug: j.relaySlug,
      title: j.relayTitle,
      tagline: j.blueprint.meta.tagline,
      industry: j.blueprint.meta.industry,
      flagship: j.flagship,
      gallery,
    },
    banner: gallery ? null : "User-made relay · fictional business",
    ui,
    calls: [],
    inUse: publisher.activeRunOf(j.pub) !== null,
  };
  return json(view);
});

// ============================================================================================ the one state route

/** GET /api/publications/:pubId/runs/:takeoverId/state?after=<cursor> (PLATFORM §8.3; polled every 1 s). */
export const getPublicationRunState = publishRoute(
  "publications.state",
  async (req: Request, ctx: RouteCtx<{ id: string; takeoverId: string }>) => {
    const p = await requirePrincipal(req, { allowVisitor: true });
    const pubId = await paramOf(ctx, "id");
    const takeoverId = await paramOf(ctx, "takeoverId");
    const afterRaw = Number(new URL(req.url).searchParams.get("after") ?? "0");
    const after = Number.isFinite(afterRaw) && afterRaw > 0 ? Math.floor(afterRaw) : 0;
    const r = await readPublishedRunState(getPublishDeps(), publisherOf(), { publicationId: pubId, takeoverId, after, visitorId: p.visitorId });
    if (r.kind === "not_found") throw new BatonError("E_NOT_FOUND", "No such published run.");
    if (r.kind === "forbidden") throw new BatonError("E_FORBIDDEN", "This run belongs to another visitor.");
    return json(r.state);
  },
);

// ============================================================================================ the gateway

/**
 * POST /api/connectors/pub/:pubId/:tool - AssemblyAI's stored agent calls this. The body is the raw args object and
 * the only credential is `X-Changeover-Key` (WP18·0 P-2: no provider id header, no signature).
 */
export const postPubTool = publishRoute("publications.tool", async (req: Request, ctx: RouteCtx<{ pubId: string; tool: string }>) => {
  const d = getPublishDeps();
  const pubId = await paramOf(ctx, "pubId");
  const tool = await paramOf(ctx, "tool");
  let args: unknown = {};
  try {
    const text = await req.text();
    args = text.trim() ? JSON.parse(text) : {};
  } catch {
    args = null;
  }
  const answer = await new PublishGateway(d, publisherOf()).handle({
    publicationId: pubId,
    tool,
    key: PublishGateway.keyOf(req.headers),
    args,
    origin: d.appUrl() ?? new URL(req.url).origin,
  });
  return json(answer.body, { status: answer.status });
});
