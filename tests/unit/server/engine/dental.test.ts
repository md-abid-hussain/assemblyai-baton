/**
 * The Dental server path END TO END (TASKS-v2 WP14b T3, acceptance 4; PLATFORM §4.7, §5, §7.5.3), over real Postgres
 * with the REAL WP14a kernel (`compileRelay`) and the REAL WP1 case engine — no fakes except the upstreams:
 * OpenAI is a local `Extractor` that returns a patch, and no audio, STT or Voice Agent is touched. $0.
 *
 * This is the test the WP14b·2 notes deferred ("the extractor and verifier through `compiled.extractor` … the blocker
 * is the P§4.7 widening"). What it pins:
 *   1. a non-flagship relay version runs at all (the 503 gate is gone);
 *   2. its case row is a RELAY row — `intent:"relay"`, an `AccountRecord` in `cases.policy`, `relay_version_id` set —
 *      and the response carries the Dental `UiSpec`, listening, account and provenance with `policy: null`;
 *   3. extraction goes through `compiled.extractor`: the relay's prompt, its strict `<intent>_patch` schema, and its
 *      spec for post-processing, so the derived state holds DENTAL field ids and Baton's 21 never appear;
 *   4. a Baton case on the same server is untouched and still runs the flagship engine;
 *   5. the "add a field" preset (P§7.5.3) really adds the field — the AI's case card has `insurance_carrier`, and its
 *      extractor pin differs from the base relay's, which is what makes Express re-extract instead of serving a cache.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ExtractResponse } from "@/core/contracts/api";
import type { RawPatchEvent } from "@/core/contracts/extract";
import type { Extractor } from "@/core/contracts/services";
import { turnIdOf, type TurnInput } from "@/core/contracts/turns";
import { CreateCaseResponseV2Schema, workspaceOf, type Blueprint, type RelayDetail } from "@/core/contracts/v2";
import { POST as createCaseRoute } from "@/app/api/cases/route";
import { POST as extractRoute } from "@/app/api/extract/route";
import { signVisitorId } from "@/server/auth/visitor";
import { setCasesDeps } from "@/server/cases";
import { defaultEngine } from "@/server/cases/defaults";
import type { ExtractorEngine, RelayExtractTurnInput } from "@/server/openai/extractor";
import { createStubPlatform } from "@/server/cases/platform-stub";
import { MemoryCaseDataSource } from "@/server/data";
import { cases, relays } from "@/server/db/schema";
import { MemoryGallerySource, setRelaysDeps, type RelaysDeps } from "@/server/relays";
import type { Moderator } from "@/server/relays/moderation";
import { callEntry, FakeVerifier, policyOf } from "../cases/helpers/fixtures";
import { createTestDb, HAS_DB, type TestDb } from "../cases/helpers/test-db";
import { galleryEntries, req, SECRETS, withSecrets } from "../relays/helpers";

/** The gallery as this test sees it: the mini dental blueprint under the Dental slug, plus the flagship stand-in. */
const DENTAL_SLUG = "dental-deposit";

/**
 * luna, replaced by a function of the turn text. It records which engine each call was given and post-processes the
 * patch with THAT engine — which is the whole point: a Dental case must reach `applyExtraction(..., dentalSpec)`.
 */
class PatchExtractor implements Extractor {
  readonly seen: { caseId: string; prompt: string; format: string; version: string }[] = [];
  constructor(
    private readonly base: ExtractorEngine,
    private readonly patchFor: (turns: readonly TurnInput[]) => RawPatchEvent[],
  ) {}

  async extractTurn(input: RelayExtractTurnInput) {
    const eng = input.engine ?? this.base;
    this.seen.push({
      caseId: input.caseId, prompt: eng.extractor.prompt, format: eng.extractor.format.name, version: eng.extractor.version,
    });
    // The input builder is exercised for real: a throw here (a spec that cannot read the account) fails the test.
    eng.buildExtractorInput({
      callDate: input.callDate, policy: input.policy, state: input.state, recent: input.recent, newTurns: input.newTurns,
    });
    const events = this.patchFor(input.newTurns);
    return {
      events: eng.applyExtraction({ no_facts: events.length === 0, events } as never, [...input.newTurns], {
        caseId: input.caseId, policy: input.policy, callDate: input.callDate,
      }),
      ms: 1, usage: { input: 0, output: 0 }, model: eng.extractor.model, extractorVersion: eng.extractor.version, cached: false,
    };
  }
}

