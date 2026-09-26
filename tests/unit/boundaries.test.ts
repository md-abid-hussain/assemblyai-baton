/**
 * Import boundaries (DESIGN §3.1) and the direct-open ban (DESIGN §2.3, TASKS §0.5).
 *
 * 1. `src/core/**` is pure: no `node:*`/Node built-in imports, no static `ws` import, no `window`/`document`
 *    globals, no `process.env`, and no imports of `src/server`, `src/client`, `src/app` or `src/components`.
 * 2. Browser code (`src/client/**`, `src/components/**`, any "use client" module) never imports `src/server/**`.
 * 3. Every `src/server/**` module starts with `import "server-only"` (except the drizzle schema, which drizzle-kit
 *    loads outside Next); every `src/client/**` module imports "client-only" (worklet sources exempt).
 * 4. Nobody opens AssemblyAI sessions or mints tokens directly: `StreamingSession.connect`, `connectNode(`,
 *    `connectWithToken(`, `mintStreamingToken(` and `.mintToken(` may only appear in the limits helpers
 *    (`src/server/limits/**`, `src/server/aai/tokens.ts`, `src/client/stt/**`, `src/client/va/**`,
 *    `scripts/lib/aai-open.ts`) and in the modules that define them. Bracket calls, optional chaining,
 *    `.call/.apply/.bind`, import aliases, assignments and destructuring count as opens too. Unit tests that
 *    inject an in-memory fake socket are allow-listed only while they cannot reach a credential or real socket.
 * 5. `tsconfig.json` excludes spikes, tools and research.
 *
 * Comments are stripped before matching, so documentation may mention the banned names.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CODE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const SELF = "tests/unit/boundaries.test.ts";

const toPosix = (p: string) => p.split(sep).join("/");

function listFiles(dir: string): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return (readdirSync(abs, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((d) => d.isFile() && CODE_EXT.test(d.name))
    .map((d) => toPosix(relative(ROOT, join(d.parentPath, d.name))))
    .filter((p) => !p.includes("/node_modules/"));
}

/** Remove // and /* *\/ comments, keeping string and template literal contents (import specifiers live there). */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") {
          out += src[i]! + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (q !== "`" && src[i] === "\n") break; // unterminated: bail to the next line
        out += src[i]!;
        i++;
      }
      if (i < n) out += src[i]!;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  rule: string;
  text: string;
}

function scan(files: string[], rules: { name: string; re: RegExp }[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const code = stripComments(readFileSync(join(ROOT, file), "utf8"));
    const lines = code.split("\n");
    lines.forEach((text, idx) => {
      for (const r of rules) if (r.re.test(text)) hits.push({ file, line: idx + 1, rule: r.name, text: text.trim().slice(0, 160) });
    });
  }
  return hits;
}

const fmt = (hits: Hit[]) => hits.map((h) => `${h.file}:${h.line} [${h.rule}] ${h.text}`).join("\n");

const NODE_BUILTINS =
  "assert|async_hooks|buffer|child_process|cluster|crypto|dgram|dns|events|fs|fs/promises|http|http2|https|inspector|module|net|os|path|path/posix|path/win32|perf_hooks|process|querystring|readline|stream|stream/promises|string_decoder|timers|timers/promises|tls|tty|url|util|v8|vm|worker_threads|zlib";
