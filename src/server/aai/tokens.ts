import "server-only";

import { looksLikeBalanceError } from "../../core/aai/streaming";
import { BatonError } from "../../core/contracts/errors";
import { requireEnv } from "../env";
import { log } from "../log";
import { mintStreamingToken, StreamingHttpError, VoiceAgentHttpError, VoiceAgentRest } from "./va-node";

/**
 * The ONLY product-code path that mints AssemblyAI temporary tokens (DESIGN §2.3; tests/unit/boundaries.test.ts
 * allow-lists this file and src/server/limits/**). Callers must already hold a slot from the limits authority.
 *
 *  - STT: `GET /v3/token?expires_in_seconds=10&max_session_duration_seconds=600` (tokens are reusable within their
 *    window, so the window is short and the connect happens right after the grant).
 *  - VA:  `GET /v1/token?expires_in_seconds=10&max_session_duration_seconds=<ceiling>` (the cap is not enforced
 *    upstream [10 §0.2]; the client enforces it).
 *
 * Errors: any text mentioning balance/credit/payment/quota → `E_AAI_BALANCE`, and the balance handler (the budget
 * guard's flag flip, F8) runs; anything else → `E_STT_TRANSIENT` / `E_VA_TRANSIENT` (502). Tokens and the key are
 * never logged.
 */

export const TOKEN_WINDOW_S = 10;
export const STT_TOKEN_MAX_SESSION_S = 600;

export interface MintedToken {
  token: string;
  expiresInSeconds: number;
}

export interface TokenMinter {
  stt(o: { expiresInSeconds: number; maxSessionDurationSeconds: number }): Promise<MintedToken>;
  va(o: { expiresInSeconds: number; maxSessionDurationSeconds: number }): Promise<MintedToken>;
}

const realMinter: TokenMinter = {
  async stt(o) {
    const { ASSEMBLYAI_API_KEY } = requireEnv("ASSEMBLYAI_API_KEY");
    const r = await mintStreamingToken(ASSEMBLYAI_API_KEY, o);
    return { token: r.token, expiresInSeconds: r.expires_in_seconds ?? o.expiresInSeconds };
  },
  async va(o) {
    const { ASSEMBLYAI_API_KEY } = requireEnv("ASSEMBLYAI_API_KEY");
    const r = await new VoiceAgentRest(ASSEMBLYAI_API_KEY, { timeoutMs: 8000 }).mintToken(o);
    return { token: r.token, expiresInSeconds: r.expires_in_seconds ?? o.expiresInSeconds };
  },
};

type Holder = { minter: TokenMinter | null; onBalance: ((detail: string) => Promise<void>) | null };
const g = globalThis as typeof globalThis & { __batonTokens?: Holder };
const holder: Holder = (g.__batonTokens ??= { minter: null, onBalance: null });

/** Tests / fake-upstream harnesses. */
export function setTokenMinter(m: TokenMinter | null): void {
  holder.minter = m;
}
/** Registered by the limits wiring: flips `replay_only (aai_balance)` on the authority. */
export function setBalanceErrorHandler(h: ((detail: string) => Promise<void>) | null): void {
  holder.onBalance = h;
}

const tokLog = log.child({ component: "tokens" });

function errorText(e: unknown): string {
  if (e instanceof StreamingHttpError || e instanceof VoiceAgentHttpError) {
    return `${e.status} ${typeof e.body === "string" ? e.body : JSON.stringify(e.body ?? "")}`;
  }
  return e instanceof Error ? e.message : String(e);
}

async function mapError(kind: "stt" | "va", e: unknown): Promise<BatonError> {
  const text = errorText(e);
  const status = e instanceof StreamingHttpError || e instanceof VoiceAgentHttpError ? e.status : undefined;
  if (looksLikeBalanceError(text)) {
    tokLog.error("token mint refused for balance/credit", { kind, status });
    await holder.onBalance?.(`${kind} mint: ${text.slice(0, 120)}`).catch(() => undefined);
    return new BatonError("E_AAI_BALANCE", "AssemblyAI refused the token for the account balance, so this run uses the labelled replay.", { cause: e });
  }
  tokLog.warn("token mint failed", { kind, status, detail: text.slice(0, 200) });
  return new BatonError(kind === "stt" ? "E_STT_TRANSIENT" : "E_VA_TRANSIENT", `AssemblyAI did not issue a ${kind === "stt" ? "streaming" : "voice agent"} token right now.`, {
    cause: e,
  });
}

export async function mintSttToken(o: { maxSessionDurationSeconds?: number } = {}): Promise<MintedToken & { expiresAt: string }> {
  try {
    const t = await (holder.minter ?? realMinter).stt({ expiresInSeconds: TOKEN_WINDOW_S, maxSessionDurationSeconds: o.maxSessionDurationSeconds ?? STT_TOKEN_MAX_SESSION_S });
    return { ...t, expiresAt: new Date(Date.now() + t.expiresInSeconds * 1000).toISOString() };
  } catch (e) {
    throw await mapError("stt", e);
  }
}

export async function mintVaToken(o: { maxSessionDurationSeconds: number }): Promise<MintedToken> {
  try {
    return await (holder.minter ?? realMinter).va({
      expiresInSeconds: TOKEN_WINDOW_S,
      maxSessionDurationSeconds: Math.max(60, Math.ceil(o.maxSessionDurationSeconds)),
    });
  } catch (e) {
    throw await mapError("va", e);
  }
}
