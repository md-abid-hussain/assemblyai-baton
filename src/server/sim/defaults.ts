/**
 * server/sim/defaults.ts - process-wide wiring for simulated calls: the Postgres `SimCallStore` (with the gallery
 * manifest) and the cached, ledgered `TtsService` (settles on the limits authority's ledger, env = BATON_DEPLOY_ID).
 * Tests inject with `setSimCallStore()` / `setTtsService()`.
 *
 * Spend fails closed: if the ledger cannot be obtained the TTS call throws instead of running unrecorded.
 */
import "server-only";

import type OpenAI from "openai";

import { BatonError } from "../../core/contracts/errors";
import type { SimCallStore } from "../../core/contracts/ext/wp17-sim";
import { getDb } from "../db/client";
import { env } from "../env";
import { getLimitsAuthority } from "../limits";
import { createOpenAI } from "../openai/client";
import { TTS_TIMEOUT_MS, TtsService } from "../openai/tts";
import { PgSimCallStore } from "./store";
import { PgTtsCache } from "./tts-cache";

type Holder = { store: SimCallStore | null; tts: TtsService | null; injectedStore: SimCallStore | null; injectedTts: TtsService | null; openai: OpenAI | null };
const g = globalThis as typeof globalThis & { __changeoverSim?: Holder };
const holder: Holder = (g.__changeoverSim ??= { store: null, tts: null, injectedStore: null, injectedTts: null, openai: null });

export function setSimCallStore(s: SimCallStore | null): void {
  holder.injectedStore = s;
}

export function setTtsService(t: TtsService | null): void {
  holder.injectedTts = t;
}

export function getSimCallStore(): SimCallStore {
  if (holder.injectedStore) return holder.injectedStore;
  holder.store ??= new PgSimCallStore({ db: getDb(), tts: new PgTtsCache(getDb()) });
  return holder.store;
}

function openai(): OpenAI {
  if (holder.openai) return holder.openai;
  const key = env().OPENAI_API_KEY;
  if (!key) throw new BatonError("E_INTERNAL", "OPENAI_API_KEY is not configured (value never printed)");
  holder.openai = createOpenAI(key, { maxRetries: 0, timeoutMs: TTS_TIMEOUT_MS });
  return holder.openai;
}

export function getTtsService(): TtsService {
  if (holder.injectedTts) return holder.injectedTts;
  holder.tts ??= new TtsService({
    openai,
    cache: new PgTtsCache(getDb()),
    ledger: () => getLimitsAuthority().ledger,
    env: () => env().BATON_DEPLOY_ID,
  });
  return holder.tts;
}
