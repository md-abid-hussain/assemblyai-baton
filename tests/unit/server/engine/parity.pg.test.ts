/**
 * WP14b·3, TASKS-v2 WP14b T3 + acceptance 5: **the kernel parity check over Postgres**, and the `RELAY_ENGINE`
 * runtime switch (PLATFORM §4.6, §4.7).
 *
 * WP14a's `tests/unit/core/relay/parity-*.test.ts` already proves the pure claim — `compileRelay(baton-add-driver)`
 * reproduces the legacy oracle. What it cannot prove is the SERVER claim, which is this file: that the real
 * `data/relays/baton-add-driver.json` seeded into real Postgres, resolved through the real registry, compiled
 * through the real `RelayEngineFactory` LRU and reached through `relayTakeoverCompile`, produces for s01/s02/s05 at
 * three pass points each the **same `CompiledTakeover`** as WP1's `compileTakeover` — one seam at a time, all of
 * them real except the upstreams, which are not touched at all. $0: no OpenAI, no AssemblyAI, no Voice Agent.
 *
 * The one listed difference (P§4.6, and the core suite's own allowance) is `promptVersion`: the kernel stamps
 * `relay:<hash8>` where WP1 stamps its own constant. It is asserted, not ignored.
 */
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { CaseState, PolicyRecord } from "@/core/contracts/case";
import type { CompiledTakeover } from "@/core/contracts/takeover";
import type { CompileTakeoverOptions } from "@/core/contracts/v2";
import { workspaceOf } from "@/core/contracts/v2";
import { compileTakeover } from "@/core/compiler";
import { POST as createCaseRoute } from "@/app/api/cases/route";
import { signVisitorId } from "@/server/auth/visitor";
import { setCasesDeps } from "@/server/cases";
import { defaultEngine } from "@/server/cases/defaults";
import { createStubPlatform } from "@/server/cases/platform-stub";
import { MemoryCaseDataSource } from "@/server/data";
import { cases } from "@/server/db/schema";
import { relayTakeoverCompile } from "@/server/engine/takeover-compile";
import { FLAGSHIP_SLUG, relayEngineMode, resetRelayEngineModeWarning } from "@/server/engine/mode";
import { setRelaysDeps, type RelaysDeps } from "@/server/relays";
import { FsGallerySource } from "@/server/relays/seed";
import type { Moderator } from "@/server/relays/moderation";
import { callEntry, FakeExtractor, FakeVerifier, policyOf as batonPolicy } from "../cases/helpers/fixtures";
import { createTestDb, HAS_DB, type TestDb } from "../cases/helpers/test-db";
import { req, SECRETS, withSecrets } from "../relays/helpers";
import { HANDOFF_POINTS, kit, passPoints, policyOf, snapshotAt, synthCall } from "../takeovers/_scenarios";

const OPTS: CompileTakeoverOptions = {
  deployId: "test-parity-env", voice: "alba", keytermsEnabled: true, compiledBy: "server", payToolMode: "push",
};

/** The gallery seed is pre-cleared, so no relay text reaches OpenAI: this file spends nothing. */
const cleanModerator: Moderator = { async check() { return { flagged: false, categories: [] }; } };

/** `await`s inside the try, so the restore never races an in-flight route (the switch is read per request). */
async function withEngine<T>(mode: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env.RELAY_ENGINE;
  if (mode === undefined) delete process.env.RELAY_ENGINE;
  else process.env.RELAY_ENGINE = mode;
  resetRelayEngineModeWarning();
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.RELAY_ENGINE;
    else process.env.RELAY_ENGINE = prev;
    resetRelayEngineModeWarning();
  }
}

