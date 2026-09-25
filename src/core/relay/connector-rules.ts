/**
 * relay/connector-rules.ts - lint mirrors of the connector runtime's refusals (PLATFORM §6.2; request
 * wp16-to-wp14a.md §3), so the Studio shows them before a run. WP14a. Pure and isomorphic. The runtime
 * (`src/server/connectors/{shape,destination,address}.ts`) stays the authority: it also resolves DNS and checks every
 * answer; these checks only catch what is visible in the blueprint.
 *
 * - Declared `http_action` header names the runtime drops: WP16's `FORBIDDEN_DECLARED_HEADERS` plus the `Proxy-*`,
 *   `Sec-*` and `X-Changeover-*` prefixes.
 * - `http_action.url` / `completion_webhook.url`: `https:` only, port 443, no user name or password, no `localhost`,
 *   `*.localhost` or single-label host, and an IP-literal host must be public unicast (IPv4 special-purpose ranges
 *   and the non-global IPv6 forms are refused; WHATWG `URL` already canonicalises `2130706433` → `127.0.0.1`).
 */

export const FORBIDDEN_DECLARED_HEADERS: ReadonlySet<string> = new Set([
  "host", "cookie", "cookie2", "content-length", "accept-encoding", "content-encoding", "transfer-encoding", "te",
  "trailer", "connection", "keep-alive", "upgrade", "proxy-connection", "proxy-authenticate", "proxy-authorization",
  "expect", "content-type", "user-agent",
]);

export function isForbiddenDeclaredHeader(name: string): boolean {
  const n = name.trim().toLowerCase();
  return FORBIDDEN_DECLARED_HEADERS.has(n) || n.startsWith("x-changeover-") || n.startsWith("proxy-") || n.startsWith("sec-");
}

/** IPv4 special-purpose ranges (IANA registry): [first octets as a number, prefix length, name]. */
const V4_SPECIAL: readonly [number, number, string][] = [
  [0x00000000, 8, "this network"], [0x0a000000, 8, "private"], [0x64400000, 10, "shared (CGNAT)"],
  [0x7f000000, 8, "loopback"], [0xa9fe0000, 16, "link-local"], [0xac100000, 12, "private"], [0xc0000000, 24, "IETF protocol"],
  [0xc0000200, 24, "documentation"], [0xc0586300, 24, "6to4 relay"], [0xc0a80000, 16, "private"], [0xc6120000, 15, "benchmarking"],
  [0xc6336400, 24, "documentation"], [0xcb007100, 24, "documentation"], [0xe0000000, 4, "multicast"], [0xf0000000, 4, "reserved"],
];

const V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function v4Problem(host: string): string | null {
  const m = V4_RE.exec(host);
  if (!m) return null;
  const n = m.slice(1, 5).map(Number);
  if (n.some((x) => x > 255)) return `"${host}" is not a valid IPv4 address`;
  const ip = ((n[0]! << 24) | (n[1]! << 16) | (n[2]! << 8) | n[3]!) >>> 0;
  for (const [base, bits, name] of V4_SPECIAL) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((ip & mask) >>> 0 === base) return `the address ${host} is not public (${name})`;
  }
  return null;
}

/** IPv6 literal: only global unicast 2000::/3, minus the IPv4-embedding and documentation prefixes. */
function v6Problem(host: string): string | null {
  const h = host.toLowerCase();
  if (!h.includes(":")) return null;
  if (h.includes("%")) return `the address ${host} has a zone id`;
  const first = h.split(":")[0] ?? "";
  const group = first === "" ? 0 : Number.parseInt(first, 16);
  if (!Number.isFinite(group) || group < 0x2000 || group > 0x3fff) return `the address ${host} is not global unicast IPv6`;
  if (group === 0x2002) return `the address ${host} is a 6to4 form`;
  const second = h.split(":")[1] ?? "";
  if (group === 0x2001 && (second === "" || second === "0" || second === "0000")) return `the address ${host} is a Teredo form`;
  if (group === 0x2001 && second.replace(/^0+/, "") === "db8") return `the address ${host} is a documentation address`;
  return null;
}

/** Why the runtime would refuse this connector URL, or null. */
export function connectorUrlProblem(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return "not a valid URL"; }
  if (url.protocol !== "https:") return "connector URLs must use https://";
  if (url.port !== "" && url.port !== "443") return `connector URLs must use port 443 (not ${url.port})`;
  if (url.username !== "" || url.password !== "") return "connector URLs must not contain a user name or password";
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "") return "the URL has no host";
  const ip = v4Problem(host) ?? v6Problem(host);
  if (ip) return ip;
  if (V4_RE.test(host) || host.includes(":")) return null;   // a public IP literal
  if (host === "localhost" || host.endsWith(".localhost")) return `"${host}" is not a public host name`;
  if (!host.includes(".")) return `"${host}" is a single-label host, not a public host name`;
  return null;
}
