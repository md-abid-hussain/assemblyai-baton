/**
 * The OpenAI moderator (PLATFORM §7.4, TASKS-v2 WP14b·2): `omni-moderation-latest` (free), one request per check,
 * a $0 ledger reserve → settle per call (release on failure), and every failure surfaced as
 * `ModerationUnavailableError` for the registry's fail-open/fail-closed policy. Fake client and ledger; $0.
 */
import { describe, expect, it } from "vitest";

import type { SpendLedger } from "@/core/contracts/services";
import {
  flaggedCategories, MODERATION_CHUNK_CHARS, MODERATION_MAX_INPUTS, MODERATION_MODEL, moderationInputs, moderationLines,
  ModerationUnavailableError, OpenAIModerator,
} from "@/server/relays/moderation";
import { dentalBlueprint } from "./helpers";

type Result = { flagged: boolean; categories: Record<string, boolean> };

function fakeLedger(opts: { refuse?: boolean; throws?: boolean } = {}) {
  const log: string[] = [];
  const ledger = {
    async reserve(e: { provider: string; action: string; refId: string; estUsd: number; env: string }) {
      log.push(`reserve:${e.provider}:${e.action}:${e.refId}:${e.estUsd}:${e.env}`);
      if (opts.throws) throw new Error("db down");
      return opts.refuse ? { ok: false as const, code: "E_BUDGET" as const, reason: "openai_daily" } : { ok: true as const, id: "led_1" };
    },
    async settle(id: string, usd: number) {
      log.push(`settle:${id}:${usd}`);
    },
    async release(id: string) {
      log.push(`release:${id}`);
    },
  } as unknown as SpendLedger;
  return { ledger, log };
}

function fakeClient(answer: (input: string[]) => Result[] | Error) {
  const requests: { body: { model: string; input: string[] }; opts: { timeout?: number; maxRetries?: number } }[] = [];
  const client = {
    moderations: {
      async create(body: { model: string; input: string[] }, opts: { timeout?: number; maxRetries?: number }) {
        requests.push({ body, opts });
        const r = answer(body.input);
        if (r instanceof Error) throw r;
        return { id: "modr_1", model: body.model, results: r };
      },
    },
  };
  return { client: client as never, requests };
}

const clean = (input: string[]): Result[] => input.map(() => ({ flagged: false, categories: { harassment: false } }));

