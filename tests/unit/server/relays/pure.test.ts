/**
 * WP14b pure pieces: canonical hash, JSON patch, the blank blueprint, the presets file format, secret stripping,
 * moderation text, the default kernel port. $0, no DB.
 */
import { describe, expect, it } from "vitest";

import { RelayPresetsFileSchema } from "@/core/contracts/ext/wp14b-relays";
import { BlueprintSchema, INDUSTRIES } from "@/core/contracts/v2";
import { blankBlueprint } from "@/server/relays/blank";
import { blueprintHash, canonicalJson } from "@/server/relays/canonical";
import { applyJsonPatch, JsonPatchError } from "@/server/relays/json-patch";
import { defaultRelayKernel } from "@/server/relays/kernel";
import { moderationText } from "@/server/relays/moderation";
import { stripSecrets } from "@/server/relays/registry";
import { miniBlueprint } from "../../core/relay/fixtures/mini-blueprint";
import { DENTAL_PRESETS, dentalBlueprint } from "./helpers";

describe("canonicalJson / blueprintHash (PLATFORM §3.2 Versioning)", () => {
  it("sorts keys at every depth, keeps array order, drops undefined, no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson([undefined, "x"])).toBe('[null,"x"]');
  });

  it("is a lowercase sha256 hex that ignores key order but not values", () => {
    const a = miniBlueprint();
    const h = blueprintHash(a);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    const reordered = Object.fromEntries(Object.entries(a).reverse());
    expect(blueprintHash(reordered)).toBe(h);
    const c = miniBlueprint();
    c.handoff.allowedWhen.minCallSeconds += 1;
    expect(blueprintHash(c)).not.toBe(h);
    // pinned vector: WP14a's isomorphic blueprintHash must produce the same value (requests/wp14b-to-wp14a.md)
    expect(canonicalJson({ n: [1, 2.5, "é"], meta: { title: "x", slug: "y" } })).toBe('{"meta":{"slug":"y","title":"x"},"n":[1,2.5,"é"]}');
    expect(blueprintHash({ n: [1, 2.5, "é"], meta: { title: "x", slug: "y" } })).toBe("7aabb678e04f7850d6878f922d518c0af1c344ad6b54f9599c584d483294139d");
  });
});

describe("applyJsonPatch (RFC 6902)", () => {
  const doc = { a: { b: [1, 2, 3] }, c: "x", "k/e~y": 1 };

  it("add / remove / replace / move / copy / test, without mutating the input", () => {
    const out = applyJsonPatch(doc, [
      { op: "add", path: "/a/b/-", value: 4 },
      { op: "add", path: "/a/b/0", value: 0 },
      { op: "remove", path: "/a/b/1" },
      { op: "replace", path: "/c", value: "y" },
      { op: "copy", from: "/c", path: "/d" },
      { op: "move", from: "/d", path: "/e" },
      { op: "test", path: "/e", value: "y" },
      { op: "replace", path: "/k~1e~0y", value: 2 },
    ]);
    expect(out).toEqual({ a: { b: [0, 2, 3, 4] }, c: "y", e: "y", "k/e~y": 2 });
    expect(doc).toEqual({ a: { b: [1, 2, 3] }, c: "x", "k/e~y": 1 });
  });

  it("throws JsonPatchError on a missing path, a bad index or a failed test", () => {
    expect(() => applyJsonPatch(doc, [{ op: "replace", path: "/nope", value: 1 }])).toThrow(JsonPatchError);
    expect(() => applyJsonPatch(doc, [{ op: "remove", path: "/a/b/9" }])).toThrow(/out of range/);
    expect(() => applyJsonPatch(doc, [{ op: "test", path: "/c", value: "z" }])).toThrow(/test failed/);
    expect(() => applyJsonPatch(doc, [{ op: "add", path: "/x/y", value: 1 }])).toThrow(/does not exist/);
    expect(() => applyJsonPatch(doc, [{ op: "move", from: "/a", path: "/a/b/0" }])).toThrow(/into itself/);
  });

  it("the test presets patch the Dental blueprint into schema-valid variants", () => {
    for (const p of DENTAL_PRESETS) {
      const patched = applyJsonPatch(dentalBlueprint(), p.patch);
      expect(BlueprintSchema.safeParse(patched).success).toBe(true);
      expect(blueprintHash(patched)).not.toBe(blueprintHash(dentalBlueprint()));
    }
  });
});

