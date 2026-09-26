/**
 * relay-code/diff.ts - `unifiedDiff(a, b, labels)` (SAAS §5.3). WP23.
 *
 * A line diff in unified format, used by the Studio ("diff between versions", "Import with a diff confirmation")
 * and printed by `changeover diff` in the CLI. Greedy Myers (An O(ND) Difference Algorithm, Myers 1986) with a
 * bounded edit distance: two files that share almost nothing stop early and are reported as one replaced block,
 * so a 256 KiB paste can never spend quadratic time in a browser tab.
 *
 * Pure and isomorphic: no node, DOM or server imports.
 */

export interface DiffLabels {
  a: string;
  b: string;
}

/** Lines of context around a change, as `diff -u` prints them. */
const CONTEXT = 3;
/** The greedy walk gives up past this many edits and falls back to "replace the whole block". */
const MAX_EDITS = 4000;

type Op = { kind: "equal" | "del" | "add"; line: string };

const splitLines = (text: string): string[] => {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();   // a trailing newline is not an empty line
  return lines;
};

/** The edit script from `a` to `b`, one entry per line. */
export function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  const head: Op[] = a.slice(0, prefix).map((line) => ({ kind: "equal" as const, line }));
  const tail: Op[] = a.slice(a.length - suffix).map((line) => ({ kind: "equal" as const, line }));
  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);
  return [...head, ...middleOps(middleA, middleB), ...tail];
}

function middleOps(a: readonly string[], b: readonly string[]): Op[] {
  if (a.length === 0) return b.map((line) => ({ kind: "add", line }));
  if (b.length === 0) return a.map((line) => ({ kind: "del", line }));

  // Greedy Myers: `trace[d][k]` is the furthest x reached with d edits on diagonal k.
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const i = k + offset;
      let x = k === -d || (k !== d && (v[i - 1] ?? -1) < (v[i + 1] ?? -1)) ? (v[i + 1] ?? 0) : (v[i - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[i] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, offset, d);
    }
  }
  return [...a.map((line) => ({ kind: "del" as const, line })), ...b.map((line) => ({ kind: "add" as const, line }))];
}

function backtrack(a: readonly string[], b: readonly string[], trace: Int32Array[], offset: number, d: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let step = d; step > 0; step--) {
    const v = trace[step]!;
    const k = x - y;
    const i = k + offset;
    const down = k === -step || (k !== step && (v[i - 1] ?? -1) < (v[i + 1] ?? -1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[prevK + offset] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ kind: "equal", line: a[--x]! }); y--; }
    if (down) ops.push({ kind: "add", line: b[--y]! });
    else ops.push({ kind: "del", line: a[--x]! });
  }
  while (x > 0 && y > 0) { ops.push({ kind: "equal", line: a[--x]! }); y--; }
  while (x > 0) ops.push({ kind: "del", line: a[--x]! });
  while (y > 0) ops.push({ kind: "add", line: b[--y]! });
  return ops.reverse();
}

/**
 * Unified diff text. Returns `""` when the two texts are identical, so a caller can say "no changes" without
 * scanning the output.
 */
export function unifiedDiff(a: string, b: string, labels: DiffLabels): string {
  if (a === b) return "";
  const ops = diffLines(splitLines(a), splitLines(b));

  // Hunks: every run of changes plus CONTEXT equal lines on each side, merged when they overlap.
  const changed = ops.map((op) => op.kind !== "equal");
  const hunks: { start: number; end: number }[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (!changed[i]) continue;
    let run = i;
    while (run + 1 < ops.length && changed[run + 1]) run++;
    const start = Math.max(0, i - CONTEXT);
    const end = Math.min(ops.length - 1, run + CONTEXT);
    const last = hunks[hunks.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else hunks.push({ start, end });
    i = run;
  }

  const out: string[] = [`--- ${labels.a}`, `+++ ${labels.b}`];
  let lineA = 1;
  let lineB = 1;
  const startsA: number[] = [];
  const startsB: number[] = [];
  for (const op of ops) {
    startsA.push(lineA);
    startsB.push(lineB);
    if (op.kind !== "add") lineA++;
    if (op.kind !== "del") lineB++;
  }
  for (const hunk of hunks) {
    const slice = ops.slice(hunk.start, hunk.end + 1);
    const countA = slice.filter((op) => op.kind !== "add").length;
    const countB = slice.filter((op) => op.kind !== "del").length;
    const fromA = countA === 0 ? (startsA[hunk.start] ?? 1) - 1 : startsA[hunk.start]!;
    const fromB = countB === 0 ? (startsB[hunk.start] ?? 1) - 1 : startsB[hunk.start]!;
    out.push(`@@ -${fromA},${countA} +${fromB},${countB} @@`);
    for (const op of slice) out.push(`${op.kind === "equal" ? " " : op.kind === "del" ? "-" : "+"}${op.line}`);
  }
  return `${out.join("\n")}\n`;
}
