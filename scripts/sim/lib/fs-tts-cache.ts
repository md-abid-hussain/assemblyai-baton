/**
 * fs-tts-cache.ts - a file-backed `TtsCacheStore` for WP17 scripts (the gallery build, the live smoke): one
 * `<hash>.pcm` (24 kHz PCM16 mono) plus `<hash>.json` (model, voice, text, durationMs) per clip. Writes are atomic
 * (temp file + rename), so an interrupted run never leaves a truncated clip behind. A warm cache makes a re-run $0.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { TtsCacheEntry, TtsCacheStore } from "../../../src/core/contracts/ext/wp17-sim";
import { TTS_HASH_RE } from "../../../src/core/contracts/ext/wp17-sim";

export class FsTtsCache implements TtsCacheStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async get(hash: string): Promise<TtsCacheEntry | null> {
    if (!TTS_HASH_RE.test(hash)) return null;
    const pcm = join(this.dir, `${hash}.pcm`);
    const meta = join(this.dir, `${hash}.json`);
    if (!existsSync(pcm) || !existsSync(meta)) return null;
    const m = JSON.parse(readFileSync(meta, "utf8")) as Omit<TtsCacheEntry, "hash" | "pcm24k">;
    const b = readFileSync(pcm);
    return { hash, model: m.model, voice: m.voice, text: m.text, durationMs: m.durationMs, pcm24k: new Uint8Array(b.buffer, b.byteOffset, b.byteLength) };
  }

  async put(e: TtsCacheEntry): Promise<void> {
    if (!TTS_HASH_RE.test(e.hash)) throw new Error("bad tts hash");
    const pcm = join(this.dir, `${e.hash}.pcm`);
    if (existsSync(pcm)) return;
    const tmp = `${pcm}.${process.pid}.tmp`;
    writeFileSync(tmp, e.pcm24k);
    writeFileSync(join(this.dir, `${e.hash}.json`), JSON.stringify({ model: e.model, voice: e.voice, text: e.text, durationMs: e.durationMs }));
    renameSync(tmp, pcm);
  }
}
