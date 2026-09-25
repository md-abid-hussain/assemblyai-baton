/**
 * contracts/v2/regex.ts - the SAFE REGEX GRAMMAR for blueprint-authored patterns (PLATFORM §3.2 "Regex safety",
 * TASKS-v2 §2 rule 10). WP14a; frozen at C2 (additive changes only). Pure and isomorphic (no Node, no DOM).
 *
 * Every regex that comes from a blueprint (a stranger's text) is matched ONLY through `safeTest()` / `safeExec()`,
 * or through a RegExp built here by `compileSafeRegex()` / `compileSafeUnion()`. A raw `new RegExp(<blueprint
 * string>)` anywhere else fails the boundaries test (tests/unit/core/relay/boundaries-regex.test.ts).
 *
 * The grammar (a ReDoS guard, enforced at parse time by `RegexSchema`/`ToolPatternSchema` and again by lint X3):
 *  - no backreferences: `\1`..`\9`, `\k<name>`;
 *  - no lookaround: `(?=`, `(?!`, `(?<=`, `(?<!`; the only `(?` groups are `(?:` and named `(?<name>`;
 *  - a REPEATING quantifier (`*`, `+`, `{n,}`, `{n,m}` with m > 1, and `{n}` with n > 1, which is `{n,n}`) never
 *    applies to a group that contains (at any depth) an alternation or another quantifier;
 *  - `?`, `{0,1}`, `{1}` and `{0}` may apply to any group (bounded: Baton's `(an? )?` and `(?:\.\d+)?` pass);
 *  - quantifiers on single atoms (a char, an escape, a class, `.`) are always fine (`\d{5}`, `[a-z]+`, `\w*`);
 *  - ≤ 200 chars, and the source must compile: with the "iu" flags for blueprint regexes, with NO flags for Voice
 *    Agent tool-parameter patterns (JSON Schema `pattern` has no flags).
 * So `(a|a)*$`, `(a+)+$`, `(a|ab)*c`, `(\w+\s?)*$`, `\1` and `(?=a)` are rejected.
 *
 * Backstop (WP12): V8's `--enable-experimental-regexp-engine-on-excessive-backtracks`. The grammar rules out
 * backreferences and lookaround, so V8 can always fall back to its linear engine. Polynomial blow-ups such as
 * `\s*\s*\s*$` are left to that backstop plus the 1000-char input cap.
 */

/** Max length of a blueprint regex or tool pattern source. */
export const REGEX_MAX_CHARS = 200;
/** `safeTest`/`safeExec` truncate their input to this many chars. */
export const SAFE_TEST_MAX_INPUT = 1000;
/** Compiled patterns kept per flag mode (LRU). */
export const SAFE_REGEX_CACHE_MAX = 500;
/** Blueprint regexes are always matched case-insensitively in unicode mode. */
export const BLUEPRINT_REGEX_FLAGS = "iu";

export type RegexCheckCode =
  | "empty" | "too_long" | "backreference" | "lookaround" | "group_syntax" | "nested_quantifier" | "invalid";

export type RegexCheck =
  | { ok: true }
  | {
      ok: false;
      code: RegexCheckCode;
      /** Human text; for `nested_quantifier` it names the offending group (lint X3 shows it). */
      message: string;
      /** Offset in the source, when known. */
      index: number | null;
      /** The offending group's source, e.g. "(a|a)", for `nested_quantifier`. */
      group: string | null;
    };

const fail = (code: RegexCheckCode, message: string, index: number | null = null, group: string | null = null): RegexCheck =>
  ({ ok: false, code, message, index, group });

interface Frame {
  /** Index of the "(" (−1 for the top level). */
  start: number;
  /** Contains an alternation, at any depth. */
  alt: boolean;
  /** Contains a quantifier, at any depth. */
  quant: boolean;
}

type Last = null | { kind: "atom" } | { kind: "group"; frame: Frame; end: number };

/** Reads a quantifier at `i`: its length (without a lazy `?`) and whether it repeats (more than once). */
function readQuantifier(src: string, i: number): { len: number; repeats: boolean; text: string } | null {
  const c = src[i];
  if (c === "*" || c === "+") return { len: 1, repeats: true, text: c };
  if (c === "?") return { len: 1, repeats: false, text: c };
  if (c !== "{") return null;
  const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i, i + 24));
  if (!m) return null;
  const n = Number(m[1]);
  let repeats: boolean;
  if (m[2] === undefined) repeats = n > 1;                  // {n} = {n,n}
  else if (m[3] === "") repeats = true;                      // {n,}
  else repeats = Number(m[3]) > 1;                           // {n,m}
  return { len: m[0].length, repeats, text: m[0] };
}

