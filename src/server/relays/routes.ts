import "server-only";

import { BatonError } from "../../core/contracts/errors";
import {
  CreateRelayRequestSchema, SaveDraftRequestSchema, UpdateRelayRequestSchema, type CreateVersionResponse,
  type ListRelaysResponse, type RelayDetail,
} from "../../core/contracts/v2";
import { getRelaySourceStore } from "../saas/ports";
import { SaasError } from "../saas/errors";
import { getRelaysDeps, relayPrincipal } from "./index";
import { json, paramsOf, readJson, relayRoute, RelayError, type RouteCtx } from "./http";
import { enforceCreateQuota, enforceSaveQuota } from "./quotas";
import { auditRelay, auditSourceSaved, captureVersionSource } from "./saas";
import { SaveSourceRequestSchema } from "./source-store";

/**
 * The `/api/relays/**` handlers (TASKS-v2 §5 "New routes", WP14b). Every route resolves the visitor's workspace from
 * the signed visitor cookie/header, seeds the gallery once per process, and answers with the `contracts/v2/api.ts`
 * shapes. `:id` is a relay id (`rl_…`) or its slug.
 *
 *   GET    /api/relays                 → ListRelaysResponse {gallery, mine}
 *   POST   /api/relays                 → RelayDetail (blank | clone | blueprint); `relay:create` quota (gallery clone exempt)
 *   GET    /api/relays/:id             → RelayDetail (owner, or read-only for gallery/unlisted); 404 across workspaces
 *   PUT    /api/relays/:id             → RelayDetail (visibility private|unlisted); `relay:save`
 *   DELETE /api/relays/:id             → 204
 *   PUT    /api/relays/:id/draft       → {rev, lint} | 409 {conflict, rev}; 422 E_LINT when the JSON fails the schema
 *   POST   /api/relays/:id/versions    → {versionId, version, hash, created}; content-addressed; `relay:save`
 *   GET    /api/relays/:id/compiled    → CompiledRelayView (?version=<rv_…>|draft); 503 until the kernel is bound
 *   GET    /api/relays/:id/source      → RelaySourceView (?format=yaml|json&version=N); WP14b·4
 *   PUT    /api/relays/:id/source      → {rev, hash, diagnostics}; 409 {rev, hash}; 422 + diagnostics; WP14b·4
 *
 * WP14b·4: every handler resolves its workspace through `relayPrincipal` → `requirePrincipal` (SAAS §2.3), so
 * `ws = principal.orgId`. Under `TENANCY_MODE=legacy` that is the same `ws_<visitorId>` v2 computed, which is why
 * the v2 route tests are unchanged; under `orgs` the same handlers are org-scoped with no second code path.
 */

type IdCtx = RouteCtx<{ id: string }>;

async function idOf(ctx: IdCtx): Promise<string> {
  const { id } = await paramsOf(ctx);
  if (!id) throw new BatonError("E_BAD_REQUEST", "Missing relay id.");
  return decodeURIComponent(id);
}

export const listRelays = relayRoute("relays.list", async (req: Request) => {
  const d = getRelaysDeps();
  const { ws } = await relayPrincipal(req, "relay:read");
  await d.ensureSeeded();
  const [gallery, mine] = await Promise.all([d.registry.listGallery(), d.registry.listMine(ws)]);
  return json({ gallery, mine } satisfies ListRelaysResponse);
});

export const createRelay = relayRoute("relays.create", async (req: Request) => {
  const d = getRelaysDeps();
  const { principal, visitor, ws } = await relayPrincipal(req, "relay:write");
  const body = await readJson(req, CreateRelayRequestSchema);
  await d.ensureSeeded();
  await enforceCreateQuota(d, visitor, ws, body);
  const detail: RelayDetail = await d.registry.create(ws, body, { createdByUserId: principal.userId });
  // SAAS §9: a clone is its own action, because "where did this relay come from" is the first question asked of a
  // workspace full of copies. `relay.imported` belongs to the source path (the store's `create`), not here.
  await auditRelay(principal, body.kind === "clone" ? "relay.cloned" : "relay.created", detail.id, {
    kind: body.kind,
    ...(body.kind === "clone" ? { from: body.relayId } : {}),
  });
  return json(detail, { status: 201 });
});

