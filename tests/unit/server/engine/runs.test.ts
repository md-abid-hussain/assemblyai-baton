/**
 * Relay runs on `POST /api/cases` and the server compile on `GET /api/relays/:id/compiled` (TASKS-v2 WP14b·2):
 * real Postgres, the route handlers called directly, WP3's stand-in platform and stub engine, the stub gallery
 * (flagship stand-in + "Dental deposit" with two presets), a fake WP14a kernel binding, a fake moderator and a fake
 * WP17 sim resolver. $0.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CreateCaseResponseSchema } from "@/core/contracts/api";
import type { SimCallResolutionLite } from "@/core/contracts/ext/wp14b-engine";
import {
  ApiErrorV2Schema, CompiledRelayViewSchema, CreateCaseResponseV2Schema, GALLERY_WORKSPACE, workspaceOf, type RelayDetail,
} from "@/core/contracts/v2";
import { POST as createCaseRoute } from "@/app/api/cases/route";
import { GET as compiledRoute } from "@/app/api/relays/[id]/compiled/route";
import { signVisitorId } from "@/server/auth/visitor";
import { setCasesDeps } from "@/server/cases";
import { stubEngine } from "@/server/cases/engine-stub";
import { createStubPlatform } from "@/server/cases/platform-stub";
import { MemoryCaseDataSource } from "@/server/data";
import { cases, relays } from "@/server/db/schema";
import { MemoryGallerySource, setRelaysDeps, type RelaysDeps } from "@/server/relays";
import { ModerationUnavailableError, type Moderator } from "@/server/relays/moderation";
import { callEntry, FakeExtractor, FakeVerifier, policyOf } from "../cases/helpers/fixtures";
import { createTestDb, HAS_DB, type TestDb } from "../cases/helpers/test-db";
import { ctxOf, galleryEntries, req, SECRETS, withSecrets } from "../relays/helpers";
import { fakeKernel, type FakeKernel } from "./helpers";

class FakeModerator implements Moderator {
  calls: string[] = [];
  down = false;
  async check(text: string) {
    if (this.down) throw new ModerationUnavailableError("down");
    this.calls.push(text);
    const flagged = text.includes("FLAG-ME");
    return { flagged, categories: flagged ? ["harassment"] : [] };
  }
}

describe.skipIf(!HAS_DB)("relay runs: POST /api/cases + GET /api/relays/:id/compiled", () => {
  let t: TestDb;
  let restore: () => void;
  let kernel: FakeKernel;
  let bound: FakeKernel | null;
  let moderator: FakeModerator;
  let rd: RelaysDeps;
  const sims = new Map<string, SimCallResolutionLite>();
  let n = 0;

  beforeAll(async () => {
    restore = withSecrets();
    t = await createTestDb("wp14b_runs", { poolMax: 4 });
    const data = new MemoryCaseDataSource({ policies: { s01: policyOf("s01") }, calls: [callEntry("s01_take1")] });
    setCasesDeps({
      db: t.db, engine: stubEngine, platform: createStubPlatform(), extractor: new FakeExtractor(stubEngine), verifier: new FakeVerifier(() => []),
      data, verifierEnabled: () => false,
    });
    moderator = new FakeModerator();
    rd = setRelaysDeps({
      db: t.db, gallery: new MemoryGallerySource(galleryEntries()), moderator, binding: () => bound, deployId: () => "dev-wp14b",
      calls: { getCall: (id) => data.getCall(id) },
      sims: () => ({ resolveCall: async (id) => sims.get(id) ?? null }),
    })!;
    await rd.ensureSeeded();
  });
  afterAll(async () => {
    setCasesDeps(null);
    setRelaysDeps(null);
    restore?.();
    await t?.drop();
  });
  beforeEach(() => {
    kernel = fakeKernel();
    bound = kernel;
    moderator.down = false;
  });

  function visitor() {
    n++;
    const id = `runner${n}_${Math.random().toString(36).slice(2, 8)}`;
    return { id, ws: workspaceOf(id), h: { "x-baton-visitor": signVisitorId(id, SECRETS.VISITOR_SECRET), "x-forwarded-for": `198.51.${n}.7` } };
  }
  const run = (h: Record<string, string>, body: Record<string, unknown>) => createCaseRoute(req("POST", "/api/cases", { mode: "watch", ...body }, h), undefined as never);
  const errOf = async (r: Response) => ApiErrorV2Schema.parse(await r.json()).error;
  async function galleryRow(slug: string) {
    const [row] = await t.db.select().from(relays).where(eq(relays.slug, slug));
    return row!;
  }
  async function caseRow(caseId: string) {
    const [row] = await t.db.select({ rv: cases.relayVersionId, sim: cases.simCallId }).from(cases).where(eq(cases.id, caseId));
    return row!;
  }
  async function dentalClone(ws: string, edit?: (d: RelayDetail["draft"]) => void): Promise<RelayDetail> {
    const c = await rd.registry.create(ws, { kind: "clone", relayId: (await galleryRow("dental-deposit")).id });
    if (!edit) return c;
    const bp = structuredClone(c.draft);
    edit(bp);
    const r = await rd.registry.saveDraft(c.id, ws, bp, c.draftRev);
    expect(r).not.toHaveProperty("conflict");
    return (await rd.registry.get(c.id, ws))!;
  }

  it("flagship relay run: the case records its version; the response adds UiSpec, listening, account and provenance", async () => {
    const v = visitor();
    const flag = await galleryRow("baton-add-driver");
    const r = await run(v.h, { callId: "s01_take1", relayId: "baton-add-driver" });
    expect(r.status).toBe(200);
    const body = CreateCaseResponseV2Schema.parse(await r.json());
    expect(body.relay.relay).toMatchObject({ id: flag.id, versionId: flag.currentVersionId, slug: "baton-add-driver", flagship: true, simulated: false });
    expect(body.simulated).toBe(false);
    expect(body.provenance).toMatchObject({ humanHalf: "recorded", customerInAiHalf: "recorded", detail: null });
    expect(body.account.customer.firstName).toBe(body.policy!.policyholder.firstName);
    expect(body.listening.keyterms).toContain(body.account.customer.firstName);
    expect(body.call).toEqual(callEntry("s01_take1")); // the plain manifest entry, no catalog keys
    expect(await caseRow(body.caseId)).toEqual({ rv: flag.currentVersionId, sim: null });
    expect(kernel.compiles).toEqual([{ versionId: flag.currentVersionId, relayId: flag.id, hash: expect.any(String), flagship: true }]);
    // the engine LRU: a second run compiles nothing
    expect((await run(v.h, { callId: "s01_take1", relayVersionId: flag.currentVersionId })).status).toBe(200);
    expect(kernel.compiles).toHaveLength(1);
  });

  it("a plain Baton run keeps v1 without a kernel and gains the v2 fields (forVersion(null)) with one", async () => {
    const v = visitor();
    bound = null;
    const plain = (await (await run(v.h, { callId: "s01_take1" })).json()) as Record<string, unknown>;
    expect(CreateCaseResponseSchema.parse(plain).call?.callId).toBe("s01_take1");
    expect(plain).not.toHaveProperty("relay");
    bound = kernel;
    const withKernel = CreateCaseResponseV2Schema.parse(await (await run(v.h, { callId: "s01_take1" })).json());
    expect(withKernel.relay.relay).toMatchObject({ versionId: null, id: null, flagship: true, slug: "baton-add-driver" });
    expect(await caseRow(withKernel.caseId)).toEqual({ rv: null, sim: null });
  });

  it("without a kernel a relay run is 503 E_MAINTENANCE, but access is checked first (404)", async () => {
    const v = visitor();
    bound = null;
    const r = await run(v.h, { callId: "s01_take1", relayId: "baton-add-driver" });
    expect(r.status).toBe(503);
    expect((await errOf(r)).code).toBe("E_MAINTENANCE");
    expect((await run(v.h, { relayId: "no-such-relay" })).status).toBe(404);
    expect((await run(v.h, { relayVersionId: "rv_nope" })).status).toBe(404);
  });

  it("a gallery preset version resolves, is pre-cleared by its seed moderation, compiles, then waits for the Dental path (503)", async () => {
    const v = visitor();
    const dental = (await rd.registry.get((await galleryRow("dental-deposit")).id, v.ws))!;
    const preset = dental.presets.find((p) => p.id === "add_insurer")!;
    const before = moderator.calls.length;
    const r = await run(v.h, { relayVersionId: preset.versionId });
    expect(r.status).toBe(503);
    expect((await errOf(r)).message).toMatch(/other than Baton/);
    expect(kernel.compiles.map((c) => c.versionId)).toEqual([preset.versionId]);
    expect(moderator.calls.length).toBe(before); // seeded text is never sent out
    // relayId + a version of another relay → 404
    expect((await run(v.h, { relayId: "baton-add-driver", relayVersionId: preset.versionId })).status).toBe(404);
  });

  it("moderation before a version's first run: flagged → 422 E_MODERATION_FLAGGED with categories, nothing compiled; cached", async () => {
    const v = visitor();
    const c = await dentalClone(v.ws, (bp) => {
      bp.playbook.persona.tone = "FLAG-ME please";
    });
    const r = await run(v.h, { relayId: c.id });
    expect(r.status).toBe(422);
    const body = (await r.json()) as { categories: string[]; error: { code: string } };
    expect(body.error.code).toBe("E_MODERATION_FLAGGED");
    expect(body.categories).toEqual(["harassment"]);
    expect(kernel.compiles).toEqual([]);
    const calls = moderator.calls.length;
    expect((await run(v.h, { relayId: c.id })).status).toBe(422);
    expect(moderator.calls.length).toBe(calls); // once per version
  });

  it("moderation down: a Test run of a clone fails open (unstored); a user-authored relay fails closed", async () => {
    const v = visitor();
    moderator.down = true;
    const clone = await dentalClone(v.ws, (bp) => {
      bp.meta.title = "Brightwater front desk";
    });
    const open = await run(v.h, { relayId: clone.id });
    expect(open.status).toBe(503); // passed moderation (fail open) and compiled; the non-Baton gate answers
    expect(kernel.compiles.map((x) => x.relayId)).toEqual([clone.id]);
    const blank = await rd.registry.create(v.ws, { kind: "blank", industry: "other" });
    kernel.compiles.length = 0;
    const closed = await run(v.h, { relayId: blank.id });
    expect(closed.status).toBe(503);
    expect((await errOf(closed)).message).toMatch(/could not check/);
    expect(kernel.compiles).toEqual([]);
    moderator.down = false;
    const vid = (await rd.registry.snapshotVersion(clone.id)).versionId;
    expect(await rd.registry.moderateForRun(vid, "test")).toMatchObject({ via: "openai", flagged: false });
  });

  it("workspace isolation: another visitor's private relay and version are 404; an unlisted one runs", async () => {
    const a = visitor();
    const b = visitor();
    const c = await dentalClone(a.ws);
    const vid = (await rd.registry.snapshotVersion(c.id)).versionId;
    expect((await run(b.h, { relayId: c.id })).status).toBe(404);
    expect((await run(b.h, { relayVersionId: vid })).status).toBe(404);
    await rd.registry.setVisibility(c.id, a.ws, "unlisted");
    expect((await run(b.h, { relayVersionId: vid })).status).toBe(503); // visible now; non-Baton gate
    expect(kernel.compiles.map((x) => x.versionId)).toEqual([vid]);
  });

  it("sims through the CallCatalog: a gallery sim runs with its sample and provenance; a private DB sim of another workspace is 404", async () => {
    const v = visitor();
    const flag = await galleryRow("baton-add-driver");
    const fv = await rd.registry.runVersion(flag.currentVersionId!);
    sims.set("sim_flag1", {
      entry: callEntry("sim_flag1", { source: "twilio8k", featured: false, picker: "hidden", inEval: false }),
      simulated: true, relayVersionId: null, relay: { slug: "baton-add-driver", title: "Baton", blueprintHash: fv!.hash }, sampleIndex: 0, gallery: true,
    });
    const r = await run(v.h, { callId: "sim_flag1", relayId: "baton-add-driver" });
    expect(r.status).toBe(200);
    const body = CreateCaseResponseV2Schema.parse(await r.json());
    expect(body).toMatchObject({ simulated: true, provenance: { humanHalf: "simulated", customerInAiHalf: "synthetic" } });
    expect(body.relay.relay.simulated).toBe(true);
    expect(body.account).toEqual(fv!.blueprint.context.samples[0]);
    expect(await caseRow(body.caseId)).toEqual({ rv: flag.currentVersionId, sim: "sim_flag1" });

    const owner = visitor();
    const c = await dentalClone(owner.ws);
    const vid = (await rd.registry.snapshotVersion(c.id)).versionId;
    sims.set("sim_private", { ...sims.get("sim_flag1")!, entry: callEntry("sim_private"), relayVersionId: vid, gallery: false });
    const other = await run(v.h, { callId: "sim_private", relayId: "baton-add-driver" });
    expect(other.status).toBe(404);
    expect((await errOf(other)).message).toBe("Unknown call.");
  });

  it("GET /compiled: the server compile of the draft and of a version; lint errors → 422; a gallery flagship compiles as flagship", async () => {
    const v = visitor();
    const c = await dentalClone(v.ws);
    const draft = await compiledRoute(req("GET", `/api/relays/${c.id}/compiled`, undefined, v.h), ctxOf(c.id));
    expect(draft.status).toBe(200);
    const dv = CompiledRelayViewSchema.parse(await draft.json());
    expect(dv).toMatchObject({ relayId: c.id, versionId: null, kernelVersion: "kernel-test", firstUpdate: { ok: true, reason: null } });
    expect(dv.hash).toBe(rd.registry.kernel.hash(c.draft));
    const vid = (await rd.registry.snapshotVersion(c.id)).versionId;
    const ver = CompiledRelayViewSchema.parse(await (await compiledRoute(req("GET", `/api/relays/${c.id}/compiled?version=${vid}`, undefined, v.h), ctxOf(c.id))).json());
    expect(ver.versionId).toBe(vid);
    expect(ver.hash).toBe(dv.hash);
    const flag = await galleryRow("baton-add-driver");
    const fvw = CompiledRelayViewSchema.parse(await (await compiledRoute(req("GET", `/api/relays/${flag.id}/compiled`, undefined, v.h), ctxOf(flag.id))).json());
    expect(fvw.ui.relay.flagship).toBe(true);
    expect(flag.workspaceId).toBe(GALLERY_WORKSPACE);
    // lint errors (a kernel whose parse reports one) → 422 E_LINT on the compiled view and on a run, never a compile
    const lintDeps = setRelaysDeps({
      db: t.db, gallery: new MemoryGallerySource(galleryEntries()), moderator, binding: () => bound,
      kernel: { ...rd.registry.kernel, parse: (j) => ({ ...rd.registry.kernel.parse(j), issues: [{ code: "L1", severity: "error", path: ["fields"], message: "x" }] }) },
    })!;
    try {
      const bad = await compiledRoute(req("GET", `/api/relays/${c.id}/compiled?version=${vid}`, undefined, v.h), ctxOf(c.id));
      expect(bad.status).toBe(422);
      expect((await errOf(bad)).code).toBe("E_LINT");
      const badRun = await run(v.h, { relayVersionId: vid });
      expect(badRun.status).toBe(422);
      expect((await errOf(badRun)).lint?.[0]).toMatchObject({ code: "L1" });
      expect(lintDeps.engine.cachedKeys()).toEqual([]);
    } finally {
      rd = setRelaysDeps({
        db: t.db, gallery: new MemoryGallerySource(galleryEntries()), moderator, binding: () => bound, deployId: () => "dev-wp14b",
        sims: () => ({ resolveCall: async (id) => sims.get(id) ?? null }),
      })!;
    }
  });
});
