/**
 * server/draft/routes.ts - `POST /api/drafts` and `GET /api/drafts/:id` (PLATFORM §7.4; WP17·3).
 *
 *   POST  → 202 `{draftId, status:"queued", step:null, …}` immediately; the work runs as a job.
 *   GET   → the same `DraftView`, polled every 1.5 s, with `step` ("drafting", "repair 1", "creating"), the notes,
 *           the lint and the relay id once it exists.
 *
 * A draft belongs to an org: `GET` is scoped by `orgId`, so another org's draft id simply does not exist (404).
 */
import "server-only";

import { CreateDraftRequestSchema, type DraftView } from "../../core/contracts/v2";
import { DRAFT_ETA_SEC, getDrafter } from "./index";
import { json, readJson, wp17Principal, wp17Route, type RouteCtx } from "./http";

/** 202: the client polls. `etaSec` is what the wizard's progress bar is scaled to. */
const queued = (view: DraftView): Response => json({ ...view, etaSec: DRAFT_ETA_SEC }, { status: 202 });

export const handleCreateDraft = wp17Route("drafts.create", async (req: Request) => {
  const who = await wp17Principal(req, "relay:write");
  const input = await readJson(req, CreateDraftRequestSchema);
  const view = await getDrafter().start(input, { ws: who.ws, visitorId: who.visitorId, ipKey: who.ipKey });
  return queued(view);
});

export const handleGetDraft = wp17Route<{ id: string }>("drafts.get", async (req: Request, ctx: RouteCtx<{ id: string }>) => {
  const who = await wp17Principal(req, "relay:read");
  const { id } = await ctx.params;
  const view = await getDrafter().get(id, who.ws);
  if (!view) return json({ error: { code: "E_NOT_FOUND", message: "There is no such draft." } }, { status: 404 });
  return json(view);
});
