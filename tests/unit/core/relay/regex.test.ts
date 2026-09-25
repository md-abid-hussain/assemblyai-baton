import { describe, expect, it } from "vitest";
import { GREETING_DISCLOSURE_RES } from "@/core/compiler/greeting";
import {
  __regexCacheForTests, checkRegexGrammar, checkSafeRegexSource, compileSafeRegex, compileSafeUnion, isSafeRegexSource,
  isSafeToolPattern, RegexSchema, safeExec, safeTest, safeTestToolPattern, SAFE_REGEX_CACHE_MAX, ToolPatternSchema,
  UnsafeRegexError,
} from "@/core/contracts/v2";
import { ADVICE_RE, FIELD_LEXICON } from "@/core/intents/add-driver";

const MUST_FAIL: [string, string][] = [
  ["(a|a)*$", "nested_quantifier"],
  ["(a+)+$", "nested_quantifier"],
  ["(a|ab)*c", "nested_quantifier"],
  ["(\\w+\\s?)*$", "nested_quantifier"],
  ["\\1", "backreference"],
  ["(a)\\1", "backreference"],
  ["(?<x>a)\\k<x>", "backreference"],
  ["(?=a)", "lookaround"],
  ["(?!a)b", "lookaround"],
  ["(?<=a)b", "lookaround"],
  ["(?<!a)b", "lookaround"],
  ["(a|b){2,}", "nested_quantifier"],
  ["(a|b){1,3}", "nested_quantifier"],
  ["(ab+){2}", "nested_quantifier"],
  ["((a|b)c)+", "nested_quantifier"],
  ["(?:x(?:y|z))*", "nested_quantifier"],
  ["(?i:a)", "group_syntax"],
  ["(abc", "invalid"],
  ["abc)", "invalid"],
  ["[abc", "invalid"],
  ["*a", "invalid"],
];

const MUST_PASS = [
  "(an? )?", "(?:\\.\\d+)?", "(lives? with (us|me|them)|roommate)", "\\d{5}", "[a-z]+", "(?:ab)+", "(a|b)?",
  "(a|b){0,1}", "(a+){1}", "\\p{L}+", "\\u{1F600}", "^\\d{4}-\\d{2}-\\d{2}$", "[(|)*+]+", "a+?b*?", "\\bfoo\\b",
  "(?<word>ab)c", "x{2,3}",
];

describe("safe regex grammar (PLATFORM §3.2 Regex safety)", () => {
  it.each(MUST_FAIL)("rejects %s (%s)", (src, code) => {
    const c = checkSafeRegexSource(src);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.code).toBe(code);
    expect(isSafeRegexSource(src)).toBe(false);
    expect(isSafeToolPattern(src)).toBe(false);
  });

  it.each(MUST_PASS)("accepts %s", (src) => {
    expect(checkSafeRegexSource(src)).toEqual({ ok: true });
  });

  it("names the offending group (lint X3 message)", () => {
    const c = checkRegexGrammar("^x(a|ab)*c$");
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.group).toBe("(a|ab)");
      expect(c.message).toContain("\"(a|ab)\"");
      expect(c.message).toContain("alternation");
    }
    const d = checkRegexGrammar("(\\w+\\s?)*$");
    if (!d.ok) expect(d.message).toContain("another quantifier");
  });

  it("enforces empty and ≤ 200 chars", () => {
    expect(checkSafeRegexSource("").ok).toBe(false);
    expect(isSafeRegexSource("a".repeat(200))).toBe(true);
    expect(isSafeRegexSource("a".repeat(201))).toBe(false);
  });

  it("every legacy Baton pattern passes (lexicon, advice, greeting disclosure)", () => {
    const sources = [
      ...Object.values(FIELD_LEXICON).flatMap((e) => [...(e?.ask ?? []), ...(e?.weak ?? [])]).map((r) => r.source),
      ADVICE_RE.source,
      ...GREETING_DISCLOSURE_RES.map((r) => r.source),
    ];
    expect(sources.length).toBeGreaterThan(15);
    for (const s of sources) expect({ s, check: checkSafeRegexSource(s) }).toEqual({ s, check: { ok: true } });
  });

  it("tool patterns compile without flags; blueprint regexes need the iu flags", () => {
    // `\-` is an identity escape: legal without flags, a SyntaxError in unicode mode.
    expect(isSafeToolPattern("^a\\-b$")).toBe(true);
    expect(isSafeRegexSource("^a\\-b$")).toBe(false);
    expect(ToolPatternSchema.safeParse("^\\d{4}-\\d{2}-\\d{2}$").success).toBe(true);
    expect(ToolPatternSchema.safeParse("(a+)+").success).toBe(false);
    expect(RegexSchema.safeParse("(a|a)*$").success).toBe(false);
    expect(RegexSchema.safeParse("AI assistant").success).toBe(true);
  });
});

describe("safeTest / safeExec", () => {
  it("matches case-insensitively in unicode mode", () => {
    expect(safeTest("not a person", "I'm NOT A PERSON.")).toBe(true);
    expect(safeTest("\\p{Lu}", "é")).toBe(true);       // i flag: é matches \p{Lu} case-insensitively
    expect(safeExec("(\\d{5})", "zip 62701 ok")?.[1]).toBe("62701");
  });

  it("truncates the input to 1000 chars", () => {
    expect(safeTest("x", `${"a".repeat(999)}x`)).toBe(true);
    expect(safeTest("x", `${"a".repeat(1000)}x`)).toBe(false);
  });

  it("never compiles or matches an unsafe pattern (fast, false)", () => {
    const t0 = Date.now();
    expect(safeTest("(a+)+$", `${"a".repeat(40)}b`)).toBe(false);
    expect(safeTest("(a|a)*$", "a".repeat(40))).toBe(false);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("tool-pattern matching has no flags", () => {
    expect(safeTestToolPattern("^[A-Z]{2}$", "CA")).toBe(true);
    expect(safeTestToolPattern("^[A-Z]{2}$", "ca")).toBe(false);
  });

  it("keeps an LRU of at most 500 compiled patterns per mode", () => {
    __regexCacheForTests.clear();
    for (let i = 0; i < SAFE_REGEX_CACHE_MAX + 100; i++) safeTest(`k${i}`, "x");
    expect(__regexCacheForTests.sizes().blueprint).toBe(SAFE_REGEX_CACHE_MAX);
  });

  it("compileSafeRegex throws on unsafe input; compileSafeUnion ORs safe sources", () => {
    expect(() => compileSafeRegex("(a+)+")).toThrow(UnsafeRegexError);
    const re = compileSafeUnion(["recommend\\w*", "you should"]);
    expect(re.test("I'd RECOMMEND it")).toBe(true);
    expect(re.test("you should")).toBe(true);
    expect(re.test("fine")).toBe(false);
    expect(compileSafeUnion([]).test("anything")).toBe(false);
    expect(() => compileSafeUnion(["ok", "(a|b)+"])).toThrow(UnsafeRegexError);
  });
});