/**
 * Grammar check only (no compile, no length check). Returns the first violation.
 * Exposed for lint X3 (which reports `message`, naming the offending group).
 */
export function checkRegexGrammar(src: string): RegexCheck {
  const stack: Frame[] = [{ start: -1, alt: false, quant: false }];
  const top = (): Frame => stack[stack.length - 1]!;
  let last: Last = null;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") {
      const n = src[i + 1];
      if (n === undefined) return fail("invalid", "the pattern ends with a lone backslash", i);
      if (n >= "1" && n <= "9") return fail("backreference", `backreference "\\${n}" is not allowed`, i);
      if (n === "k") return fail("backreference", "named backreference \"\\k<…>\" is not allowed", i);
      let j = i + 2;
      if ((n === "p" || n === "P" || n === "u") && src[j] === "{") {
        const close = src.indexOf("}", j);
        if (close < 0) return fail("invalid", `unterminated "\\${n}{" escape`, i);
        j = close + 1;
      } else if (n === "u") j += 4;
      else if (n === "x") j += 2;
      else if (n === "c") j += 1;
      i = Math.min(j, src.length);
      last = { kind: "atom" };
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      if (src[j] === "^") j++;
      while (j < src.length && src[j] !== "]") j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) return fail("invalid", "unterminated character class", i);
      i = j + 1;
      last = { kind: "atom" };
      continue;
    }
    if (c === "(") {
      if (src[i + 1] === "?") {
        const n2 = src[i + 2];
        if (n2 === ":") {
          stack.push({ start: i, alt: false, quant: false });
          i += 3;
        } else if (n2 === "=" || n2 === "!") {
          return fail("lookaround", `lookahead "(?${n2}" is not allowed`, i);
        } else if (n2 === "<") {
          const n3 = src[i + 3];
          if (n3 === "=" || n3 === "!") return fail("lookaround", `lookbehind "(?<${n3}" is not allowed`, i);
          const gt = src.indexOf(">", i + 3);
          if (gt < 0) return fail("invalid", "unterminated group name", i);
          stack.push({ start: i, alt: false, quant: false });
          i = gt + 1;
        } else {
          return fail("group_syntax", "only \"(…)\", \"(?:…)\" and \"(?<name>…)\" groups are allowed", i);
        }
      } else {
        stack.push({ start: i, alt: false, quant: false });
        i++;
      }
      last = null;
      continue;
    }
    if (c === ")") {
      if (stack.length === 1) return fail("invalid", "unbalanced \")\"", i);
      const f = stack.pop()!;
      const parent = top();
      parent.alt ||= f.alt;
      parent.quant ||= f.quant;
      last = { kind: "group", frame: f, end: i };
      i++;
      continue;
    }
    if (c === "|") {
      top().alt = true;
      last = null;
      i++;
      continue;
    }
    const q = readQuantifier(src, i);
    if (q) {
      if (!last) return fail("invalid", `quantifier "${q.text}" has nothing to repeat`, i);
      if (q.repeats && last.kind === "group" && (last.frame.alt || last.frame.quant)) {
        const group = src.slice(last.frame.start, last.end + 1);
        const why = last.frame.alt ? "an alternation" : "another quantifier";
        return fail("nested_quantifier",
          `the group "${group}" is repeated with "${q.text}" but contains ${why} (ReDoS risk); use "?" or restructure`,
          last.frame.start, group);
      }
      top().quant = true;
      i += q.len;
      if (src[i] === "?") i++;   // lazy
      last = null;               // a quantified atom cannot be quantified again
      continue;
    }
    last = { kind: "atom" };
    i++;
  }
  if (stack.length !== 1) return fail("invalid", "unbalanced \"(\"", top().start);
  return { ok: true };
}

// The ONLY constructor of RegExp objects from blueprint sources in the codebase (boundaries test).
function tryCompile(src: string, flags: string): RegExp | null {
  try {
    return new RegExp(src, flags);
  } catch {
    return null;
  }
}

function checkWith(src: string, flags: string): RegexCheck {
  if (typeof src !== "string" || src.length === 0) return fail("empty", "the pattern is empty");
  if (src.length > REGEX_MAX_CHARS) return fail("too_long", `the pattern is longer than ${REGEX_MAX_CHARS} characters`);
  const g = checkRegexGrammar(src);
  if (!g.ok) return g;
  if (!tryCompile(src, flags)) {
    return fail("invalid", flags ? `the pattern does not compile with the "${flags}" flags` : "the pattern does not compile");
  }
  return { ok: true };
}

