/**
 * twilio.ts - tiny Twilio REST client over fetch (no SDK). Basic auth with Account SID + Auth Token.
 *
 * Safety:
 *  - GETs are retried on network errors / 429 / 5xx. POSTs are NEVER retried automatically:
 *    a retried create-call could ring people twice and bill twice.
 *  - The only POSTs in this file are createCall (dials) and updateCallStatus (hangs up your own call).
 */
import type { TwilioEnv } from "./env.ts";
import { redact } from "./env.ts";
import { sleep } from "./util.ts";

const API = "https://api.twilio.com/2010-04-01";
const VOICE_API = "https://voice.twilio.com/v1";

export class TwilioApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  readonly moreInfo: string | undefined;
  constructor(status: number, code: number | undefined, message: string, moreInfo?: string) {
    super(message);
    this.name = "TwilioApiError";
    this.status = status;
    this.code = code;
    this.moreInfo = moreInfo;
  }
}

export interface AccountResource {
  sid: string;
  friendly_name: string;
  status: string; // active | suspended | closed
  type: string; // Full | Trial
}

export interface BalanceResource {
  balance: string;
  currency: string;
}

export interface IncomingNumberResource {
  sid: string;
  phone_number: string;
  capabilities: { voice?: boolean; sms?: boolean; mms?: boolean };
}

export interface DialingPermissionCountry {
  iso_code: string;
  name: string;
  low_risk_numbers_enabled: boolean;
  high_risk_special_numbers_enabled: boolean;
  high_risk_tollfraud_numbers_enabled: boolean;
}

export interface CallResource {
  sid: string;
  parent_call_sid: string | null;
  status: string; // queued | ringing | in-progress | completed | busy | failed | no-answer | canceled
  direction: string;
  from: string;
  to: string;
  duration: string | null;
  start_time: string | null;
  end_time: string | null;
  date_created: string | null;
  price: string | null;
  price_unit: string | null;
}

export interface RecordingResource {
  sid: string;
  call_sid: string;
  status: string; // in-progress | paused | stopped | processing | completed | absent | deleted
  duration: string | null;
  channels: number;
  source: string;
  start_time: string | null;
  date_created: string | null;
  price: string | null;
  price_unit: string | null;
}

export const TERMINAL_CALL_STATUSES = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

export class TwilioClient {
  readonly #env: TwilioEnv;

  constructor(env: TwilioEnv) {
    this.#env = env;
  }

  get fromNumber(): string {
    return this.#env.phoneNumber;
  }

