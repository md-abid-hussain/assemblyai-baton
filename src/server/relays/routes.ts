import "server-only";

import { BatonError } from "../../core/contracts/errors";
import {
  CreateRelayRequestSchema, SaveDraftRequestSchema, UpdateRelayRequestSchema, type CreateVersionResponse,
  type ListRelaysResponse, type RelayDetail,
} from "../../core/contracts/v2";
import { getRelaysDeps, workspaceFor } from "./index";
import { json, paramsOf, readJson, relayRoute, RelayError, type RouteCtx } from "./http";
import { enforceCreateQuota, enforceSaveQuota } from "./quotas";

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
 */

type IdCtx = RouteCtx<{ id: string }>;

async function idOf(ctx: IdCtx): Promise<string> {
  const { id } = await paramsOf(ctx);
  if (!id) throw new BatonError("E_BAD_REQUEST", "Missing relay id.");
  return decodeURIComponent(id);
}

export const listRelays = relayRoute("relays.list", async (req: Request) => {
  const d = getRelaysDeps();
  const { ws } = workspaceFor(d, req);
  await d.ensureSeeded();
  const [gallery, mine] = await Promise.all([d.registry.listGallery(), d.registry.listMine(ws)]);
  return json({ gallery, mine } satisfies ListRelaysResponse);
});

export const createRelay = relayRoute("relays.create", async (req: Request) => {
  const d = getRelaysDeps();
  const { visitor, ws } = workspaceFor(d, req);
  const body = await readJson(req, CreateRelayRequestSchema);
  await d.ensureSeeded();
  await enforceCreateQuota(d, visitor, ws, body);
  const detail: RelayDetail = await d.registry.create(ws, body);
  return json(detail, { status: 201 });
});

export const getRelay = relayRoute("relays.get", async (req: Request, ctx: IdCtx) => {
  const d = getRelaysDeps();
  const { ws } = workspaceFor(d, req);
  const id = await idOf(ctx);
  await d.ensureSeeded();
  const detail = await d.registry.get(id, ws);
  if (!detail) throw new BatonError("E_NOT_FOUND", "No such relay.");
  return json(detail);
});

export const updateRelay = relayRoute("relays.update", async (req: Request, ctx: IdCtx) => {
  const d = getRelaysDeps();
  const { visitor, ws } = workspaceFor(d, req);
  const id = await idOf(ctx);
  const body = await readJson(req, UpdateRelayRequestSchema);
  await d.registry.ownRow(id, ws);
  await enforceSaveQuota(d, visitor);
  return json(await d.registry.setVisibility(id, ws, body.visibility));
});

export const deleteRelay = relayRoute("relays.delete", async (req: Request, ctx: IdCtx) => {
  const d = getRelaysDeps();
  const { ws } = workspaceFor(d, req);
  await d.registry.remove(await idOf(ctx), ws);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
});

export const saveDraft = relayRoute("relays.draft", async (req: Request, ctx: IdCtx) => {
  const d = getRelaysDeps();
  const { visitor, ws } = workspaceFor(d, req);
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
  const { visitor, ws } = workspaceFor(d, req);
  const row = await d.registry.ownRow(await idOf(ctx), ws);
  await enforceSaveQuota(d, visitor);
  const r = await d.registry.snapshotVersion(row.id);
  return json(r satisfies CreateVersionResponse, { status: r.created ? 201 : 200 });
});

export const getCompiled = relayRoute("relays.compiled", async (req: Request, ctx: IdCtx) => {
  const d = getRelaysDeps();
  const { ws } = workspaceFor(d, req);
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
