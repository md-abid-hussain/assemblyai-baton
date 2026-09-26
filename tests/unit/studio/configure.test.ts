/**
 * The Configure tab's model (SAAS §5.5, WP15·2).
 *
 * The forms are only trustworthy if every edit they emit is one the *codec* accepts and the *schema* still likes,
 * so these tests are mostly round-trips: take the committed Dental example, run the edits a control would emit,
 * and re-validate the text. A helper that returns a plausible-looking `Edit` which produces a zod-invalid document
 * would block autosave in the product ("Unsaved: 1 error to fix") and pass a shallower test.
 *
 * Offline, $0.
 */
import { describe, expect, it } from "vitest";

import {
  CODE_ONLY_SECTIONS, REQUIRED_STAGE_TOOLS, SECTIONS, STAGE_ORDER, appendEdit, canAddHttpAction, defaultExit,
  diagnosticsAt, exitEdit, insertEdits, isSecretRef, moveTarget, newDisclosure, newHttpAction, newStage, pathKey,
  pathStartsWith, removeEdit, samePath, secretRefsIn, stageToggleEdits, stageToolEdit, swapEdits, toolInventory,
  wordBudgetTone, worstSeverity, type Edit,
} from "@/client/studio/configure";
import { ConnectorSchema, StageSchema } from "@/core/contracts/v2/blueprint";
import { serialize, type CodeDiagnostic } from "@/core/relay-code";

import { applyAll, applyAndParse, commentedDental, parse } from "./helpers";

const diag = (over: Partial<CodeDiagnostic> = {}): CodeDiagnostic => ({
  source: "lint", code: "L1", severity: "error", path: ["fields", 0, "id"], message: "duplicate id", range: null, ...over,
});

describe("sections", () => {
  it("covers exactly the six §5.5 names, and lists the six that have no form", () => {
    expect(SECTIONS.map((s) => s.id)).toEqual(["fields", "handoff", "greeting", "stages", "disclosures", "connectors"]);
    const titles = CODE_ONLY_SECTIONS.map((s) => s.title);
    for (const required of ["Listening", "Prompt template", "Case JSON", "Extraction", "Compliance"]) {
      expect(titles).toContain(required);
    }
  });

  it("points every code-only section at a path that exists in a real blueprint", () => {
    const bp = parse(commentedDental()) as unknown as Record<string, unknown>;
    for (const s of CODE_ONLY_SECTIONS) {
      let node: unknown = bp;
      for (const key of s.path) node = (node as Record<string, unknown>)[String(key)];
      expect(node, `${s.title} → ${pathKey(s.path)}`).toBeDefined();
    }
  });
});

describe("paths and diagnostics", () => {
  it("matches a prefix, an exact path, and neither for a sibling", () => {
    expect(pathStartsWith(["fields", 2, "label"], ["fields", 2])).toBe(true);
    expect(pathStartsWith(["fields", 2], ["fields", 2, "label"])).toBe(false);
    expect(samePath(["fields", 2], ["fields", 2])).toBe(true);
    expect(samePath(["fields", 2, "label"], ["fields", 2])).toBe(false);
    // A numeric 2 and the string "2" are the same step: zod issues carry numbers, a React key carries a string.
    expect(pathStartsWith(["fields", "2"], ["fields", 2])).toBe(true);
  });

  it("gives a row its children's errors and an input only its own", () => {
    const list = [diag({ path: ["fields", 0, "label"] }), diag({ path: ["fields", 0] }), diag({ path: ["fields", 1] })];
    expect(diagnosticsAt(list, ["fields", 0])).toHaveLength(2);
    expect(diagnosticsAt(list, ["fields", 0], { match: "exact" })).toHaveLength(1);
  });

  it("reports the worst severity in a set", () => {
    expect(worstSeverity([])).toBeNull();
    expect(worstSeverity([diag({ severity: "warn" })])).toBe("warn");
    expect(worstSeverity([diag({ severity: "warn" }), diag({ severity: "error" })])).toBe("error");
  });
});

