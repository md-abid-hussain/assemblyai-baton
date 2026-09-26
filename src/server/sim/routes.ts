/**
 * server/sim/routes.ts - the simulated-call asset route `GET /api/sim-calls/:id/:file` (PLATFORM §7.5 step 4).
 *
 * Files: `rep.ulaw`, `customer.ulaw` (raw 8 kHz mu-law), `peaks.json`, and `clip.<sha256>.pcm` (24 kHz PCM16 AI-half
 * clips the sim references). The id is content-addressed, so a found file is served
 * `Cache-Control: public, max-age=31536000, immutable` with a strong ETag (304 on `If-None-Match`). Unknown ids and
 * files are 404 `no-store`. Public by design: sims are fictional people; no visitor scope.
 */
import "server-only";

import { SIM_CALL_ID_RE, SIM_CLIP_FILE_RE, type SimCallStore } from "../../core/contracts/ext/wp17-sim";
import { CreateSimCallRequestSchema, SIM_CALL_FILES } from "../../core/contracts/v2/api";
import { json, readJson, wp17Principal, wp17Route } from "../draft/http";
import { errorResponse, handler, type RouteCtx } from "../auth/http";
import { getSimCallStore } from "./defaults";
import { getSimCallService } from "./service";

export const IMMUTABLE = "public, max-age=31536000, immutable";

const isAssetFile = (file: string): boolean => (SIM_CALL_FILES as readonly string[]).includes(file) || SIM_CLIP_FILE_RE.test(file);

export async function serveSimCallAsset(req: Request, id: string, file: string, store: SimCallStore = getSimCallStore()): Promise<Response> {
  const notFound = () => errorResponse("E_NOT_FOUND", "There is no such simulated call file.", { headers: { "cache-control": "no-store" } });
  if (!SIM_CALL_ID_RE.test(id) || !isAssetFile(file)) return notFound();
  const etag = `"${id}/${file}"`;
  const cacheHeaders = { "cache-control": IMMUTABLE, etag, "x-content-type-options": "nosniff" };
  const inm = req.headers.get("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) {
    // Only claim "not modified" for files that still exist (a purged sim must not look alive); metadata only.
    const rec = await store.get(id);
    const clip = SIM_CLIP_FILE_RE.exec(file)?.[1];
    const exists = !!rec && (clip ? Object.values(rec.aiClips).some((c) => c.hash === clip) : rec.hasAudio);
    return exists ? new Response(null, { status: 304, headers: cacheHeaders }) : notFound();
  }
  const a = await store.asset(id, file);
  if (!a) return notFound();
  const body = new Uint8Array(a.bytes);
  return new Response(body, { status: 200, headers: { ...cacheHeaders, "content-type": a.contentType, "content-length": String(body.byteLength) } });
}

export const handleSimCallAsset = handler<{ id: string; file: string }>("sim-calls.asset", async (req: Request, ctx: RouteCtx<{ id: string; file: string }>) => {
  const { id, file } = await ctx.params;
  return serveSimCallAsset(req, id, file);
});

// ============================================================================================ WP17·3: the API

/**
 * `POST /api/sim-calls` and `GET /api/sim-calls/:id` (PLATFORM §7.5, §7.5.2).
 *
 * POST answers 202 `{simCallId, status, etaSec}` at once - `ready` when the same relay version, sample and day was
 * already simulated (it then costs $0), `generating` otherwise - and the client polls GET until `ready` or `failed`.
 * Both are org-scoped through `wp17Principal`; the relay must be one this org may run.
 */
export const handleCreateSimCall = wp17Route("sim-calls.create", async (req: Request) => {
  const who = await wp17Principal(req, "run:start");
  const body = await readJson(req, CreateSimCallRequestSchema);
  const out = await getSimCallService().request({ ...body, ws: who.ws, visitorId: who.visitorId, ipKey: who.ipKey });
  return json(out, { status: out.status === "ready" ? 200 : 202 });
});

export const handleGetSimCall = wp17Route<{ id: string }>("sim-calls.get", async (req: Request, ctx: RouteCtx<{ id: string }>) => {
  await wp17Principal(req, "run:read");
  const { id } = await ctx.params;
  const view = await getSimCallService().get(id);
  if (!view) return json({ error: { code: "E_NOT_FOUND", message: "There is no such simulated call." } }, { status: 404 });
  return json(view);
});
