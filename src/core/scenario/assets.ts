/**
 * scenario/assets.ts - the Watch-mode assets of one take (DESIGN §5.1.1), pure:
 *
 * - `rep.<h>.ulaw` / `customer.<h>.ulaw`: raw G.711 µ-law, 8 kHz, no header, re-encoded from the kit's split PCM16
 *   WAVs (near-lossless: the kit decoded them from Twilio's µ-law). The STT cache feeds the SAME bytes (§6.2), so
 *   eval audio is byte-identical to Watch-mode audio.
 * - `peaks.<h>.json`: `PeaksSchema` (max-abs per 20 ms).
 * - `<h>` = the first 8 hex chars of sha256(file bytes): content-hashed names, served immutable.
 */
import { mulawEncode } from "../audio/mulaw";
import type { CallAssets, Peaks } from "../contracts/scenario";
import { buildPeaks } from "./peaks";

export const TWILIO_RATE = 8000;
export const HASH_CHARS = 8;

export interface ChannelPcm {
  rep: Int16Array;
  customer: Int16Array;
  sampleRate: number;
}

export interface TakeAudio {
  /** µ-law bytes per channel, equal length (the shorter channel is padded with µ-law silence). */
  ulaw: { rep: Uint8Array; customer: Uint8Array };
  peaks: Peaks;
  /** Exact duration of the (padded) channels. */
  durationMs: number;
  /** Samples of padding added to the shorter channel (0 for kit takes: both come from one stereo file). */
  paddedSamples: number;
}

/** Pad the shorter channel with digital silence so both play and feed on one clock. */
export function equalizeChannels(rep: Int16Array, customer: Int16Array): { rep: Int16Array; customer: Int16Array; padded: number } {
  const n = Math.max(rep.length, customer.length);
  const pad = (x: Int16Array): Int16Array => {
    if (x.length === n) return x;
    const out = new Int16Array(n);
    out.set(x);
    return out;
  };
  return { rep: pad(rep), customer: pad(customer), padded: Math.abs(rep.length - customer.length) };
}

/** PCM16 8 kHz per channel → the µ-law bytes, peaks and duration of one take. */
export function takeAudioOf(pcm: ChannelPcm): TakeAudio {
  if (pcm.sampleRate !== TWILIO_RATE) throw new Error(`takeAudioOf: expected ${TWILIO_RATE} Hz split WAVs, got ${pcm.sampleRate} Hz`);
  const { rep, customer, padded } = equalizeChannels(pcm.rep, pcm.customer);
  return {
    ulaw: { rep: mulawEncode(rep), customer: mulawEncode(customer) },
    peaks: buildPeaks(rep, customer, pcm.sampleRate),
    durationMs: Math.round((rep.length / pcm.sampleRate) * 1000),
    paddedSamples: padded,
  };
}

/** Deterministic JSON (2-space indent, trailing newline): every generated file uses it, so rebuilds are byte-identical. */
export const stableJson = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** Compact peaks JSON (≈ 6 KB/min per channel). */
export const peaksJson = (p: Peaks): string => JSON.stringify(p);

export interface AssetFile {
  /** File name inside `public/calls/<callId>/`. */
  name: string;
  bytes: Uint8Array;
}

/** The three content-hashed files of a publishable take and their site-root URLs. */
export function callAssetFiles(
  callId: string,
  audio: Pick<TakeAudio, "ulaw" | "peaks">,
  hashHex: (bytes: Uint8Array) => string,
): { files: AssetFile[]; urls: CallAssets } {
  const peaks = new TextEncoder().encode(peaksJson(audio.peaks));
  const named = (kind: string, ext: string, bytes: Uint8Array): AssetFile => ({ name: `${kind}.${hashHex(bytes).slice(0, HASH_CHARS)}.${ext}`, bytes });
  const rep = named("rep", "ulaw", audio.ulaw.rep);
  const customer = named("customer", "ulaw", audio.ulaw.customer);
  const pk = named("peaks", "json", peaks);
  const base = `/calls/${encodeURIComponent(callId)}`;
  return { files: [rep, customer, pk], urls: { rep: `${base}/${rep.name}`, customer: `${base}/${customer.name}`, peaks: `${base}/${pk.name}` } };
}
