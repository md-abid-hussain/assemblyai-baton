/**
 * server/sim/tts-cache.ts - `TtsCacheStore` implementations: `PgTtsCache` on the `tts_cache` table of migration
 * 0001 (WP14b; PLATFORM §2.4) and `MemoryTtsCache` (tests, one-off scripts). Scripts that must survive restarts
 * use the file cache in `scripts/sim/lib/fs-tts-cache.ts`.
 *
 * Raw SQL on purpose: the drizzle table objects for 0001 live in WP14b's `schema.ts`; plain SQL keeps this module
 * independent of when that lands. Never hold a pool connection across the TTS request (DESIGN §4.5 F1): the
 * service reads, calls OpenAI, then writes, each as its own statement.
 */
import "server-only";

import { sql } from "drizzle-orm";

import type { TtsCacheEntry, TtsCacheStore } from "../../core/contracts/ext/wp17-sim";
import type { Db } from "../db/client";

/** A pg `bytea` Buffer → a Uint8Array view (no copy). */
export const bytesOf = (b: Uint8Array): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
/** A Uint8Array → a Buffer view for a pg parameter (no copy). */
export const bufferOf = (b: Uint8Array): Buffer => Buffer.from(b.buffer, b.byteOffset, b.byteLength);

type TtsRow = { hash: string; model: string; voice: string; text: string; pcm24k: Buffer; duration_ms: number };

export class PgTtsCache implements TtsCacheStore {
  constructor(private readonly db: Db) {}

  async get(hash: string): Promise<TtsCacheEntry | null> {
    const r = await this.db.execute<TtsRow>(sql`select hash, model, voice, text, pcm24k, duration_ms from tts_cache where hash = ${hash}`);
    const row = r.rows[0];
    if (!row) return null;
    return { hash: row.hash, model: row.model, voice: row.voice, text: row.text, pcm24k: bytesOf(row.pcm24k), durationMs: row.duration_ms };
  }

  async put(e: TtsCacheEntry): Promise<void> {
    await this.db.execute(sql`insert into tts_cache (hash, model, voice, text, pcm24k, duration_ms)
      values (${e.hash}, ${e.model}, ${e.voice}, ${e.text}, ${bufferOf(e.pcm24k)}, ${Math.round(e.durationMs)})
      on conflict (hash) do nothing`);
  }
}

export class MemoryTtsCache implements TtsCacheStore {
  readonly rows = new Map<string, TtsCacheEntry>();

  async get(hash: string): Promise<TtsCacheEntry | null> {
    return this.rows.get(hash) ?? null;
  }

  async put(e: TtsCacheEntry): Promise<void> {
    if (!this.rows.has(e.hash)) this.rows.set(e.hash, { ...e, pcm24k: e.pcm24k.slice() });
  }
}