export const getRelay = relayRoute("relays.get", async (req: Request, ctx: IdCtx) => {
  const d = getRelaysDeps();
  const { ws } = await relayPrincipal(req, "relay:read");
  const id = await idOf(ctx);
  await d.ensureSeeded();
  const detail = await d.registry.get(id, ws);
  if (!detail) throw new BatonError("E_NOT_FOUND", "No such relay.");
  return json(detail);
});

export const updateRelay = relayRoute("relays.update", async (req: Request, ctx: IdCtx) => {
  const d = getRelaysDeps();
  const { visitor, ws } = await relayPrincipal(req, "relay:write");
  const id = await idOf(ctx);
  const body = await readJson(req, UpdateRelayRequestSchema);
  await d.registry.ownRow(id, ws);
  await enforceSaveQuota(d, visitor);
  return json(await d.registry.setVisibility(id, ws, body.visibility));
});

export const deleteRelay = relayRoute("relays.delete", async (req: Request, ctx: IdCtx) => {
  const d = getRelaysDeps();
  const { principal, ws } = await relayPrincipal(req, "relay:write");
  // `ownRow` first, so the audit row names the relay's id even when the path carried a slug, and so a foreign or
  // unknown id throws before anything is logged: the log never claims a deletion that did not happen. `remove`
  // resolves the same row again, which is one cheap indexed read against writing a duplicate delete here.
  const row = await d.registry.ownRow(await idOf(ctx), ws);
  await d.registry.remove(row.id, ws);
  await auditRelay(principal, "relay.deleted", row.id);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
});

export const saveDraft = relayRoute("relays.draft", async (req: Request, ctx: IdCtx) => {
  const d = getRelaysDeps();
  const { visitor, ws } = await relayPrincipal(req, "relay:write");
  const id = await idOf(ctx);
  const body = await readJson(req, SaveDraftRequestSchema);
  await d.registry.ownRow(id, ws);
  await enforceSaveQuota(d, visitor);
  const r = await d.registry.saveDraft(id, ws, body.blueprint, body.expectedRev);
  if ("conflict" in r) {
    throw new RelayError("E_DRAFT_CONFLICT", "This relay was saved elsewhere. Reload it and merge your edits.", { body: { conflict: true, rev: r.rev } });
  }
  return json(r);
});

export const createVersion = relayRoute("relays.versions", async (req: Request, ctx: IdCtx) => {
  const d = getRelaysDeps();
  const { principal, visitor, ws } = await relayPrincipal(req, "relay:write");
  const row = await d.registry.ownRow(await idOf(ctx), ws);
  await enforceSaveQuota(d, visitor);
  const r = await d.registry.snapshotVersion(row.id);
  // WP14b·4: a version keeps the author's text as it stood at snapshot time (SAAS §5.2), so a `pull` of version N
  // returns the file that was saved, comments and all — not a re-serialization of it. A deduplicated snapshot
  // leaves the existing version's source alone, which is why `r.created` is passed through.
  await captureVersionSource(row.id, r.versionId, r.created);
  await auditRelay(principal, "relay.version_created", row.id, { version: r.version, hash: r.hash, created: r.created });
  return json(r satisfies CreateVersionResponse, { status: r.created ? 201 : 200 });
});