describe("OpenAIModerator", () => {
  it("one request with the pinned model, $0 reserve → settle, not flagged", async () => {
    const { client, requests } = fakeClient(clean);
    const { ledger, log } = fakeLedger();
    const m = new OpenAIModerator({ client: () => client, ledger: () => ledger, env: () => "dev-wp14b" });
    expect(await m.check("Hello there\nWe take a deposit", { refId: "rv_1" })).toEqual({ flagged: false, categories: [] });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toEqual({ model: MODERATION_MODEL, input: ["Hello there\nWe take a deposit"] });
    expect(requests[0]!.opts).toMatchObject({ maxRetries: 0 });
    expect(log).toEqual(["reserve:openai:moderation:rv_1:0:dev-wp14b", "settle:led_1:0"]);
  });

  it("flagged: the union of flagged categories, sorted; a flag without categories is 'unspecified'", async () => {
    const { client } = fakeClient((input) => input.map((_, i) => ({ flagged: i === 0, categories: { violence: true, harassment: i === 0, hate: false } })));
    const m = new OpenAIModerator({ client: () => client, ledger: () => null, env: () => "dev" });
    expect(await m.check("x")).toEqual({ flagged: true, categories: ["harassment", "violence"] });
    const bare = fakeClient((input) => input.map(() => ({ flagged: true, categories: {} })));
    expect(await new OpenAIModerator({ client: () => bare.client, ledger: () => null, env: () => "dev" }).check("x")).toEqual({ flagged: true, categories: ["unspecified"] });
    expect(flaggedCategories({ b: true, a: true, c: false, d: "yes" })).toEqual(["a", "b"]);
    expect(flaggedCategories(null)).toEqual([]);
  });

  it("every failure is ModerationUnavailableError; the ledger row is released, never settled", async () => {
    const cases: { name: string; m: () => OpenAIModerator; log?: string[]; expectLog?: string[] }[] = [];
    const down = fakeClient(() => new Error("503 from upstream"));
    const l1 = fakeLedger();
    cases.push({ name: "http", m: () => new OpenAIModerator({ client: () => down.client, ledger: () => l1.ledger, env: () => "dev" }), log: l1.log, expectLog: ["reserve:openai:moderation:relay:0:dev", "release:led_1"] });
    const short = fakeClient(() => []);
    const l2 = fakeLedger();
    cases.push({ name: "malformed", m: () => new OpenAIModerator({ client: () => short.client, ledger: () => l2.ledger, env: () => "dev" }), log: l2.log, expectLog: ["reserve:openai:moderation:relay:0:dev", "release:led_1"] });
    const ok = fakeClient(clean);
    cases.push({ name: "no key", m: () => new OpenAIModerator({ client: () => { throw new Error("OPENAI_API_KEY is not configured"); }, ledger: () => null, env: () => "dev" }) });
    const l3 = fakeLedger({ refuse: true });
    cases.push({ name: "ledger refuses", m: () => new OpenAIModerator({ client: () => ok.client, ledger: () => l3.ledger, env: () => "dev" }), log: l3.log, expectLog: ["reserve:openai:moderation:relay:0:dev"] });
    const l4 = fakeLedger({ throws: true });
    cases.push({ name: "ledger down", m: () => new OpenAIModerator({ client: () => ok.client, ledger: () => l4.ledger, env: () => "dev" }) });
    cases.push({ name: "no limits authority", m: () => new OpenAIModerator({ client: () => ok.client, ledger: () => { throw new Error("no DATABASE_URL"); }, env: () => "dev" }) });
    for (const c of cases) {
      await expect(c.m().check("some text"), c.name).rejects.toBeInstanceOf(ModerationUnavailableError);
      if (c.expectLog) expect(c.log, c.name).toEqual(c.expectLog);
    }
    expect(ok.requests).toHaveLength(0); // a refused or broken ledger never reaches OpenAI
  });

  it("empty text needs no call", async () => {
    const { client, requests } = fakeClient(clean);
    expect(await new OpenAIModerator({ client: () => client, ledger: () => null, env: () => "dev" }).check(" \n ")).toEqual({ flagged: false, categories: [] });
    expect(requests).toHaveLength(0);
  });
});

describe("moderation text", () => {
  it("moderationInputs packs lines into ≤ 16 inputs of ≤ 4000 chars and never drops text", () => {
    expect(moderationInputs("a\nb\n\nc")).toEqual(["a\nb\nc"]);
    const long = "x".repeat(MODERATION_CHUNK_CHARS * 2 + 10);
    const parts = moderationInputs(long);
    expect(parts.map((p) => p.length)).toEqual([MODERATION_CHUNK_CHARS, MODERATION_CHUNK_CHARS, 10]);
    const many = Array.from({ length: 40 }, (_, i) => `${i}`.padEnd(MODERATION_CHUNK_CHARS - 5, "y")).join("\n");
    const packed = moderationInputs(many);
    expect(packed).toHaveLength(MODERATION_MAX_INPUTS);
    expect(packed.join("\n").replace(/\n/g, "")).toBe(many.replace(/\n/g, ""));
  });

  it("moderationLines: the author text, trimmed, split and de-duplicated", () => {
    const bp = dentalBlueprint();
    bp.meta.tagline = "  Line one\nLine two  ";
    const lines = moderationLines(bp);
    expect(lines).toContain("Line one");
    expect(lines).toContain("Line two");
    expect(lines).toContain(bp.meta.title);
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines.every((l) => l === l.trim() && l.length > 0)).toBe(true);
  });
});
