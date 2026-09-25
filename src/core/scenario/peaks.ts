/**
 * scenario/peaks.ts - `peaks.json` (DESIGN §5.1.1, `PeaksSchema`): per channel, the 0..1 max-abs over each 20 ms
 * window (ratePerSec = 50), plus the per-window speech activity the mono attribution uses (§6.2).
 */
import type { Peaks } from "../contracts/scenario";

export const PEAKS_PER_SEC = 50;

/** Max-abs / 32768 per 1/ratePerSec window, rounded to 3 decimals (small, deterministic JSON). */
export function computePeaks(samples: Int16Array, sampleRate: number, ratePerSec = PEAKS_PER_SEC): number[] {
  const win = Math.round(sampleRate / ratePerSec);
  if (win <= 0) throw new RangeError("computePeaks: bad window");
  const n = Math.ceil(samples.length / win);
  const out = new Array<number>(n);
  for (let w = 0; w < n; w++) {
    let max = 0;
    const end = Math.min(samples.length, (w + 1) * win);
    for (let i = w * win; i < end; i++) {
      const v = samples[i]!;
      const a = v < 0 ? -v : v;
      if (a > max) max = a;
    }
    out[w] = Math.min(1, Math.round((max / 32768) * 1000) / 1000);
  }
  return out;
}

export function buildPeaks(rep: Int16Array, customer: Int16Array, sampleRate: number): Peaks {
  return { ratePerSec: PEAKS_PER_SEC, rep: computePeaks(rep, sampleRate), customer: computePeaks(customer, sampleRate) };
}

/** ≈ −30 dBFS: a 20 ms window whose peak is above this counts as speech for the attribution. */
export const ACTIVITY_PEAK = 0.03;

/** Per-window activity: 1 where the peak crosses the threshold. */
export const activityFromPeaks = (peaks: readonly number[], threshold = ACTIVITY_PEAK): Uint8Array =>
  Uint8Array.from(peaks, (p) => (p >= threshold ? 1 : 0));