describe("presets file format (data/relays/<base>.presets.json)", () => {
  it("accepts a bare array or {presets}, rejects bad ids and empty patches", () => {
    expect(RelayPresetsFileSchema.parse(DENTAL_PRESETS)).toHaveLength(2);
    expect(RelayPresetsFileSchema.parse({ presets: DENTAL_PRESETS })).toHaveLength(2);
    expect(RelayPresetsFileSchema.safeParse([{ id: "X", label: "x", patch: [{ op: "remove", path: "/a" }] }]).success).toBe(false);
    expect(RelayPresetsFileSchema.safeParse([{ id: "ok_id", label: "x", patch: [] }]).success).toBe(false);
  });
});

describe("blankBlueprint", () => {
  it("passes BlueprintSchema for every industry", () => {
    for (const ind of INDUSTRIES) {
      const bp = blankBlueprint(ind, "2026-09-25");
      const r = BlueprintSchema.safeParse(bp);
      expect(r.success, `${ind}: ${r.success ? "" : JSON.stringify(r.error.issues.slice(0, 2))}`).toBe(true);
      expect(bp.meta.industry).toBe(ind);
      expect(bp.meta.origin).toBe("user");
    }
  });
});

describe("stripSecrets / moderationText / defaultRelayKernel", () => {
  it("drops every secret ref of http_action headers/hmac and completion_webhook hmac", () => {
    const bp = miniBlueprint();
    const http = bp.connectors.find((c) => c.type === "http_action")!;
    if (http.type !== "http_action") throw new Error("fixture");
    http.headers = [{ name: "Authorization", value: { $secret: "sec_abcdefghij012345" } }, { name: "X-Plain", value: "hello" }];
    http.hmacSecret = { $secret: "sec_abcdefghij012345" };
    bp.connectors.push({ type: "completion_webhook", id: "done_hook", label: "Done", url: "https://example.com/hook", hmacSecret: { $secret: "sec_abcdefghij012345" }, include: ["case"] });
    const out = stripSecrets(bp);
    expect(JSON.stringify(out)).not.toContain("$secret");
    const h = out.connectors.find((c) => c.type === "http_action");
    expect(h?.type === "http_action" && h.headers).toEqual([{ name: "Authorization", value: null }, { name: "X-Plain", value: "hello" }]);
    expect(BlueprintSchema.safeParse(out).success).toBe(true);
    expect(JSON.stringify(bp)).toContain("$secret"); // input untouched
  });

  it("moderationText collects the author-written text once per line", () => {
    const t = moderationText(miniBlueprint());
    expect(t).toContain("Mini dental deposit");
    expect(t).toContain("Brightwater Dental");
    expect(t).toContain("AI assistant, not a person");
    expect(t).toContain("refundable up to 24 hours");
    expect(t).toContain("pay your {v.deposit|spoken_money} deposit");
    expect(new Set(t.split("\n")).size).toBe(t.split("\n").length);
  });

  it("the default kernel parses, maps schema failures to SCHEMA lint, and hashes", () => {
    const ok = defaultRelayKernel.parse(miniBlueprint());
    expect(ok.blueprint).not.toBeNull();
    expect(defaultRelayKernel.hash(ok.blueprint!)).toBe(blueprintHash(miniBlueprint()));
    const bad = miniBlueprint() as unknown as { meta: { slug: string } };
    bad.meta.slug = "BAD SLUG";
    const r = defaultRelayKernel.parse(bad);
    expect(r.blueprint).toBeNull();
    expect(r.issues[0]).toMatchObject({ code: "SCHEMA", severity: "error", path: ["meta", "slug"] });
  });
});
