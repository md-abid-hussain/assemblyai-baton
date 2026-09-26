import "server-only";

import { promises as dnsPromises } from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";

import { checkAddress } from "./address";
import { ConnectorError } from "./errors";

/**
 * DNS for connectors (PLATFORM §6.2 "DNS off the threadpool", "Anti-rebinding").
 *
 * - Resolution uses a c-ares `dns.promises.Resolver` with `{timeout: 1500, tries: 1}`, `resolve4` and `resolve6` in
 *   parallel. NEVER `dns.lookup`: it runs `getaddrinfo` on the 4-thread libuv pool with no timeout, so a few slow
 *   names would stall crypto, zlib and fs for the whole app. A hard backstop (timeout + 300 ms) cancels the resolver
 *   in case c-ares overruns.
 * - EVERY answer must pass the address guard; one bad answer refuses the call (`E_CONN_ADDRESS`).
 * - The chosen address (IPv4 first) is then PINNED: `pinnedLookup` hands exactly that address to `https.request`,
 *   honouring `options.all` (Node 22's `autoSelectFamily` asks for an array), so a second resolution (DNS rebinding)
 *   can never happen.
 */

export const DNS_TIMEOUT_MS = 1500;
export const DNS_TRIES = 1;
const DNS_BACKSTOP_MS = DNS_TIMEOUT_MS + 300;

/** The resolver surface we use (a `dns.promises.Resolver`, or a mock in tests). */
export interface ConnectorResolver {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  cancel?(): void;
}

/** A fresh c-ares resolver with the §6.2 settings. `servers` (e.g. `["127.0.0.1:5353"]`) overrides the system ones. */
export function createConnectorResolver(servers?: readonly string[]): ConnectorResolver {
  const r = new dnsPromises.Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES });
  if (servers && servers.length) r.setServers([...servers]);
  return r;
}

export interface ResolvedDestination {
  address: string;
  family: 4 | 6;
  /** Every validated answer (for diagnostics; only `address` is ever connected to). */
  all: string[];
}

function errCode(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : "error";
}

/**
 * Resolve `host` and validate every answer. Throws `ConnectorError`:
 * `E_CONN_DNS` (no answer, NXDOMAIN, timeout) or `E_CONN_ADDRESS` (an answer is not public unicast).
 */
export async function resolvePublic(host: string, resolver: ConnectorResolver, backstopMs = DNS_BACKSTOP_MS): Promise<ResolvedDestination> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const backstop = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), backstopMs);
  });
  let settled: PromiseSettledResult<string[]>[] | "timeout";
  try {
    settled = await Promise.race([Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]), backstop]);
  } finally {
    clearTimeout(timer);
  }
  if (settled === "timeout") {
    try {
      resolver.cancel?.();
    } catch {
      /* ignore */
    }
    throw new ConnectorError("E_CONN_DNS", `DNS for ${host} timed out.`);
  }
  const [r4, r6] = settled as [PromiseSettledResult<string[]>, PromiseSettledResult<string[]>];
  const v4 = r4.status === "fulfilled" ? r4.value : [];
  const v6 = r6.status === "fulfilled" ? r6.value : [];
  const answers = [...v4, ...v6];
  if (answers.length === 0) {
    const why = [r4, r6].map((r) => (r.status === "rejected" ? errCode(r.reason) : "no records")).join(" / ");
    throw new ConnectorError("E_CONN_DNS", `DNS for ${host} returned no address (${why}).`);
  }
  let first: ResolvedDestination | null = null;
  const all: string[] = [];
  for (const a of answers) {
    const v = checkAddress(a);
    if (!v.ok) throw new ConnectorError("E_CONN_ADDRESS", `${host} resolves to ${v.address}, which is not public (${v.reason}).`);
    all.push(v.address);
    if (!first) first = { address: v.address, family: v.family, all };
  }
  return first!;
}

/**
 * A `lookup` for `net`/`tls`/`https` that always answers with the pre-validated address. It honours `options.all`
 * (an array of one `{address, family}`), which Node 22's `autoSelectFamily` path requires, and never touches DNS.
 */
export function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  const fn = (
    _hostname: string,
    options: LookupOptions | ((...args: unknown[]) => void),
    callback?: (...args: unknown[]) => void,
  ): void => {
    const cb = (typeof options === "function" ? options : callback) as (err: Error | null, a: string | LookupAddress[], f?: number) => void;
    const all = typeof options === "object" && options !== null && options.all === true;
    process.nextTick(() => {
      if (all) cb(null, [{ address, family }]);
      else cb(null, address, family);
    });
  };
  return fn as unknown as LookupFunction;
}