export const getCompiled = relayRoute("relays.compiled", async (req: Request, ctx: IdCtx) => {
  const d = getRelaysDeps();
  const { ws } = await relayPrincipal(req, "relay:read");
  const id = await idOf(ctx);
  await d.ensureSeeded();
  const detail = await d.registry.get(id, ws);
  if (!detail) throw new BatonError("E_NOT_FOUND", "No such relay.");
  const want = new URL(req.url).searchParams.get("version") ?? "draft";
  let versionId: string | null = null;
  let blueprint = detail.draft;
  let lint = detail.lint;
  if (want !== "draft") {
    const v = await d.registry.getVersion(want);
    if (!v || v.relayId !== detail.id) throw new BatonError("E_NOT_FOUND", "No such version of this relay.");
    versionId = want;
    blueprint = v.blueprint;
    lint = d.registry.kernel.parse(v.blueprint).issues;
  }
  return json(await d.compileView({ relayId: detail.id, versionId, blueprint, lint, flagship: detail.flagship }));
});

/**
 * `GET /api/relays/:id/source?format=yaml|json&version=N` (SAAS §5.2, §6.2). WP14b·4.
 *
 * Readable by anyone who can read the relay, which includes the gallery: opening the Code tab on Baton or Dental
 * is how the "it is a file, not a black box" claim is checked, and it costs nothing to allow.
 */
export const getSource = relayRoute("relays.source.get", async (req: Request, ctx: IdCtx) => {
  const d = getRelaysDeps();
  const { ws } = await relayPrincipal(req, "relay:read");
  const id = await idOf(ctx);
  await d.ensureSeeded();
  const q = new URL(req.url).searchParams;
  const format = q.get("format");
  if (format !== null && format !== "yaml" && format !== "json") throw new BatonError("E_BAD_REQUEST", "format must be yaml or json.");
  const versionRaw = q.get("version");
  const version = versionRaw === null ? undefined : Number(versionRaw);
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new BatonError("E_BAD_REQUEST", "version must be a positive integer.");
  const view = await getRelaySourceStore().get(id, ws, {
    ...(version !== undefined ? { version } : {}),
    ...(format ? { format } : {}),
  });
  if (!view) throw new BatonError("E_NOT_FOUND", "No such relay.");
  return json(view);
});

/**
 * `PUT /api/relays/:id/source` (SAAS §5.2, §6.2). WP14b·4.
 *
 * Save semantics, which are the whole point of the Code tab: **zod errors do not save** (422 with the codec's
 * ranged diagnostics, so the editor can underline them), **lint errors do save** (they block Test and Publish, not
 * Save), and a stale `expectedRev` is a 409 carrying the current rev and hash rather than a silent overwrite.
 * One `relay.source_saved` audit row per rev, coalesced per user and relay (SAAS §9).
 */
export const putSource = relayRoute("relays.source.put", async (req: Request, ctx: IdCtx) => {
  const d = getRelaysDeps();
  const { principal, visitor, ws } = await relayPrincipal(req, "relay:write");
  const id = await idOf(ctx);
  const body = await readJson(req, SaveSourceRequestSchema);
  const row = await d.registry.ownRow(id, ws);
  await enforceSaveQuota(d, visitor);

  const r = await getRelaySourceStore().save(row.id, ws, body.source, body.expectedRev, viaOf(req));
  if ("conflict" in r) {
    throw new SaasError("E_CONFLICT", "This relay was saved elsewhere. Reload it and merge your edits.", {
      extra: { rev: r.rev, hash: r.hash },
    });
  }
  if (!r.ok) {
    throw new SaasError("E_UNPROCESSABLE", "This file does not match the blueprint schema; nothing was saved.", {
      diagnostics: r.diagnostics,
    });
  }
  await auditSourceSaved(principal, row.id, r.rev, r.hash, viaOf(req));
  return json({ rev: r.rev, hash: r.hash, diagnostics: r.diagnostics });
});

/** `studio` unless the caller announced itself: the CLI and the SDK send `x-changeover-client` (SAAS §9 metadata). */
function viaOf(req: Request): "studio" | "api" | "cli" {
  const c = req.headers.get("x-changeover-client")?.toLowerCase().trim();
  if (c === "cli") return "cli";
  if (c === "api" || c === "sdk") return "api";
  return "studio";
}
