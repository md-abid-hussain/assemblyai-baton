/**
 * audio/base64.ts - isomorphic base64 <-> bytes (promoted from spikes/voice-agent/client.ts, fix per DESIGN §3.2:
 * use the platform Buffer when one exists, else btoa/atob). No Node types are referenced.
 */

interface BufferLike {
  from(data: ArrayBufferLike, byteOffset: number, length: number): { toString(encoding: "base64"): string };
  from(data: string, encoding: "base64"): Uint8Array;
}

const platformBuffer = (): BufferLike | undefined => (globalThis as { Buffer?: BufferLike }).Buffer;

/** The pure-JS path (btoa), used when no Buffer exists; exported so tests can prove parity with the Buffer path. */
export function bytesToBase64Portable(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The pure-JS path (atob). */
export function base64ToBytesPortable(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const B = platformBuffer();
  return B ? B.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64") : bytesToBase64Portable(bytes);
}

/** Always returns a plain Uint8Array view (never a platform Buffer subclass instance you might mutate by accident). */
export function base64ToBytes(b64: string): Uint8Array {
  const B = platformBuffer();
  if (!B) return base64ToBytesPortable(b64);
  const b = B.from(b64, "base64");
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}
