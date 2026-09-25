/**
 * stt-score.ts - scoring for WP4's Day-1 STT runs (T-D1-6 grid, /dev/audio acceptance): word recall and WER against
 * the fixture script, entity recall, turn segmentation (splits/merges) and final latency vs the script's turn ends.
 * Ported from the frozen spike harness (spikes/streaming/harness.ts `normalizeForWer`/`wer`/`entityHits`) so this
 * package does not import spikes/ (excluded from tsconfig).
 */

/** Collapse runs of single-char tokens ("h p 7 7 4" → "hp774"), unify times, strip punctuation. */
export function normalizeWords(s: string): string[] {
  const t = s
    .toLowerCase()
    .replace(/(\d),(\d{3})/g, "$1$2")
    .replace(/\bp\.\s?m\.?/g, "pm")
    .replace(/\ba\.\s?m\.?/g, "am")
    .replace(/(\d)-(?=\d)/g, "$1")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/'/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  let run = "";
  for (const w of t) {
    if (w.length === 1 && /[a-z0-9]/.test(w)) {
      run += w;
      continue;
    }
    if (run) {
      if (/^\d+$/.test(w) && run.length > 1) {
        run += w;
        continue;
      }
      out.push(run);
      run = "";
    }
    out.push(w);
  }
  if (run) out.push(run);
  const joined: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[i]!;
    const b = out[i + 1];
    if (b && /^[a-z]{1,2}$/.test(a) && /^\d{4,}$/.test(b)) {
      joined.push(a + b);
      i++;
    } else joined.push(a);
  }
  return joined;
}

export interface WerResult {
  wer: number;
  /** 1 − deletions / reference words (how much of what was said came through). */
  wordRecall: number;
  ref: number;
  sub: number;
  del: number;
  ins: number;
}

export function wer(ref: string, hyp: string): WerResult {
  const r = normalizeWords(ref);
  const h = normalizeWords(hyp);
  const n = r.length;
  const m = h.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const c = r[i - 1] === h[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + c);
    }
  let i = n;
  let j = m;
  let sub = 0;
  let del = 0;
  let ins = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1)) {
      if (r[i - 1] !== h[j - 1]) sub++;
      i--;
      j--;
    } else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) {
      del++;
      i--;
    } else {
      ins++;
      j--;
    }
  }
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return { wer: n ? round(d[n]![m]! / n) : 0, wordRecall: n ? round(1 - (del + sub) / n) : 1, ref: n, sub, del, ins };
}

export const DIALOG_ENTITIES = [
  "harborpoint", "danielreyes", "priyashah", "hp7740391", "september15", "5pm", "1420maple", "springfield", "markdonnelly",
  "lakesideautobody", "3450", "125", "500", "7pm", "4155550137", "88birchwood", "cl44812", "friday", "10am",
];

export function entityHits(text: string, expect: readonly string[] = DIALOG_ENTITIES): { hit: string[]; missing: string[]; recall: number } {
  const norm = text
    .toLowerCase()
    .replace(/\bp\.\s?m\.?/g, "pm")
    .replace(/\ba\.\s?m\.?/g, "am")
    .replace(/(\d+)(st|nd|rd|th)\b/g, "$1")
    .replace(/[^a-z0-9]/g, "");
  const hit: string[] = [];
  const missing: string[] = [];
  for (const e of expect) (norm.includes(e) ? hit : missing).push(e);
  return { hit, missing, recall: expect.length ? hit.length / expect.length : 1 };
}

export interface ScriptTurn {
  index: number;
  channel: "left" | "right";
  text: string;
  start_ms: number;
  end_ms: number;
}

export interface FinalLike {
  text: string;
  startMs: number;
  endMs: number;
  recvMs: number;
}

/**
 * Match finals to script turns by time overlap; latency = recvMs − script end of the LAST script turn a final
 * covers (the true end of speech; STT word end times are 0.24–1.3 s late, 10b §3.6). Splits = script turns covered
 * by > 1 final; merges = finals covering > 1 script turn.
 */
export function segmentation(script: ScriptTurn[], finals: FinalLike[]): { latencies: number[]; splits: number; merges: number; unmatched: number } {
  const latencies: number[] = [];
  let merges = 0;
  let unmatched = 0;
  const coverCount = new Map<number, number>();
  for (const f of finals) {
    const covered = script.filter((t) => f.startMs < t.end_ms + 400 && f.endMs > t.start_ms - 400);
    if (covered.length === 0) {
      unmatched++;
      continue;
    }
    if (covered.length > 1) merges++;
    for (const c of covered) coverCount.set(c.index, (coverCount.get(c.index) ?? 0) + 1);
    const lastEnd = Math.max(...covered.map((c) => c.end_ms));
    latencies.push(f.recvMs - lastEnd);
  }
  const splits = [...coverCount.values()].filter((n) => n > 1).length;
  return { latencies, splits, merges, unmatched };
}

export function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))]!;
}
