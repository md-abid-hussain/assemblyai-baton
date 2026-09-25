/** Word-level diff (LCS) for the QA card's "View diff" popover: required disclosure text vs what the AI said. */

export type DiffOp = { op: "same" | "missing" | "extra"; text: string };

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9$]/g, "");

export function wordDiff(required: string, spoken: string): DiffOp[] {
  const a = required.split(/\s+/).filter(Boolean);
  const b = spoken.split(/\s+/).filter(Boolean);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = norm(a[i]!) === norm(b[j]!) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (norm(a[i]!) === norm(b[j]!)) {
      out.push({ op: "same", text: b[j]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ op: "missing", text: a[i]! });
      i++;
    } else {
      out.push({ op: "extra", text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ op: "missing", text: a[i++]! });
  while (j < m) out.push({ op: "extra", text: b[j++]! });
  return out;
}

/** The part of `spoken` that best covers `required` (trims greetings before / questions after). */
export function bestWindow(required: string, spoken: string): string {
  const ops = wordDiff(required, spoken);
  const first = ops.findIndex((o) => o.op === "same");
  let last = -1;
  ops.forEach((o, k) => {
    if (o.op === "same") last = k;
  });
  if (first < 0) return spoken;
  return ops
    .slice(first, last + 1)
    .filter((o) => o.op !== "missing")
    .map((o) => o.text)
    .join(" ");
}