describe("list order", () => {
  it("refuses to move past either end", () => {
    expect(moveTarget(3, 0, "up")).toBeNull();
    expect(moveTarget(3, 2, "down")).toBeNull();
    expect(moveTarget(3, 1, "up")).toBe(0);
    expect(moveTarget(3, 1, "down")).toBe(2);
    expect(moveTarget(3, 9, "up")).toBeNull();
  });

  it("swaps two fields in the real document and leaves every comment in place", () => {
    const text = commentedDental();
    const before = parse(text);
    const [a, b] = [before.fields[0]!.id, before.fields[1]!.id];
    const { text: next, blueprint } = applyAndParse(text, swapEdits(["fields"], before.fields, 0, 1));
    expect([blueprint.fields[0]!.id, blueprint.fields[1]!.id]).toEqual([b, a]);
    expect(blueprint.fields).toHaveLength(before.fields.length);
    expect(next).toContain("# --- the case fields ---");
    expect(next).toContain("# --- where the baton changes hands ---");
    expect(next).toContain("# yaml-language-server:");
  });

  it("appends and removes without disturbing the rest of the list", () => {
    const text = commentedDental();
    const bp = parse(text);
    const added = applyAndParse(text, [appendEdit(["playbook", "disclosures"], bp.playbook.disclosures, newDisclosure([]))]);
    expect(added.blueprint.playbook.disclosures).toHaveLength(bp.playbook.disclosures.length + 1);
    const removed = applyAndParse(added.text, [removeEdit(["playbook", "disclosures"], bp.playbook.disclosures.length)]);
    expect(removed.blueprint.playbook.disclosures).toHaveLength(bp.playbook.disclosures.length);
    expect(removed.text).toContain("# --- what it can actually do ---");
  });
});

describe("insertEdits", () => {
  /** A plain-array check of the bubble, because the off-by-one it guards against is invisible in YAML. */
  const run = (items: string[], index: number, value: string): string[] => {
    const work = [...items];
    for (const e of insertEdits(["x"], items, index, value)) {
      const i = e.path[1] as number;
      if (i === work.length) work.push(e.value as string);
      else work[i] = e.value as string;
    }
    return work;
  };

  it("inserts at the front, the middle and the end", () => {
    expect(run(["a", "b", "c"], 0, "N")).toEqual(["N", "a", "b", "c"]);
    expect(run(["a", "b", "c"], 1, "N")).toEqual(["a", "N", "b", "c"]);
    expect(run(["a", "b", "c"], 3, "N")).toEqual(["a", "b", "c", "N"]);
    expect(run([], 0, "N")).toEqual(["N"]);
  });

  it("clamps an index past the end rather than leaving a hole", () => {
    expect(run(["a"], 9, "N")).toEqual(["a", "N"]);
  });

  it("costs one write per item it actually shifts, and no more", () => {
    // append + 3 swaps × 2 writes: only the items between the target and the end are rewritten.
    expect(insertEdits(["x"], ["a", "b", "c"], 0, "N")).toHaveLength(7);
    expect(insertEdits(["x"], ["a", "b", "c"], 3, "N")).toHaveLength(1);
  });
});

