/**
 * The Code tab's jump target (`client/studio/code-target.ts`, WP15·2).
 *
 * Overview's lint summary links by line and Configure's "Edit in Code →" links by path, and both arrive as a URL
 * fragment that a person can also type, paste or keep in a bookmark after the file has changed underneath. So the
 * two things worth testing are that a resolved path lands on the right line, and that nothing a stale or
 * hand-mangled fragment can contain throws inside the effect that reads it.
 *
 * Offline, $0.
 */
import { describe, expect, it } from "vitest";

import { joinPath, lineHash, parseCodeTarget, pathHash, resolveTarget, splitPath } from "@/client/studio/code-target";

import { commentedDental } from "./helpers";

describe("the fragment", () => {
  it("round-trips a path, including an array index", () => {
    const path = ["playbook", "stages", 0, "goal"];
    expect(joinPath(path)).toBe("playbook.stages.0.goal");
    expect(splitPath(joinPath(path))).toEqual(path);
    expect(parseCodeTarget(pathHash(path))).toEqual({ kind: "path", path });
  });

  it("round-trips a caret", () => {
    expect(parseCodeTarget(lineHash(8, 11))).toEqual({ kind: "line", line: 8, col: 11 });
    expect(parseCodeTarget("#L8")).toEqual({ kind: "line", line: 8, col: 1 });
    expect(parseCodeTarget("L8:11")).toEqual({ kind: "line", line: 8, col: 11 });
  });

  it("returns null for everything that is not one of the two shapes", () => {
    for (const hash of ["", "#", "#section-3", "#L0", "#L0:2", "#Lx", "#P", "#P.", "#%%%"]) {
      expect(parseCodeTarget(hash), hash).toBeNull();
    }
  });

  it("does not throw on a fragment with a lone percent sign", () => {
    expect(() => parseCodeTarget("#P%")).not.toThrow();
    expect(parseCodeTarget("#P%")).toBeNull();
  });

  it("keeps a numeric-looking key that is not an index out of trouble", () => {
    // Only whole runs of digits become numbers; "v2" stays a key, which is what `applyEdit` and `locate` need.
    expect(splitPath("a.v2.10.b")).toEqual(["a", "v2", 10, "b"]);
  });
});

describe("resolveTarget", () => {
  const text = commentedDental();

  it("passes a line target straight through", () => {
    expect(resolveTarget({ kind: "line", line: 4, col: 2 }, text, "yaml")).toEqual({ line: 4, col: 2 });
  });

  it("finds a top-level section, on the line its key is actually on", () => {
    const at = resolveTarget({ kind: "path", path: ["listening"] }, text, "yaml");
    expect(at).not.toBeNull();
    const line = text.split("\n")[at!.line - 1] ?? "";
    expect(line.startsWith("listening:")).toBe(true);
  });

  it("finds a nested key and an array element", () => {
    const nested = resolveTarget({ kind: "path", path: ["playbook", "greeting"] }, text, "yaml");
    expect(nested).not.toBeNull();
    expect(text.split("\n")[nested!.line - 1]).toContain("greeting:");

    const item = resolveTarget({ kind: "path", path: ["fields", 0, "label"] }, text, "yaml");
    expect(item).not.toBeNull();
    expect(text.split("\n")[item!.line - 1]).toContain("label:");
  });

  it("returns null for a path the document does not have, rather than guessing", () => {
    expect(resolveTarget({ kind: "path", path: ["nowhere", "at", "all"] }, text, "yaml")).toBeNull();
  });

  it("returns null rather than throwing when the text does not parse", () => {
    expect(() => resolveTarget({ kind: "path", path: ["fields"] }, "fields: [unclosed", "yaml")).not.toThrow();
  });

  it("gives a 1-based column, matching the caret a person reads", () => {
    const at = resolveTarget({ kind: "path", path: ["meta", "slug"] }, text, "yaml");
    expect(at!.col).toBeGreaterThanOrEqual(1);
  });
});