/** Full check of a blueprint regex: length, grammar, and `new RegExp(src, "iu")` compiles. */
export const checkSafeRegexSource = (src: string): RegexCheck => checkWith(src, BLUEPRINT_REGEX_FLAGS);
/** Full check of a Voice Agent tool-parameter `pattern`: length, grammar, and `new RegExp(src)` compiles. */
export const checkSafeToolPattern = (src: string): RegexCheck => checkWith(src, "");

export const isSafeRegexSource = (src: string): boolean => checkSafeRegexSource(src).ok;
export const isSafeToolPattern = (src: string): boolean => checkSafeToolPattern(src).ok;

export class UnsafeRegexError extends Error {
  constructor(readonly source: string, readonly check: Exclude<RegexCheck, { ok: true }>) {
    super(`unsafe or invalid regex: ${check.message}`);
    this.name = "UnsafeRegexError";
  }
}

/** LRU cache of compiled patterns per flag mode; `null` caches a rejected source. */
class RegexCache {
  private readonly map = new Map<string, RegExp | null>();
  constructor(private readonly flags: string, private readonly max: number) {}
  get(src: string): RegExp | null {
    const hit = this.map.get(src);
    if (hit !== undefined) {
      this.map.delete(src);
      this.map.set(src, hit);
      return hit;
    }
    const ok = checkWith(src, this.flags).ok;
    const re = ok ? tryCompile(src, this.flags) : null;
    this.map.set(src, re);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
    return re;
  }
  get size(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
}

const blueprintCache = new RegexCache(BLUEPRINT_REGEX_FLAGS, SAFE_REGEX_CACHE_MAX);
const toolPatternCache = new RegexCache("", SAFE_REGEX_CACHE_MAX);

const clip = (text: string): string => (text.length > SAFE_TEST_MAX_INPUT ? text.slice(0, SAFE_TEST_MAX_INPUT) : text);

/**
 * THE way to match a blueprint regex (flags "iu", input truncated to 1000 chars, compiled once, LRU 500).
 * An unsafe or invalid source never compiles and never matches (returns false): parse-time validation should
 * have rejected it already, and a run must never crash on a bad pattern.
 */
export function safeTest(src: string, text: string): boolean {
  const re = blueprintCache.get(src);
  return re ? re.test(clip(text)) : false;
}

/** Like `safeTest`, returning the (non-global) match, or null. */
export function safeExec(src: string, text: string): RegExpExecArray | null {
  const re = blueprintCache.get(src);
  return re ? re.exec(clip(text)) : null;
}

/** Match a tool-parameter `pattern` exactly as JSON Schema would (no flags), e.g. in `validateToolArgs`. */
export function safeTestToolPattern(src: string, text: string): boolean {
  const re = toolPatternCache.get(src);
  return re ? re.test(clip(text)) : false;
}

/**
 * A RegExp object for a blueprint source (flags "iu"), for the few seams that need one (e.g. `IntentSpec.adviceRe`).
 * Throws `UnsafeRegexError` for a source outside the grammar. Callers should still clip long inputs.
 */
export function compileSafeRegex(src: string): RegExp {
  const check = checkSafeRegexSource(src);
  if (!check.ok) throw new UnsafeRegexError(src, check);
  return blueprintCache.get(src)!;
}

/**
 * One RegExp matching any of `sources` (`(?:a)|(?:b)|…`, flags "iu"). Each source is checked first; a top-level
 * alternation is never quantified, so the union stays inside the grammar. An empty list matches nothing.
 */
export function compileSafeUnion(sources: readonly string[]): RegExp {
  if (sources.length === 0) return /(?!)/u;
  for (const s of sources) {
    const check = checkSafeRegexSource(s);
    if (!check.ok) throw new UnsafeRegexError(s, check);
  }
  const union = sources.map((s) => `(?:${s})`).join("|");
  const re = tryCompile(union, BLUEPRINT_REGEX_FLAGS);
  if (!re) throw new UnsafeRegexError(union, { ok: false, code: "invalid", message: "the union does not compile", index: null, group: null });
  return re;
}

/** Test hook: cache sizes and reset (not for product code). */
export const __regexCacheForTests = {
  sizes: () => ({ blueprint: blueprintCache.size, tool: toolPatternCache.size }),
  clear: () => { blueprintCache.clear(); toolPatternCache.clear(); },
};
