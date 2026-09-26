/**
 * `unifiedDiff` (SAAS §5.3): the text the Studio shows before an Import overwrites a relay, and what
 * `changeover diff` prints. Being wrong here means someone approves a change they did not read, so the hunk
 * headers and the line numbers are checked against `diff -u`'s own conventions.
 */
import { describe, expect, it } from "vitest";

import { diffLines, serialize, unifiedDiff, applyEdit } from "@/core/relay-code";
import { miniBlueprint } from "../relay/fixtures/mini-blueprint";

const LABELS = { a: "rev 7", b: "working copy" };
const lines = (n: number, prefix = "line"): string => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";

describe("unifiedDiff", () => {
  it("is empty for identical text", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", LABELS)).toBe("");
    expect(unifiedDiff("", "", LABELS)).toBe("");
  });

  it("labels both sides and prints one hunk with three lines of context", () => {
    const a = lines(10);
    const b = a.replace("line 5\n", "line 5 edited\n");
    const out = unifiedDiff(a, b, LABELS).split("\n");
    expect(out[0]).toBe("--- rev 7");
    expect(out[1]).toBe("+++ working copy");
    expect(out[2]).toBe("@@ -2,7 +2,7 @@");
    expect(out.slice(3, 10)).toEqual([" line 2", " line 3", " line 4", "-line 5", "+line 5 edited", " line 6", " line 7"]);
    expect(out.slice(3).filter((l) => l.startsWith("-"))).toHaveLength(1);
  });

  it("prints a pure addition and a pure deletion the way diff -u does", () => {
    const added = unifiedDiff("a\nb\n", "a\nnew\nb\n", LABELS);
    expect(added).toContain("@@ -1,2 +1,3 @@");
    expect(added).toContain("+new");
    const removed = unifiedDiff("a\nnew\nb\n", "a\nb\n", LABELS);
    expect(removed).toContain("@@ -1,3 +1,2 @@");
    expect(removed).toContain("-new");
    expect(unifiedDiff("", "a\n", LABELS)).toContain("@@ -0,0 +1,1 @@");
    expect(unifiedDiff("a\n", "", LABELS)).toContain("@@ -1,1 +0,0 @@");
  });

  it("splits distant changes into separate hunks and merges close ones", () => {
    const a = lines(30);
    const b = a.replace("line 2\n", "line 2 edited\n").replace("line 25\n", "line 25 edited\n");
    const two = unifiedDiff(a, b, LABELS);
    expect(two.split("\n").filter((l) => l.startsWith("@@"))).toHaveLength(2);

    const close = a.replace("line 10\n", "line 10 edited\n").replace("line 12\n", "line 12 edited\n");
    expect(unifiedDiff(a, close, LABELS).split("\n").filter((l) => l.startsWith("@@"))).toHaveLength(1);
  });

  it("ends with a newline and never loses a line", () => {
    const a = lines(40);
    const b = lines(40, "other");
    const out = unifiedDiff(a, b, LABELS);
    expect(out.endsWith("\n")).toBe(true);
    const body = out.split("\n").slice(2).filter((l) => l && !l.startsWith("@@"));
    expect(body.filter((l) => l.startsWith("-"))).toHaveLength(40);
    expect(body.filter((l) => l.startsWith("+"))).toHaveLength(40);
  });

  it("reconstructs both files from its edit script", () => {
    const a = ["one", "two", "three", "four", "five"];
    const b = ["one", "three", "3.5", "four", "five", "six"];
    const ops = diffLines(a, b);
    expect(ops.filter((o) => o.kind !== "add").map((o) => o.line)).toEqual(a);
    expect(ops.filter((o) => o.kind !== "del").map((o) => o.line)).toEqual(b);
  });

  it("diffs two blueprint revisions in a blink", () => {
    const text = serialize(miniBlueprint(), "yaml");
    const edited = applyEdit(applyEdit(text, "yaml", ["meta", "title"], "Renamed"), "yaml", ["fields", 0, "required"], false);
    const started = Date.now();
    const out = unifiedDiff(text, edited, { a: "rev 3", b: "rev 4" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out).toContain("-  title: Mini dental");
    expect(out).toContain("+  title: Renamed");
    expect(out.split("\n").filter((l) => l.startsWith("@@"))).toHaveLength(2);
  });

  it("stays fast when the two files share nothing", () => {
    const a = lines(4000, "alpha");
    const b = lines(4000, "beta");
    const started = Date.now();
    const out = unifiedDiff(a, b, LABELS);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out.split("\n").filter((l) => l.startsWith("-"))).toHaveLength(4001);   // + the "--- " header
  });
});