describe.skipIf(!HAS_DB)("the Dental server path: a non-flagship relay runs end to end (WP14b·3)", () => {
  let t: TestDb;
  let restore: () => void;
  let rd: RelaysDeps;
  let extractor: PatchExtractor;
  let n = 0;
  const base = defaultEngine();

  const moderator: Moderator = { async check() { return { flagged: false, categories: [] }; } };

  beforeAll(async () => {
    restore = withSecrets();
    t = await createTestDb("wp14b_dental", { poolMax: 4 });
    const data = new MemoryCaseDataSource({ policies: { s01: policyOf("s01") }, calls: [callEntry("s01_take1")] });
    extractor = new PatchExtractor(base, (turns) => patchOf(turns));
    setCasesDeps({
      db: t.db, engine: base, platform: createStubPlatform(), extractor, verifier: new FakeVerifier(() => []),
      data, verifierEnabled: () => false,
    });
    rd = setRelaysDeps({
      db: t.db, gallery: new MemoryGallerySource(galleryEntries()), moderator, deployId: () => "test-dental-env",
      calls: { getCall: (id) => data.getCall(id) },
    })!;
    await rd.ensureSeeded();
  });
  afterAll(async () => {
    setCasesDeps(null);
    setRelaysDeps(null);
    restore?.();
    await t?.drop();
  });

  function visitor() {
    n++;
    const id = `dental${n}_${Math.random().toString(36).slice(2, 8)}`;
    return { id, ws: workspaceOf(id), h: { "x-baton-visitor": signVisitorId(id, SECRETS.VISITOR_SECRET), "x-forwarded-for": `198.51.7.${n}` } };
  }
  const run = (h: Record<string, string>, body: Record<string, unknown>) =>
    createCaseRoute(req("POST", "/api/cases", { mode: "watch", ...body }, h), undefined as never);

  async function dental(ws: string): Promise<RelayDetail> {
    const [row] = await t.db.select().from(relays).where(eq(relays.slug, DENTAL_SLUG));
    return (await rd.registry.get(row!.id, ws))!;
  }

  /** One rep turn and one customer turn that settle the patient's name, through the case token the run handed back. */
  function turn(caseId: string, i: number, channel: "rep" | "customer", text: string): TurnInput {
    const startMs = i * 3000;
    const words = text.split(/\s+/).map((w, j) => ({ text: w, startMs: startMs + j * 200, endMs: startMs + j * 200 + 180, confidence: 0.95 }));
    return {
      caseId, turnId: turnIdOf(channel, i), channel, text, words, startMs, endMs: words.at(-1)!.endMs,
      source: "stt_live", recvMs: startMs + 2000, cut: false, late: false,
    };
  }

  /** The Dental patch the fake luna returns; Baton field ids are absent by construction. */
  function patchOf(turns: readonly TurnInput[]): RawPatchEvent[] {
    const out: RawPatchEvent[] = [];
    for (const t of turns) {
      if (/maya ortiz/i.test(t.text)) {
        out.push({
          turn_id: t.turnId, field: "patient_name", kind: t.channel === "rep" ? "readback" : "stated",
          value: "Maya Ortiz", quote: "Maya Ortiz", acknowledges_turn_id: null, confidence: "high",
        } as unknown as RawPatchEvent);
      }
      if (/brightsmile/i.test(t.text)) {
        out.push({
          turn_id: t.turnId, field: "insurer", kind: "stated", value: "BrightSmile Plus", quote: "BrightSmile Plus",
          acknowledges_turn_id: null, confidence: "high",
        } as unknown as RawPatchEvent);
      }
    }
    return out;
  }

  async function extract(v: { h: Record<string, string> }, caseToken: string, t_: TurnInput): Promise<ExtractResponse> {
    const r = await extractRoute(req("POST", "/api/extract", { turn: t_ }, { ...v.h, authorization: `Bearer ${caseToken}` }), undefined as never);
    if (r.status !== 200) throw new Error(`extract ${r.status}: ${await r.text()}`);
    return (await r.json()) as ExtractResponse;
  }

  it("a Dental version runs: the row is a relay row, and the response is the Dental UiSpec with policy null", async () => {
    const v = visitor();
    const d = await dental(v.ws);
    const r = await run(v.h, { relayId: d.id });
    expect(r.status).toBe(200);
    const body = CreateCaseResponseV2Schema.parse(await r.json());

    expect(body.policy).toBeNull();
    expect(body.relay.relay).toMatchObject({ slug: DENTAL_SLUG, flagship: false, simulated: false });
    expect(body.account).toEqual(d.draft.context.samples[0]);
    expect(body.listening.keyterms.length).toBeGreaterThan(0);
    expect(body.provenance).toMatchObject({ humanHalf: "recorded", detail: null });

    const [row] = await t.db.select({ intent: cases.intent, policy: cases.policy, rv: cases.relayVersionId }).from(cases).where(eq(cases.id, body.caseId));
    expect(row!.intent).toBe("relay");
    expect(row!.rv).toBeTruthy();
    expect(row!.policy).toMatchObject({ $kind: "account", customer: { firstName: d.draft.context.samples[0]!.customer.firstName } });

    // The initial state is the RELAY's fields, derived by WP1 under the compiled spec — not Baton's 21.
    const ids = Object.keys(body.state.fields);
    expect(ids).toEqual(expect.arrayContaining(dentalFieldIds(d.draft)));
    expect(ids).not.toContain("driver_full_name");
  });

  it("extraction runs through compiled.extractor: the relay's prompt and <intent>_patch schema, and its spec", async () => {
    const v = visitor();
    const d = await dental(v.ws);
    const body = CreateCaseResponseV2Schema.parse(await (await run(v.h, { relayId: d.id })).json());
    const before = extractor.seen.length;

    const out = await extract(v, body.caseToken, turn(body.caseId, 0, "customer", "It's for Maya Ortiz."));
    const call = extractor.seen[before]!;
    expect(call.caseId).toBe(body.caseId);
    expect(call.format).toBe(`${d.draft.meta.intent.id}_patch`);       // P§5 strict output format
    expect(call.prompt).toContain(d.draft.extraction.domainLine);       // the generated prompt, not EXTRACTOR_PROMPT_V3
    expect(call.version).not.toBe(base.extractor.version);              // a different pin → no Baton cache is served

    expect(out.events.map((e) => e.field)).toEqual(["patient_name"]);
    expect(out.state.fields.patient_name?.status).not.toBe("MISSING");
    expect(out.state.fields).not.toHaveProperty("driver_full_name");
  });

  it("a Baton case on the same server is unchanged: the flagship engine, its policy, and Baton field ids", async () => {
    const v = visitor();
    const body = CreateCaseResponseV2Schema.parse(await (await run(v.h, { callId: "s01_take1" })).json());
    expect(body.policy).not.toBeNull();
    const [row] = await t.db.select({ intent: cases.intent, rv: cases.relayVersionId }).from(cases).where(eq(cases.id, body.caseId));
    expect(row!.intent).toBe("add_driver");
    expect(row!.rv).toBeNull();
    expect(Object.keys(body.state.fields)).toContain("driver_full_name");

    const before = extractor.seen.length;
    await extract(v, body.caseToken, turn(body.caseId, 0, "customer", "Nothing relevant here."));
    // No per-case engine was passed: the extractor saw the flagship artefacts.
    expect(extractor.seen[before]!.version).toBe(base.extractor.version);
  });

  it("the 'add a field' preset (P§7.5.3) really adds the field, and changes the extractor pin", async () => {
    const v = visitor();
    const d = await dental(v.ws);
    const preset = d.presets.find((p) => p.id === "add_insurer")!;
    const plain = CreateCaseResponseV2Schema.parse(await (await run(v.h, { relayId: d.id })).json());
    const body = CreateCaseResponseV2Schema.parse(await (await run(v.h, { relayVersionId: preset.versionId })).json());

    expect(body.relay.fields.map((f) => f.id)).toContain("insurer");
    expect(plain.relay.fields.map((f) => f.id)).not.toContain("insurer");
    expect(Object.keys(body.state.fields)).toContain("insurer");

    const before = extractor.seen.length;
    const out = await extract(v, body.caseToken, turn(body.caseId, 0, "customer", "It's BrightSmile Plus."));
    expect(out.events.map((e) => e.field)).toEqual(["insurer"]);       // the new field is captured, under its own id
    expect(out.state.fields.insurer?.status).not.toBe("MISSING");

    // The pin differs from the base relay's, so a `pc_ctx` cache written for the base relay is never served to the
    // preset — Express re-extracts instead (P§7.5). Both differ from Baton's.
    const presetVersion = extractor.seen[before]!.version;
    const baseVersion = extractor.seen.find((s) => s.caseId === plain.caseId)?.version
      ?? (await (async () => { await extract(v, plain.caseToken, turn(plain.caseId, 0, "customer", "It's for Maya Ortiz.")); return extractor.seen.at(-1)!.version; })());
    expect(presetVersion).not.toBe(baseVersion);
    expect(presetVersion).not.toBe(base.extractor.version);
  });
});

/** The relay's own field ids, straight off the blueprint (the spec's order). */
const dentalFieldIds = (bp: Blueprint): string[] => bp.fields.map((f) => f.id);