describe.skipIf(!HAS_DB)("kernel parity over Postgres, and the RELAY_ENGINE switch (WP14b·3)", () => {
  let t: TestDb;
  let restore: () => void;
  let rd: RelaysDeps;
  let flagshipVersionId: string;
  let n = 0;

  beforeAll(async () => {
    restore = withSecrets();
    t = await createTestDb("wp14b_parity", { poolMax: 4 });
    const base = defaultEngine();
    const data = new MemoryCaseDataSource({ policies: { s01: batonPolicy("s01") }, calls: [callEntry("s01_take1")] });
    setCasesDeps({
      db: t.db, engine: base, platform: createStubPlatform(), extractor: new FakeExtractor(base), verifier: new FakeVerifier(() => []),
      data, verifierEnabled: () => false,
    });
    // The REAL gallery files and the REAL kernel binding (kernel-binding.ts's default), not a stub of either.
    rd = setRelaysDeps({
      db: t.db, gallery: new FsGallerySource(), moderator: cleanModerator, deployId: () => OPTS.deployId,
      calls: { getCall: (id) => data.getCall(id) },
    })!;
    await rd.ensureSeeded();
    const run = await rd.registry.resolveRun(workspaceOf("parity_seed"), { relayId: FLAGSHIP_SLUG });
    flagshipVersionId = run.versionId;
  });
  afterAll(async () => {
    setCasesDeps(null);
    setRelaysDeps(null);
    restore?.();
    await t?.drop();
  });
  afterEach(() => resetRelayEngineModeWarning());

  function visitor() {
    n++;
    const id = `parity${n}_${Math.random().toString(36).slice(2, 8)}`;
    return { id, ws: workspaceOf(id), h: { "x-baton-visitor": signVisitorId(id, SECRETS.VISITOR_SECRET), "x-forwarded-for": `203.0.113.${n}` } };
  }

  // ------------------------------------------------------------------------------ the switch (P§4.6, P§0 P3)

  describe("RELAY_ENGINE", () => {
    it("legacy is the default and the submission setting: an unset, a blank and a TYPO'd value all read legacy", async () => {
      expect(await withEngine(undefined, relayEngineMode)).toBe("legacy");
      expect(await withEngine("", relayEngineMode)).toBe("legacy");
      // A misconfigured switch must never silently move the flagship onto unproven code.
      expect(await withEngine("kernal", relayEngineMode)).toBe("legacy");
      expect(await withEngine("kernel", relayEngineMode)).toBe("kernel");
    });

    it("legacy: a plain Baton case keeps relay_version_id null, and the response is v1-shaped", async () => {
      const v = visitor();
      const r = await withEngine("legacy", () =>
        createCaseRoute(req("POST", "/api/cases", { mode: "watch", callId: "s01_take1" }, v.h), undefined as never));
      expect(r.status).toBe(200);
      const body = (await r.json()) as { caseId: string; policy: unknown };
      const [row] = await t.db.select({ rv: cases.relayVersionId, intent: cases.intent }).from(cases).where(eq(cases.id, body.caseId));
      expect(row!.rv).toBeNull();
      expect(row!.intent).toBe("add_driver");
      expect(body.policy).toBeTruthy();
    });

    it("kernel: the same request pins the seeded flagship version, and the row stays a BATON row", async () => {
      const v = visitor();
      const r = await withEngine("kernel", () =>
        createCaseRoute(req("POST", "/api/cases", { mode: "watch", callId: "s01_take1" }, v.h), undefined as never));
      expect(r.status).toBe(200);
      const body = (await r.json()) as { caseId: string };
      const [row] = await t.db
        .select({ rv: cases.relayVersionId, intent: cases.intent, policy: cases.policy })
        .from(cases)
        .where(eq(cases.id, body.caseId));

      // The pin is the whole change: the version id is set …
      expect(row!.rv).toBe(flagshipVersionId);
      // … and nothing else is. The parity claim is that the blueprint reproduces the flagship, not that it
      // replaces its data, so `intent` and the `PolicyRecord` in `cases.policy` are untouched.
      expect(row!.intent).toBe("add_driver");
      expect((row!.policy as { $kind?: string }).$kind).toBeUndefined();
      expect((row!.policy as { policyholder?: unknown }).policyholder).toBeTruthy();
    });
  });

  // ------------------------------------------------------------------------------ acceptance 5: the parity

  describe("acceptance 5: the compile is deep-equal to WP1 for s01, s02, s05 at 3 pass points", () => {
    /** The port, over the real factory, as `TakeoverService.compile` reaches it for a pinned Baton case. */
    const viaKernel = async (policy: PolicyRecord, snapshot: CaseState): Promise<CompiledTakeover> => {
      const out = await relayTakeoverCompile(() => rd)({
        case: { id: "case_parity", callId: null, policy, relayVersionId: flagshipVersionId, simCallId: null },
        snapshot,
        opts: OPTS,
      });
      if (!out) throw new Error("the port answered null for a pinned case");
      return out;
    };

    for (const id of ["s01", "s02", "s05"]) {
      const s = kit(id);
      const policy = policyOf(s);
      const caseId = `case_${id}`;
      const call = synthCall(s, policy, caseId);
      const points = passPoints(call);

      for (const point of HANDOFF_POINTS) {
        it(`${id} @ ${point}`, async () => {
          const snapshot = snapshotAt(call, policy, caseId, points[point]);
          const legacy = compileTakeover(snapshot, policy, OPTS);
          const kernel = await viaKernel(policy, snapshot);

          // The listed difference, asserted rather than ignored (P§4.6).
          expect(kernel.promptVersion).toMatch(/^relay:[0-9a-f]{8}$/);
          expect(legacy.promptVersion).not.toBe(kernel.promptVersion);

          // Everything else, byte for byte — the greeting, the system prompt, the tools, the keyterms, the cap.
          expect({ ...kernel, promptVersion: null }).toEqual({ ...legacy, promptVersion: null });
        });
      }
    }

    it("the second compile of the version is an LRU hit, so parity costs one compile, not nine", async () => {
      const a = await rd.engine.forVersion(flagshipVersionId);
      const b = await rd.engine.forVersion(flagshipVersionId);
      expect(b).toBe(a);
      expect(a.blueprint!.meta.slug).toBe(FLAGSHIP_SLUG);
    });
  });
});
