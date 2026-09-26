/**
 * WP17·2: "Try an edit" presets (PLATFORM §7.5.3) - the JSON-patch subset and the presets file.
 * Pure: no network, no DB.
 */
import { describe, expect, it } from "vitest";

import {
  applyJsonPatch, applyRelayPreset, parsePresetsFile, pointerTokens, PresetPatchError, RELAY_PRESETS_SCHEMA,
  RelayPresetsFileSchema, type JsonPatchOp,
} from "@/core/relay/draft/presets";

const doc = () => ({ a: 1, list: [{ id: "x" }, { id: "y" }], nested: { deep: { v: "old" } }, "odd/key": true });

describe("pointerTokens", () => {
  it("splits and unescapes (RFC 6901)", () => {
    expect(pointerTokens("")).toEqual([]);
    expect(pointerTokens("/a/b")).toEqual(["a", "b"]);
    expect(pointerTokens("/odd~1key")).toEqual(["odd/key"]);
    expect(pointerTokens("/ti~0lde")).toEqual(["ti~lde"]);
    expect(pointerTokens("/fields/-")).toEqual(["fields", "-"]);
  });
});

describe("applyJsonPatch", () => {
  it("replaces a nested value without mutating the input", () => {
    const d = doc();
    const out = applyJsonPatch(d, [{ op: "replace", path: "/nested/deep/v", value: "new" }]) as typeof d;
    expect(out.nested.deep.v).toBe("new");
    expect(d.nested.deep.v).toBe("old");
  });

  it("inserts into an array at an index and appends with -", () => {
    const out = applyJsonPatch(doc(), [
      { op: "add", path: "/list/1", value: { id: "mid" } },
      { op: "add", path: "/list/-", value: { id: "last" } },
    ]) as ReturnType<typeof doc>;
    expect(out.list.map((e) => e.id)).toEqual(["x", "mid", "y", "last"]);
  });

  it("removes an array element and an object key", () => {
    const out = applyJsonPatch(doc(), [{ op: "remove", path: "/list/0" }, { op: "remove", path: "/a" }]) as Record<string, unknown>;
    expect((out["list"] as { id: string }[]).map((e) => e.id)).toEqual(["y"]);
    expect("a" in out).toBe(false);
  });

  it("deep-copies the inserted value", () => {
    const value = { id: "z", tags: ["t"] };
    const out = applyJsonPatch(doc(), [{ op: "add", path: "/list/-", value }]) as ReturnType<typeof doc>;
    value.tags.push("changed");
    expect((out.list[2] as unknown as typeof value).tags).toEqual(["t"]);
  });

  it("escapes keys with a slash", () => {
    const out = applyJsonPatch(doc(), [{ op: "replace", path: "/odd~1key", value: false }]) as Record<string, unknown>;
    expect(out["odd/key"]).toBe(false);
  });

  it("refuses a path that does not exist, a bad index and an append on replace", () => {
    const bad: JsonPatchOp[][] = [
      [{ op: "replace", path: "/missing", value: 1 }],
      [{ op: "replace", path: "/list/9", value: 1 }],
      [{ op: "replace", path: "/list/-", value: 1 }],
      [{ op: "add", path: "/list/9", value: 1 }],
      [{ op: "add", path: "/nope/deep", value: 1 }],
      [{ op: "remove", path: "" }],
    ];
    for (const patch of bad) expect(() => applyJsonPatch(doc(), patch)).toThrow(PresetPatchError);
  });
});

describe("parsePresetsFile", () => {
  const file = {
    schema: RELAY_PRESETS_SCHEMA,
    relay: "dental-deposit",
    presets: [
      { id: "one", label: "One", summary: "A change worth one sentence.", patch: [{ op: "replace", path: "/a", value: 2 }], sim: { answers: [] } },
    ],
  };

  it("parses and checks the slug", () => {
    expect(parsePresetsFile(file, "dental-deposit").presets).toHaveLength(1);
    expect(() => parsePresetsFile(file, "other-relay")).toThrow(/not "other-relay"/);
  });

  it("rejects duplicate ids, an unknown op and more than 3 presets", () => {
    expect(() => parsePresetsFile({ ...file, presets: [file.presets[0], file.presets[0]] }, "dental-deposit")).toThrow(/duplicate preset id/);
    expect(RelayPresetsFileSchema.safeParse({ ...file, presets: [{ ...file.presets[0], patch: [{ op: "move", from: "/a", path: "/b" }] }] }).success).toBe(false);
    expect(RelayPresetsFileSchema.safeParse({ ...file, presets: [file.presets[0], { ...file.presets[0], id: "two" }, { ...file.presets[0], id: "three" }, { ...file.presets[0], id: "four" }] }).success).toBe(false);
  });
});

describe("applyRelayPreset", () => {
  it("is applyJsonPatch of the preset's patch", () => {
    const out = applyRelayPreset({ values: [{ ref: { value: "50" } }] }, { patch: [{ op: "replace", path: "/values/0/ref/value", value: "75" }] });
    expect(out).toEqual({ values: [{ ref: { value: "75" } }] });
  });
});
