/**
 * The pipeline wiring on a synthetic take, $0: STT cache (runner over fake sessions) → extraction cache through the
 * PRODUCTION extractor (WP3 OpenAIExtractor + WP1 engine) with a fake OpenAI client → a file WP3 would serve.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXTRACTOR_VERSION_V1, EXTRACTOR_VERSION_V3 } from "../../../../src/core/case";
import { ExtractCacheFileSchema } from "../../../../src/core/contracts/eval";
import { serializeSttCacheRecord } from "../../../../src/core/scenario/stt-cache";
import { resolvePaths, sttCachePath, type PipelinePaths } from "../../../../scripts/calls/lib/kit-io";
import { writeSyntheticTake } from "../../../../scripts/calls/synthetic-take";
import { extractCall } from "../../../../scripts/eval/extract";
import { planFromKit } from "../../../../scripts/eval/lib/replay-inputs";
import { fakeCache, tmp, turn } from "./helpers";

let root: string;
let paths: PipelinePaths;
let base: string;

beforeAll(async () => {
  root = tmp("pipe");
  base = writeSyntheticTake(join(root, "calls"), { scenarioId: "s01", maxMs: 6000 }).base;
  paths = resolvePaths({ callsDir: join(root, "calls"), outRoot: join(root, "out"), dataRoot: join(root, "out") });
  for (const variant of ["pc_ctx", "pc_noctx"] as const) {
    const c = await fakeCache(
      base,
      variant,
      6000,
      [{ atMs: 1500, msg: turn(0, "what is your daughter's name", true, 200, 1200) }],
      [{ atMs: 3000, msg: turn(0, "her name is Maya Raman", true, 1800, 2700) }, { atMs: 5000, msg: turn(1, "thanks", true, 4200, 4600) }],
    );
    const p = sttCachePath(paths.dataRoot, base, variant);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, `${c.records.map(serializeSttCacheRecord).join("\n")}\n`);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fakeOpenAI() {
  const inputs: string[] = [];
  const client = {
    responses: {
      create: async (body: { input: string }) => {
        inputs.push(body.input);
        const maya = (JSON.parse(body.input) as { new_turns: { turn_id: string }[] }).new_turns.some((t) => t.turn_id === "customer-c0");
        const patch = maya
          ? { no_facts: false, events: [{ turn_id: "customer-c0", field: "driver_full_name", kind: "stated", value: "Maya Raman", quote: "Maya Raman", acknowledges_turn_id: null, confidence: "high" }] }
          : { no_facts: true, events: [] };
        return {
          status: "completed", output_text: JSON.stringify(patch), output: [], incomplete_details: null,
          usage: { input_tokens: 1500, output_tokens: 60, output_tokens_details: { reasoning_tokens: 0 }, input_tokens_details: { cached_tokens: 0 } },
        };
      },
    },
  } as unknown as OpenAI;
  return { client, inputs };
}

const memLedger = () => {
  const rows: { id: string; estUsd: number; actual: number | null }[] = [];
  return {
    rows,
    reserve: async (e: { estUsd: number }) => (rows.push({ id: String(rows.length), estUsd: e.estUsd, actual: null }), { ok: true as const, id: String(rows.length - 1) }),
    settle: async (id: string, usd: number) => void (rows[Number(id)]!.actual = usd),
    release: async () => undefined,
    spentToday: async () => ({ usd: 0, byProvider: {} }),
  } as never;
};

describe("synthetic take → extraction cache", () => {
  it("v3.pc_ctx: one luna call per cached final, in order; events keyed by cached turn id; version-pinned", async () => {
    const [c] = planFromKit(paths);
    const ai = fakeOpenAI();
    const ledger = memLedger() as unknown as { rows: { actual: number | null }[] };
    const r = await extractCall(paths, c!, "v3", "pc_ctx", { client: ai.client, ledger: ledger as never, now: () => "2026-09-25T06:00:00.000Z" });
    expect(r.turns).toBe(3);
    expect(ai.inputs).toHaveLength(3);
    const file = ExtractCacheFileSchema.parse(JSON.parse(readFileSync(r.out, "utf8")));
    expect(file.extractorVersion).toBe(EXTRACTOR_VERSION_V3);
    expect(file.turns.map((t) => t.turnId)).toEqual(["rep-c0", "customer-c0", "customer-c1"]);
    const ev = file.turns[1]!.events;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ field: "driver_full_name", valueNorm: "maya raman", turnId: "customer-c0", turnEndMs: 2700 });
    expect(file.turns[2]!.endMs).toBe(4600);
    expect(ledger.rows[0]!.actual).toBeGreaterThan(0);
  });

  it("v1.pc_noctx uses the v1 extractor version", async () => {
    const [c] = planFromKit(paths);
    const r = await extractCall(paths, c!, "v1", "pc_noctx", { client: fakeOpenAI().client, ledger: memLedger() });
    expect(ExtractCacheFileSchema.parse(JSON.parse(readFileSync(r.out, "utf8"))).extractorVersion).toBe(EXTRACTOR_VERSION_V1);
    expect(r.out).toMatch(/v1\.pc_noctx\.json$/);
  });
});