const importOf = (spec: string) =>
  new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)["'](?:${spec})["']`);

describe("DESIGN §3.1 import boundaries", () => {
  const core = listFiles("src/core");

  it("src/core is pure (no Node built-ins, static ws, DOM globals or process.env)", () => {
    const hits = scan(core, [
      { name: "node: import", re: /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']node:/ },
      { name: "node built-in import", re: importOf(NODE_BUILTINS) },
      { name: "static ws import", re: /\bfrom\s*["']ws["']|\brequire\s*\(\s*["']ws["']/ },
      { name: "window global", re: /(?<![.\w$])window\s*[.[]/ },
      { name: "document global", re: /(?<![.\w$])document\s*[.[]/ },
      { name: "process.env", re: /\bprocess\s*\.\s*env\b/ },
    ]);
    expect(fmt(hits)).toBe("");
  });

  it("src/core does not import server, client, app or component code", () => {
    const hits = scan(core, [
      { name: "core → outer layer", re: importOf("@/(?:server|client|app|components)(?:/[^\"']*)?") },
      { name: "core → outer layer (relative)", re: /["'](?:\.\.\/)+(?:server|client|app|components)\// },
      { name: "core → server-only/client-only", re: importOf("server-only|client-only") },
    ]);
    expect(fmt(hits)).toBe("");
  });

  it("browser code never imports src/server", () => {
    const candidates = [...listFiles("src/client"), ...listFiles("src/components"), ...listFiles("src/app"), ...listFiles("src/core")];
    const browser = candidates.filter((f) => {
      if (f.startsWith("src/client/") || f.startsWith("src/components/")) return true;
      const head = stripComments(readFileSync(join(ROOT, f), "utf8")).trimStart();
      return /^["']use client["']/.test(head);
    });
    const hits = scan(browser, [
      { name: "client → server", re: importOf("@/server(?:/[^\"']*)?|server-only") },
      { name: "client → server (relative)", re: /["'](?:\.\.?\/)+(?:[\w-]+\/)*server\/[^"']*["']/ },
    ]);
    expect(fmt(hits)).toBe("");
  });

  it('every src/server module imports "server-only" (the schema files and the auth CLI config are exempt)', () => {
    // Exempt for one reason only: a tool outside Next's bundler loads the file, and `server-only` throws there.
    // `drizzle-kit` reads the three schema files; `npx auth generate` reads the config and explicitly refuses one
    // containing `import "server-only"`. Nothing here is imported by a route at runtime, and the "browser code
    // never imports src/server" rule above still covers them.
    const EXEMPT = new Set([
      "src/server/db/schema.ts",
      "src/server/db/schema-auth.ts", // WP19: CLI-generated, read by drizzle-kit
      "src/server/db/schema-saas.ts", // WP19: read by drizzle-kit
      "src/server/identity/auth.schema-gen.ts", // WP19: the `npx auth generate` entry point
    ]);
    const missing = listFiles("src/server")
      .filter((f) => !EXEMPT.has(f) && !/\.d\.ts$/.test(f))
      .filter((f) => !/^\s*import\s+["']server-only["'];?/m.test(stripComments(readFileSync(join(ROOT, f), "utf8"))));
    expect(missing.join("\n")).toBe("");
  });

  it('every src/client module imports "client-only" (worklet sources exempt)', () => {
    const missing = listFiles("src/client")
      .filter((f) => !/\/worklets\//.test(f) && !/\.d\.ts$/.test(f))
      .filter((f) => !/^\s*import\s+["']client-only["'];?/m.test(stripComments(readFileSync(join(ROOT, f), "utf8"))));
    expect(missing.join("\n")).toBe("");
  });

  it("tsconfig excludes spikes, tools and research", () => {
    const ts = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")) as { exclude?: string[] };
    for (const d of ["spikes", "tools", "research"]) expect(ts.exclude ?? []).toContain(d);
  });
});

describe("DESIGN §2.3 direct-open ban", () => {
  /** The limits helpers (DESIGN §3.1). */
  const ALLOWED = [/^src\/server\/limits\//, /^src\/server\/aai\/tokens\.ts$/, /^src\/client\/stt\//, /^src\/client\/va\//, /^scripts\/lib\/aai-open\.ts$/];
  /** Modules that DEFINE the primitives (their internal calls are the implementation, not an open). */
  const DEFINERS = [/^src\/core\/aai\/streaming\.ts$/, /^src\/core\/aai\/voice-agent\.ts$/, /^src\/server\/aai\/va-node\.ts$/];
  /**
   * Unit tests that open the promoted clients against an INJECTED in-memory fake socket (integrator, Wave 0). They
   * may call `StreamingSession.connect` because the guard below proves they cannot reach a credential, the env, a
   * Node socket factory or the limits helpers, so they can never open a billable AssemblyAI session.
   */
  const FAKE_SOCKET_TESTS = [/^tests\/unit\/core\/audio\/aai-[\w-]+\.test\.ts$/];
  const FAKE_SOCKET_FORBIDDEN =
    /\bprocess\s*\.\s*env\b|ASSEMBLYAI_API_KEY|\brequireEnv\b|\bloadEnv\b|\bnodeWebSocketFactory\b|\bconnectNode\b|\bconnectWithToken\b|\bmintStreamingToken\b|\bmintToken\b|va-node|aai-open|scripts\/lib\//;

  // Calls, bracket calls (`X["connect"](`), optional chaining, `.call/.apply/.bind`, import aliases, value
  // assignments and destructuring are all opens. Mocks (`{ mintToken: vi.fn() }`, `vi.spyOn(StreamingSession,
  // "connect")`, `vi.mocked(connectNode)`) and type positions (`typeof StreamingSession.connect>`) are not.
  const Q = "[\"'`]";
  const INVOKE = String.raw`\s*(?:\(|\.\s*(?:call|apply|bind)\b)`;
  const freeFn = (name: string) =>
    new RegExp(
      [
        String.raw`(?<!function\s+)(?<![\w$])${name}${INVOKE}`, // name(  /  name.call(
        String.raw`\[\s*${Q}${name}${Q}\s*\]${INVOKE}`, // ns["name"](
        String.raw`(?<![\w$])${name}\s+as\s+[\w$]+`, // import { name as alias }
        String.raw`(?<![=!<>])=\s*${name}\s*(?:[;,)]|$)`, // const f = name;
      ].join("|"),
    );
  const RULES = [
    {
      name: "StreamingSession.connect",
      re: new RegExp(
        String.raw`\bStreamingSession\s*(?:\??\.\s*connect\b|\[\s*${Q}connect${Q}\s*\])\s*(?:\(|\.\s*(?:call|apply|bind)\b|[;,)]|$)`,
      ),
    },
    { name: "connectNode(", re: freeFn("connectNode") },
    // va-node's convenience helper mints a Voice Agent token AND opens a session in one call (integrator, Wave 0).
    { name: "connectWithToken(", re: freeFn("connectWithToken") },
    { name: "mintStreamingToken(", re: freeFn("mintStreamingToken") },
    {
      name: ".mintToken(",
      re: new RegExp(
        [
          String.raw`(?:\??\.\s*mintToken|\[\s*${Q}mintToken${Q}\s*\])${INVOKE}`,
          String.raw`\b(?:const|let|var)\s*\{[^}]*\bmintToken\b[^}]*\}\s*=`,
        ].join("|"),
      ),
    },
  ];

  it("no direct AssemblyAI opens or token mints outside the limits helpers", () => {
    const files = [...listFiles("src"), ...listFiles("scripts"), ...listFiles("tests")].filter(
      (f) =>
        f !== SELF &&
        !ALLOWED.some((re) => re.test(f)) &&
        !DEFINERS.some((re) => re.test(f)) &&
        !FAKE_SOCKET_TESTS.some((re) => re.test(f)),
    );
    expect(fmt(scan(files, RULES))).toBe("");
  });

  it("fake-socket tests cannot reach a credential, the env, a Node socket factory or the limits helpers", () => {
    const files = listFiles("tests").filter((f) => FAKE_SOCKET_TESTS.some((re) => re.test(f)));
    expect(files.length).toBeGreaterThan(0);
    expect(fmt(scan(files, [{ name: "fake-socket test reaches a real open path", re: FAKE_SOCKET_FORBIDDEN }]))).toBe("");
  });

  it("the detector catches every banned form and ignores comments, definitions, mocks and types", () => {
    const cases: [string, string[]][] = [
      ["const s = await StreamingSession.connect({ auth, params });", ["StreamingSession.connect"]],
      ['const s = await StreamingSession["connect"]({ auth });', ["StreamingSession.connect"]],
      ["const s = await StreamingSession?.connect({ auth });", ["StreamingSession.connect"]],
      ["const open = StreamingSession.connect;", ["StreamingSession.connect"]],
      ["await StreamingSession.connect.call(null, o);", ["StreamingSession.connect"]],
      ["const va = await connectNode({ apiKey });", ["connectNode("]],
      ['const va = await vaNode["connectNode"]({ apiKey });', ["connectNode("]],
      ['import { connectNode as open } from "@/server/aai/va-node";', ["connectNode("]],
      ["const f = connectNode;", ["connectNode("]],
      ["const va = await connectWithToken(rest, { expiresInSeconds: 60 });", ["connectWithToken("]],
      ["export async function connectWithToken(rest, mint, o = {}) {}", []],
      ["const t = await mintStreamingToken(key, {});", ["mintStreamingToken("]],
      ["const t = await mintStreamingToken.call(null, key, {});", ["mintStreamingToken("]],
      ["const t2 = await rest.mintToken({ expiresInSeconds: 10 });", [".mintToken("]],
      ['const t2 = await rest["mintToken"]({ expiresInSeconds: 10 });', [".mintToken("]],
      ["const t2 = await rest?.mintToken({});", [".mintToken("]],
      ["const { mintToken } = rest;", [".mintToken("]],
      ["// StreamingSession.connect( in a comment is fine", []],
      ["/* connectNode( in a block comment is fine */", []],
      ["export function connectNode(o) {}", []],
      ["export async function mintStreamingToken(apiKey) {}", []],
      ["const rest = { mintToken: vi.fn(async () => ({ token: 't' })) };", []],
      ['vi.spyOn(StreamingSession, "connect");', []],
      ["expect(vi.mocked(connectNode)).toHaveBeenCalledTimes(1);", []],
      ["type O = Parameters<typeof StreamingSession.connect>[0];", []],
      ['import { mintStreamingToken } from "@/server/aai/va-node";', []],
    ];
    const flagged = cases.map(([src]) => {
      const line = stripComments(src);
      return RULES.filter((r) => r.re.test(line)).map((r) => r.name);
    });
    expect(flagged).toEqual(cases.map(([, want]) => want));
  });
});

describe("DESIGN §5.9.5 golden-config ban: conversation.message", () => {
  // conversation.message is schema-valid but never reaches the model (10 §0.4). Only the client that documents it
  // (src/core/aai/voice-agent.ts, where the method is @deprecated) may name it. G0 integrator addition.
  const RULE = [{ name: "conversation.message", re: /\bsendConversationMessage\s*\(|["'`]conversation\.message["'`]/ }];

  it("nothing sends conversation.message outside the client that documents it", () => {
    const files = [...listFiles("src"), ...listFiles("scripts"), ...listFiles("tests")].filter(
      (f) => f !== SELF && f !== "src/core/aai/voice-agent.ts",
    );
    expect(fmt(scan(files, RULE))).toBe("");
  });

  it("the detector catches both forms and ignores comments", () => {
    const flagged = (src: string) => RULE.some((r) => r.re.test(stripComments(src)));
    expect(flagged('session.sendConversationMessage("hi");')).toBe(true);
    expect(flagged('s.send({ type: "conversation.message", role: "user", content: "x" });')).toBe(true);
    expect(flagged("// never use conversation.message or sendConversationMessage(")).toBe(false);
    expect(flagged('s.send({ type: "reply.create", instructions: "x" });')).toBe(false);
  });
});