  #auth(): string {
    return "Basic " + Buffer.from(`${this.#env.accountSid}:${this.#env.authToken}`).toString("base64");
  }

  #acct(path: string): string {
    return `${API}/Accounts/${this.#env.accountSid}${path}`;
  }

  async #request<T>(method: "GET" | "POST", url: string, form?: Record<string, string>, attempt = 0): Promise<T> {
    const headers: Record<string, string> = { Authorization: this.#auth(), Accept: "application/json" };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(30_000) };
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      init.body = new URLSearchParams(form).toString();
    }
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (method === "GET" && attempt < 2) {
        await sleep(1000 * (attempt + 1));
        return this.#request<T>(method, url, form, attempt + 1);
      }
      throw new Error(redact(`network error talking to Twilio (${method} ${shortUrl(url)}): ${(e as Error).message}`));
    }
    if (method === "GET" && (res.status === 429 || res.status >= 500) && attempt < 3) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * (attempt + 1));
      return this.#request<T>(method, url, form, attempt + 1);
    }
    const text = await res.text();
    if (!res.ok) {
      let code: number | undefined;
      let message = text.slice(0, 300);
      let moreInfo: string | undefined;
      try {
        const j = JSON.parse(text) as { code?: number; message?: string; more_info?: string };
        code = j.code;
        message = j.message ?? message;
        moreInfo = j.more_info;
      } catch {
        /* not JSON */
      }
      throw new TwilioApiError(res.status, code, redact(`Twilio ${method} ${shortUrl(url)} -> HTTP ${res.status}${code ? ` (error ${code})` : ""}: ${message}`), moreInfo);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  // ------------------------------------------------------------------ read-only

  getAccount(): Promise<AccountResource> {
    return this.#request("GET", `${API}/Accounts/${this.#env.accountSid}.json`);
  }

  getBalance(): Promise<BalanceResource> {
    return this.#request("GET", this.#acct("/Balance.json"));
  }

  async findIncomingNumber(phone: string): Promise<IncomingNumberResource | null> {
    const r = await this.#request<{ incoming_phone_numbers: IncomingNumberResource[] }>(
      "GET",
      this.#acct(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phone)}&PageSize=5`),
    );
    return r.incoming_phone_numbers?.[0] ?? null;
  }

  getDialingPermission(iso: string): Promise<DialingPermissionCountry> {
    return this.#request("GET", `${VOICE_API}/DialingPermissions/Countries/${encodeURIComponent(iso)}`);
  }

  getCall(callSid: string): Promise<CallResource> {
    return this.#request("GET", this.#acct(`/Calls/${callSid}.json`));
  }

  async listChildCalls(parentSid: string): Promise<CallResource[]> {
    const r = await this.#request<{ calls: CallResource[] }>("GET", this.#acct(`/Calls.json?ParentCallSid=${parentSid}&PageSize=20`));
    return r.calls ?? [];
  }

  async listCalls(q: { status?: string; from?: string; pageSize?: number }): Promise<CallResource[]> {
    const p = new URLSearchParams();
    if (q.status) p.set("Status", q.status);
    if (q.from) p.set("From", q.from);
    p.set("PageSize", String(q.pageSize ?? 20));
    const r = await this.#request<{ calls: CallResource[] }>("GET", this.#acct(`/Calls.json?${p.toString()}`));
    return r.calls ?? [];
  }

  async listRecordings(pageSize = 20): Promise<RecordingResource[]> {
    const r = await this.#request<{ recordings: RecordingResource[] }>("GET", this.#acct(`/Recordings.json?PageSize=${pageSize}`));
    return r.recordings ?? [];
  }

  /** Recordings attached to a call. Always use the PARENT CallSid (research/15 §4.1). */
  async listCallRecordings(callSid: string): Promise<RecordingResource[]> {
    const r = await this.#request<{ recordings: RecordingResource[] }>("GET", this.#acct(`/Calls/${callSid}/Recordings.json`));
    return r.recordings ?? [];
  }

  getRecording(recordingSid: string): Promise<RecordingResource> {
    return this.#request("GET", this.#acct(`/Recordings/${recordingSid}.json`));
  }

  /** Download the recording as WAV; RequestedChannels=2 asks for the dual-channel media (research/15 §4.2). */
  async downloadRecordingWav(recordingSid: string, channels: 1 | 2 = 2): Promise<Buffer> {
    const url = this.#acct(`/Recordings/${recordingSid}.wav?RequestedChannels=${channels}`);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        // fetch follows Twilio's redirect to the media host and drops the Authorization header
        // on the cross-origin hop (Fetch spec), which is what we want.
        res = await fetch(url, { headers: { Authorization: this.#auth() }, signal: AbortSignal.timeout(120_000) });
      } catch (e) {
        if (attempt < 2) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        throw new Error(`network error downloading ${recordingSid}: ${(e as Error).message}`);
      }
      if ((res.status === 429 || res.status >= 500 || res.status === 404) && attempt < 3) {
        // 404 can happen for a few seconds right after the recording completes.
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new TwilioApiError(res.status, undefined, `download ${recordingSid}.wav -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return Buffer.from(await res.arrayBuffer());
    }
  }

  // ------------------------------------------------------------------ writes (only used by `call` / `hangup`)

  /** Places a REAL phone call. Never retried. */
  createCall(params: { to: string; twiml: string; timeoutS: number; timeLimitS: number }): Promise<CallResource> {
    return this.#request("POST", this.#acct("/Calls.json"), {
      To: params.to,
      From: this.#env.phoneNumber,
      Twiml: params.twiml,
      Timeout: String(params.timeoutS),
      TimeLimit: String(params.timeLimitS),
      // MachineDetection intentionally omitted (research/15 §6.5: extra cost + latency, humans will answer).
    });
  }

  /** Hang up / cancel one of your own calls ("completed" for live calls, "canceled" for queued/ringing). */
  updateCallStatus(callSid: string, status: "completed" | "canceled"): Promise<CallResource> {
    return this.#request("POST", this.#acct(`/Calls/${callSid}.json`), { Status: status });
  }
}

function shortUrl(url: string): string {
  return url.replace(/https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/AC[0-9a-f]+/i, "/Accounts/AC...").replace(/https:\/\/voice\.twilio\.com/i, "voice");
}

export function isCallSid(s: string): boolean {
  return /^CA[0-9a-f]{32}$/i.test(s);
}

export function isRecordingSid(s: string): boolean {
  return /^RE[0-9a-f]{32}$/i.test(s);
}
