import "server-only";

import { checkAddress, isIpLiteral, unbracket, type AddressVerdict } from "./address";
import { ConnectorError } from "./errors";

/**
 * Destination rules for `http_action` and `completion_webhook` URLs (PLATFORM §6.2 "URL and DNS", "Destinations on
 * the public deployment").
 *
 * - `parseDestination`: WHATWG `URL`; `https:` only; port 443 only; no userinfo; host ≤ 253 chars; no `localhost`,
 *   single-label or `.localhost` names. An IP-literal host is checked with the address guard right here.
 * - `destinationPolicy`: the production host allowlist. It is ENFORCED when `APP_ENV=production`, and also when
 *   `APP_ENV` is unset and `NODE_ENV=production` (fail closed: a deploy that forgets `APP_ENV` is still not an open
 *   fetch proxy). `APP_ENV=development|test` turns it off (local and dev builds allow any public host behind the
 *   address guard). The list is `CONNECTOR_HOST_ALLOWLIST` (comma-separated host names; `*.example.com` matches
 *   sub-domains only) or, when unset, the §6.2 defaults; the app's own `APP_URL` host (for `/api/connectors/echo`)
 *   is always added.
 */

export const MAX_HOST_LENGTH = 253;
/** PLATFORM §6.2: the request-capture hosts of the public demo (used when CONNECTOR_HOST_ALLOWLIST is unset). */
export const DEFAULT_CONNECTOR_HOST_ALLOWLIST = ["postman-echo.com", "httpbin.org", "webhook.site"] as const;

export interface Destination {
  url: URL;
  /** Lower-case host without brackets or a trailing dot: what the allowlist, DNS and TLS SNI see. */
  host: string;
  /** Set when the host is an IP literal (already checked; `ok:false` means refused). */
  literal: AddressVerdict | null;
}

export interface DestinationPolicy {
  /** True on the public deployment: only `hosts` may be reached. */
  enforceAllowlist: boolean;
  hosts: readonly string[];
}

/** Parse and check a connector URL. Throws `ConnectorError` (`E_CONN_URL`, `E_CONN_ADDRESS`). */
export function parseDestination(raw: string): Destination {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConnectorError("E_CONN_URL", "The connector URL is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new ConnectorError("E_CONN_URL", "Connector URLs must use https://.");
  // WHATWG drops the default port, so an explicit ":443" reads back as "".
  if (url.port !== "" && url.port !== "443") throw new ConnectorError("E_CONN_URL", "Connector URLs must use port 443.");
  if (url.username !== "" || url.password !== "") {
    throw new ConnectorError("E_CONN_URL", "Connector URLs must not contain a user name or password.");
  }
  url.hash = "";
  let host = unbracket(url.hostname.toLowerCase());
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "" || host.length > MAX_HOST_LENGTH) throw new ConnectorError("E_CONN_URL", "The connector URL has no usable host.");

  if (isIpLiteral(host)) {
    const literal = checkAddress(host);
    if (!literal.ok) throw new ConnectorError("E_CONN_ADDRESS", `The address ${literal.address} is not public (${literal.reason}).`);
    return { url, host: literal.address, literal };
  }
  if (host === "localhost" || host.endsWith(".localhost") || !host.includes(".")) {
    throw new ConnectorError("E_CONN_ADDRESS", `The host "${host}" is not a public name.`);
  }
  return { url, host, literal: null };
}

/** Normalise one allowlist entry (a host name, or `*.suffix`). Returns null for junk. */
function normaliseEntry(entry: string): string | null {
  let e = entry.trim().toLowerCase();
  if (e.startsWith("https://")) {
    try {
      e = new URL(e).hostname;
    } catch {
      return null;
    }
  }
  if (e.endsWith(".")) e = e.slice(0, -1);
  if (!/^(\*\.)?[a-z0-9.-]{1,253}$/.test(e) && !isIpLiteral(e)) return null;
  return e;
}

/** Whether `host` (from `parseDestination`) may be reached under `policy`. */
export function isHostAllowed(host: string, policy: DestinationPolicy): boolean {
  if (!policy.enforceAllowlist) return true;
  const h = host.toLowerCase();
  return policy.hosts.some((entry) => (entry.startsWith("*.") ? h.endsWith(entry.slice(1)) && h.length > entry.length - 1 : h === entry));
}

/** Throws `E_CONN_HOST_NOT_ALLOWED` when the allowlist is enforced and does not hold `host`. */
export function assertHostAllowed(host: string, policy: DestinationPolicy): void {
  if (!isHostAllowed(host, policy)) {
    throw new ConnectorError("E_CONN_HOST_NOT_ALLOWED", "On the public demo, HTTP actions can reach these test hosts only: " + policy.hosts.join(", ") + ".");
  }
}

/** The destination policy from an env-like record (defaults to `process.env`). Never logs values. */
export function destinationPolicy(src: Record<string, string | undefined> = process.env): DestinationPolicy {
  const appEnv = src.APP_ENV?.trim().toLowerCase();
  const enforceAllowlist = appEnv ? appEnv === "production" : src.NODE_ENV === "production";
  const listed = src.CONNECTOR_HOST_ALLOWLIST?.trim();
  const entries = listed ? listed.split(",") : [...DEFAULT_CONNECTOR_HOST_ALLOWLIST];
  const hosts = new Set<string>();
  for (const e of entries) {
    const n = normaliseEntry(e);
    if (n) hosts.add(n);
  }
  const appUrl = src.APP_URL?.trim();
  if (appUrl) {
    try {
      hosts.add(new URL(appUrl).hostname.toLowerCase());
    } catch {
      /* an invalid APP_URL adds nothing */
    }
  }
  return { enforceAllowlist, hosts: [...hosts] };
}
