import { describe, expect, it } from "vitest";
import {
  parseTemplate, parseTemplatePath, printTemplate, renderTemplate, templateDepth, templateRefs, templateVars,
  TemplateSyntaxError, tryParseTemplate, type RenderScope, type TemplateCond,
} from "@/core/relay/template";

const ROUND_TRIP = [
  "",
  "plain text",
  "Hi {customer.firstName}, I'm {org.name}'s AI assistant.",
  "{?f.driver_full_name.verified}{f.driver_full_name|first_name}{:}the new driver{/?}",
  "{?!f.x_y.pending}a{:}b{/?}",
  "{?f.vehicle_assignment=all}all cars{/?}",
  "{?v.deposit}{v.deposit|spoken_money}{/?} {?opt.tax_suffix} plus tax{/?}",
  "literal {{braces}} and }} alone",
  "{?f.a1.verified}{?f.b1.rep}{?f.c1.known}deep{/?}{/?}{/?}",
  "{f.zip.display} {f.zip.raw} {fact.policy_number} {call.date|spoken_date_long} {rep.firstName}",
  "{subject} {clause.date} {phrase.confirm} {phrase.ask} {stage} {stage.goal} {case.json} {intent.summary}",
  "{roles.rep} {roles.customer} {roles.org} {persona.tone} {customer.fullName} {customer.phoneLast4|spoken_chars}",
  "{?f.a1.missing}{:}{/?}",
];

describe("template grammar (PLATFORM §3.3)", () => {
  it.each(ROUND_TRIP)("round-trips %j", (src) => {
    const ast = parseTemplate(src);
    expect(printTemplate(ast)).toBe(src);
    expect(parseTemplate(printTemplate(ast))).toEqual(ast);
  });

  it("merges text and unescapes braces", () => {
    expect(parseTemplate("a {{b}} c")).toEqual([{ type: "text", text: "a {b} c" }]);
  });

  it("parses vars, formatters and conditions", () => {
    const ast = parseTemplate("{?!f.driver_dob.verified}x{:}{f.driver_dob|spoken_dob}{/?}");
    expect(ast).toEqual([{
      type: "section",
      cond: { kind: "field_status", negate: true, field: "driver_dob", status: "verified" },
      then: [{ type: "text", text: "x" }],
      else: [{ type: "var", path: "f.driver_dob", ref: { kind: "field", id: "driver_dob", part: "value" }, formatter: "spoken_dob" }],
    }]);
  });

  const BAD: [string, RegExp][] = [
    ["{customer.middleName}", /unknown path/],
    ["{f.X}", /unknown path/],
    ["{f.a1.verified}", /unknown path/],
    ["{org.name|Bad-Fmt}", /bad formatter/],
    ["{org.name|raw|title}", /at most one formatter/],
    ["{org.name", /unterminated/],
    ["a } b", /lone "}"/],
    ["{?f.a1.verified}open", /never closed/],
    ["{?f.a1.verified}a{:}b{:}c{/?}", /two "\{:\}"/],
    ["{:}", /outside a section/],
    ["{/?}", /without an open section/],
    ["{?f.a1.maybe}x{/?}", /unknown section condition/],
    ["{?f.a1.verified}{?f.a1.verified}{?f.a1.verified}{?f.a1.verified}4{/?}{/?}{/?}{/?}", /deeper than 3/],
  ];
  it.each(BAD)("rejects %j", (src, re) => {
    expect(() => parseTemplate(src)).toThrow(TemplateSyntaxError);
    const r = tryParseTemplate(src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(re);
  });

  it("depth 3 is allowed", () => {
    expect(templateDepth(parseTemplate("{?f.a1.verified}{?f.b1.rep}{?f.c1.known}deep{/?}{/?}{/?}"))).toBe(3);
  });

  it("parseTemplatePath covers the grammar", () => {
    expect(parseTemplatePath("fact.policy_number")).toEqual({ kind: "fact", key: "policy_number" });
    expect(parseTemplatePath("v.monthly_premium")).toEqual({ kind: "value", id: "monthly_premium" });
    expect(parseTemplatePath("f.garaging_zip.display")).toEqual({ kind: "field", id: "garaging_zip", part: "display" });
    expect(parseTemplatePath("table.vehicles.label")).toBeNull();
    expect(parseTemplatePath("f.a")).toBeNull(); // ids are ≥ 2 chars (IdSchema)
  });
});

describe("render and references", () => {
  const scope = (known: Record<string, string>, verified: string[]): RenderScope => ({
    resolve: (ref) => (ref.kind === "field" ? known[ref.id] ?? null : ref.kind === "org" ? "Harborview" : null),
    test: (c: TemplateCond) => c.kind === "field_status" && c.status === "verified" && verified.includes(c.field),
    format: (fmt, v) => (fmt === "first_name" ? v.split(" ")[0]! : fmt === "lower" ? v.toLowerCase() : v),
  });
  const SUBJECT = parseTemplate("{?f.driver_full_name.verified}{f.driver_full_name|first_name}{:}the new driver{/?}");

  it("renders sections, else-branches, formatters and nulls", () => {
    expect(renderTemplate(SUBJECT, scope({ driver_full_name: "Priya Shah" }, ["driver_full_name"]))).toBe("Priya");
    expect(renderTemplate(SUBJECT, scope({ driver_full_name: "Priya Shah" }, []))).toBe("the new driver");
    expect(renderTemplate(parseTemplate("{?!f.zz_top.verified}no{/?}|{f.zz_top}|{org.name|lower}"), scope({}, []))).toBe("no||harborview");
  });

  it("templateVars records the enclosing guards", () => {
    const vars = templateVars(parseTemplate("{f.aa} {?f.bb.verified}{f.bb}{:}{f.cc}{/?}"));
    expect(vars.map((v) => [v.path, v.guards.map((g) => g.branch)])).toEqual([["f.aa", []], ["f.bb", ["then"]], ["f.cc", ["else"]]]);
  });

  it("templateRefs lists distinct references", () => {
    const r = templateRefs(parseTemplate("{f.aa}{f.aa.display}{fact.ff|title}{?v.vv}{clause.cc}{/?}{?opt.tax_suffix}x{/?}{?f.bb=all}y{/?}"));
    expect(r.fields.sort()).toEqual(["aa", "bb"]);
    expect(r.facts).toEqual(["ff"]);
    expect(r.values).toEqual(["vv"]);
    expect(r.clauses).toEqual(["cc"]);
    expect(r.opts).toEqual(["tax_suffix"]);
    expect(r.formatters).toEqual(["title"]);
  });
});