describe("stages", () => {
  const bp = parse(commentedDental());

  it("builds the tool inventory the way lint does", () => {
    const names = toolInventory(bp).map((t) => t.name);
    expect(names.slice(0, 2)).toEqual(["update_case_field", "hand_back_to_rep"]);
    expect(names).toContain("get_disclosure");
    for (const c of bp.connectors) if ("toolName" in c) expect(names).toContain(c.toolName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("drops get_disclosure when the relay has no disclosures", () => {
    const stripped = { ...bp, playbook: { ...bp.playbook, disclosures: [] } };
    expect(toolInventory(stripped).map((t) => t.name)).not.toContain("get_disclosure");
  });

  it("never lets the two required tools be unchecked", () => {
    for (const name of REQUIRED_STAGE_TOOLS) {
      expect(stageToolEdit(0, ["update_case_field", "hand_back_to_rep", "x"], name, false)).toBeNull();
    }
    expect(toolInventory(bp).filter((t) => t.required).map((t) => t.name)).toEqual([...REQUIRED_STAGE_TOOLS]);
  });

  it("keeps a tool list inside the schema's 2..6 and keeps the author's order", () => {
    const tools = ["update_case_field", "hand_back_to_rep"];
    const added = stageToolEdit(0, tools, "get_disclosure", true);
    expect(added?.value).toEqual([...tools, "get_disclosure"]);
    expect(stageToolEdit(0, tools, "get_disclosure", false)).toBeNull(); // not there: nothing to do
    const six = ["a", "b", "c", "d", "e", "f"];
    expect(stageToolEdit(0, six, "g", true)).toBeNull();
  });

  it("writes a tool change the schema still accepts", () => {
    const stage = bp.playbook.stages[0]!;
    const edit = stageToolEdit(0, stage.tools, "get_disclosure", !stage.tools.includes("get_disclosure"));
    const { blueprint } = applyAndParse(commentedDental(), edit ? [edit] : []);
    expect(StageSchema.safeParse(blueprint.playbook.stages[0]).success).toBe(true);
  });

  it("toggles a kind off and back on, landing it in call order", () => {
    const text = commentedDental();
    const kinds = (b: typeof bp) => b.playbook.stages.map((s) => s.kind);
    const present = kinds(bp);
    const victim = present.find((k) => k !== present[0]) ?? present[0]!;

    const off = applyAndParse(text, stageToggleEdits(bp, victim, false));
    expect(kinds(off.blueprint)).not.toContain(victim);

    const on = applyAndParse(off.text, stageToggleEdits(off.blueprint, victim, true));
    const back = kinds(on.blueprint);
    expect(back).toContain(victim);
    // Call order: the kinds appear in STAGE_ORDER order, never shuffled by the insert.
    const ranks = back.map((k) => STAGE_ORDER.indexOf(k));
    expect([...ranks].sort((x, y) => x - y)).toEqual(ranks);
    expect(on.text).toContain("# --- the case fields ---");
  });

  it("refuses to switch off the last stage", () => {
    const one = { ...bp, playbook: { ...bp.playbook, stages: [bp.playbook.stages[0]!] } };
    expect(stageToggleEdits(one, one.playbook.stages[0]!.kind, false)).toEqual([]);
  });

  it("refuses to switch on a kind that is already there, or a fifth stage", () => {
    const kind = bp.playbook.stages[0]!.kind;
    expect(stageToggleEdits(bp, kind, true)).toEqual([]);
    const four = { ...bp, playbook: { ...bp.playbook, stages: STAGE_ORDER.map((k) => newStage(k, bp)) } };
    const missing = STAGE_ORDER.find((k) => !four.playbook.stages.some((s) => s.kind === k));
    expect(missing).toBeUndefined();
  });

  it("makes a new stage that passes StageSchema and only lists tools the relay has", () => {
    const inventory = new Set(toolInventory(bp).map((t) => t.name));
    for (const kind of STAGE_ORDER) {
      const stage = newStage(kind, bp);
      expect(StageSchema.safeParse(stage).success, `${kind}: ${JSON.stringify(StageSchema.safeParse(stage).error?.issues)}`).toBe(true);
      expect(stage.tools.length).toBeGreaterThanOrEqual(2);
      expect(stage.tools.length).toBeLessThanOrEqual(6);
      for (const t of stage.tools) expect(inventory.has(t)).toBe(true);
      for (const t of REQUIRED_STAGE_TOOLS) expect(stage.tools).toContain(t);
    }
  });

  it("gives a new stage an id no other stage is using", () => {
    const ids = new Set(bp.playbook.stages.map((s) => s.id));
    for (const kind of STAGE_ORDER) expect(ids.has(newStage(kind, bp).id)).toBe(false);
  });

  it("defaults an exit to something the relay can actually point at", () => {
    expect(defaultExit("close", bp)).toEqual({ kind: "end" });
    const disclose = defaultExit("disclose", bp);
    if (bp.playbook.disclosures.length > 0) {
      expect(disclose).toEqual({ kind: "disclosure_accepted", disclosure: bp.playbook.disclosures[0]!.id });
    }
    const bare = { ...bp, playbook: { ...bp.playbook, disclosures: [] }, connectors: [] };
    expect(defaultExit("disclose", bare)).toEqual({ kind: "all_required_verified" });
    expect(defaultExit("act", bare)).toEqual({ kind: "all_required_verified" });
  });

  it("writes the exit as one object, so the union never passes through an illegal shape", () => {
    const edit = exitEdit(0, { kind: "end" });
    expect(edit.path).toEqual(["playbook", "stages", 0, "exit"]);
    const { blueprint } = applyAndParse(commentedDental(), [edit]);
    expect(blueprint.playbook.stages[0]!.exit).toEqual({ kind: "end" });
  });
});

describe("disclosures", () => {
  it("makes one that validates and asks the customer a question", () => {
    const bp = parse(commentedDental());
    const d = newDisclosure(bp.playbook.disclosures.map((x) => x.id));
    expect(bp.playbook.disclosures.some((x) => x.id === d.id)).toBe(false);
    expect(d.text).toMatch(/\?$/);
    const { blueprint } = applyAndParse(commentedDental(), [appendEdit(["playbook", "disclosures"], bp.playbook.disclosures, d)]);
    expect(blueprint.playbook.disclosures.at(-1)!.id).toBe(d.id);
  });

  it("avoids an id the blueprint already uses", () => {
    expect(newDisclosure(["disclosure"]).id).toBe("disclosure_2");
    expect(newDisclosure(["disclosure", "disclosure_2"]).id).toBe("disclosure_3");
  });
});

describe("greeting budget", () => {
  it("warns within three words of the budget and fails over it", () => {
    expect(wordBudgetTone(20, 40)).toBe("ok");
    expect(wordBudgetTone(36, 40)).toBe("ok");
    expect(wordBudgetTone(37, 40)).toBe("close");
    expect(wordBudgetTone(40, 40)).toBe("close");
    expect(wordBudgetTone(41, 40)).toBe("over");
  });
});

describe("secrets", () => {
  it("finds every well-formed reference and ignores a malformed one", () => {
    const good = `sec_${"a1b2c3d4e5f60718"}`;
    const value = { a: { $secret: good }, b: [{ $secret: "sec_TOO-SHORT" }, { $secret: good }] };
    expect(secretRefsIn(value)).toEqual([good]);
    expect(isSecretRef({ $secret: "anything" })).toBe(true);
    expect(isSecretRef({ secret: "x" })).toBe(false);
    expect(isSecretRef(null)).toBe(false);
  });

  it("reads the picker's inventory out of the relay's own connectors", () => {
    const bp = parse(commentedDental());
    for (const id of secretRefsIn(bp.connectors)) expect(id).toMatch(/^sec_[a-z0-9]{16}$/);
  });
});

describe("HTTP actions", () => {
  it("is a Pro and Business capability, and is not gated where there is no plan layer", () => {
    expect(canAddHttpAction(null)).toBe(true);
    expect(canAddHttpAction("pro")).toBe(true);
    expect(canAddHttpAction("business")).toBe(true);
    expect(canAddHttpAction("free")).toBe(false);
    expect(canAddHttpAction("guest")).toBe(false);
  });

  it("adds one that validates, with an id and a tool name nothing else is using", () => {
    const bp = parse(commentedDental());
    const taken = [...bp.connectors.map((c) => c.id), ...bp.connectors.flatMap((c) => ("toolName" in c ? [c.toolName] : []))];
    const c = newHttpAction(taken);
    expect(ConnectorSchema.safeParse(c).success).toBe(true);
    expect(taken).not.toContain(c.id);
    expect(taken).not.toContain(c.toolName);
    // Nothing reaches the assistant until the builder says what may: §5.6's rule, visible in the skeleton.
    expect(c.responsePick).toEqual([]);
    expect(c.hmacSecret).toBeNull();
    const { blueprint } = applyAndParse(commentedDental(), [appendEdit(["connectors"], bp.connectors, c)]);
    expect(blueprint.connectors.at(-1)!.id).toBe(c.id);
  });

  it("does not collide when it is added twice", () => {
    const first = newHttpAction([]);
    const second = newHttpAction([first.id, first.toolName]);
    expect(second.id).not.toBe(first.id);
    expect(second.toolName).not.toBe(first.toolName);
  });
});

describe("a whole session of form edits", () => {
  /**
   * Acceptance 1, as far as a unit test can carry it: several unrelated form edits in a row leave a document that
   * still parses, still passes zod, and still has the author's comments.
   *
   * Each control's click is its own `applyFormEdits` call and the store re-parses in between, so the test
   * re-parses too. That is not a formality: `swapEdits` reads the items out of the blueprint it is handed, so
   * batching a rename and a move of the *same* field from one snapshot would write the pre-rename value back.
   * Inside one batch the edits are independent by construction (a swap, a type change), which is exactly why
   * `applyFormEdits` exists and why nothing else is ever batched.
   */
  it("survives a mixed run of edits", () => {
    let text = commentedDental();
    text = applyAll(text, [
      { path: ["fields", 0, "label"], value: "Patient (renamed by the form)" },
      { path: ["handoff", "allowedWhen", "minCallSeconds"], value: 45 },
      { path: ["playbook", "greeting", "maxWords"], value: 34 },
    ]);

    const mid = parse(text);
    text = applyAll(text, swapEdits(["fields"], mid.fields, 0, 1));
    text = applyAll(text, [exitEdit(0, defaultExit(mid.playbook.stages[0]!.kind, mid))]);

    const after = parse(text);
    expect(after.fields[1]!.label).toBe("Patient (renamed by the form)");
    expect(after.handoff.allowedWhen.minCallSeconds).toBe(45);
    expect(after.playbook.greeting.maxWords).toBe(34);
    expect(text).toContain("# --- the case fields ---");
    expect(text).toContain("# --- where the baton changes hands ---");
    expect(text).toContain("# --- what it can actually do ---");
  });

  it("applies the same edits to a JSON document, where there are no comments to keep", () => {
    const json = serialize(parse(commentedDental()), "json");
    const out = applyAll(json, [{ path: ["playbook", "greeting", "maxWords"], value: 31 }] as Edit[], "json");
    expect((JSON.parse(out) as { playbook: { greeting: { maxWords: number } } }).playbook.greeting.maxWords).toBe(31);
  });
});
