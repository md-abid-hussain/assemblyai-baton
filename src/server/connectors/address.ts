import "server-only";

import ipaddr from "ipaddr.js";

/**
 * The SSRF address guard (PLATFORM §6.2 "Allowlist, not a deny list"). An address passes only when
 * `ipaddr.parse(a).range() === "unicast"`; ipaddr.js 2.5 names every special range (loopback, RFC 1918, link-local incl.
 * 169.254.169.254, CGNAT, documentation, benchmarking, multicast, reserved, `::`, `100::/64`, ULA, the IPv4-mapped,
 * NAT64 `64:ff9b::/96` + `64:ff9b:1::/48`, 6to4 and Teredo forms, …), so everything else is refused.
 *
 * Stricter than the spec's letter, on purpose:
 * - every IPv6 transition form that EMBEDS an IPv4 address (IPv4-mapped, IPv4-compatible `::/96`, SIIT
 *   `::ffff:0:0:0/96`, NAT64, 6to4, Teredo) is refused outright, whatever the embedded address is, and the embedded
 *   IPv4 is reported in the reason. ipaddr.js has no name for IPv4-compatible `::/96` (it calls `::7f00:1` "unicast"),
 *   so that prefix is checked here explicitly. No real HTTPS API is reachable only through one of these forms;
 * - an IPv6 address must also be inside global unicast `2000::/3`;
 * - zone ids (`fe80::1%eth0`) and non-canonical IPv4 spellings (`0x7f.1`, `2130706433`) are refused.
 */

export type AddressVerdict =
  | { ok: true; address: string; family: 4 | 6 }
  | { ok: false; address: string; reason: string };

const GLOBAL_UNICAST_V6 = ipaddr.IPv6.parseCIDR("2000::/3");

/** IPv6 prefixes that carry an IPv4 address, with where the IPv4 sits (the last 32 bits unless noted). */
const V4_CARRYING_V6: { name: string; cidr: [ipaddr.IPv6, number]; embedded: (p: number[]) => number[] }[] = [
  { name: "ipv4-mapped", cidr: ipaddr.IPv6.parseCIDR("::ffff:0:0/96"), embedded: last32 },
  { name: "ipv4-translated (SIIT)", cidr: ipaddr.IPv6.parseCIDR("::ffff:0:0:0/96"), embedded: last32 },
  { name: "ipv4-compatible", cidr: ipaddr.IPv6.parseCIDR("::/96"), embedded: last32 },
  { name: "nat64", cidr: ipaddr.IPv6.parseCIDR("64:ff9b::/96"), embedded: last32 },
  { name: "nat64 local-use", cidr: ipaddr.IPv6.parseCIDR("64:ff9b:1::/48"), embedded: last32 },
  { name: "6to4", cidr: ipaddr.IPv6.parseCIDR("2002::/16"), embedded: (p) => [p[1]! >> 8, p[1]! & 0xff, p[2]! >> 8, p[2]! & 0xff] },
  // Teredo: the client's IPv4 is the last 32 bits XOR 0xffffffff.
  { name: "teredo", cidr: ipaddr.IPv6.parseCIDR("2001::/32"), embedded: (p) => last32(p).map((o) => o ^ 0xff) },
];

function last32(p: number[]): number[] {
  return [p[6]! >> 8, p[6]! & 0xff, p[7]! >> 8, p[7]! & 0xff];
}

/** Strip `[…]` around an IPv6 literal (URL hostnames keep them). */
export function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** True when `host` is an IP literal (IPv4 dotted quad or IPv6, brackets allowed). Never throws. */
export function isIpLiteral(host: string): boolean {
  const h = unbracket(host);
  return ipaddr.IPv6.isValid(h) || ipaddr.IPv4.isValidFourPartDecimal(h);
}

/** Check one address (a resolver answer or an IP-literal hostname). Never throws. */
export function checkAddress(raw: string): AddressVerdict {
  const address = unbracket(raw.trim());
  if (address.includes("%")) return { ok: false, address, reason: "scoped (zone id) addresses are refused" };

  if (ipaddr.IPv4.isValidFourPartDecimal(address)) {
    const v4 = ipaddr.IPv4.parse(address);
    const range = v4.range();
    return range === "unicast"
      ? { ok: true, address: v4.toString(), family: 4 }
      : { ok: false, address, reason: `IPv4 ${range} range` };
  }
  if (!ipaddr.IPv6.isValid(address)) return { ok: false, address, reason: "not an IPv4 dotted quad or an IPv6 address" };

  const v6 = ipaddr.IPv6.parse(address);
  for (const form of V4_CARRYING_V6) {
    // `::` and `::1` sit inside `::/96`; name them by their own range.
    if (v6.match(form.cidr) && v6.range() !== "unspecified" && v6.range() !== "loopback") {
      const embedded = new ipaddr.IPv4(form.embedded(v6.parts));
      return { ok: false, address, reason: `IPv6 ${form.name} form (embeds ${embedded.toString()}, ${embedded.range()})` };
    }
  }
  const range = v6.range();
  if (range !== "unicast") return { ok: false, address, reason: `IPv6 ${range} range` };
  if (!v6.match(GLOBAL_UNICAST_V6)) return { ok: false, address, reason: "IPv6 outside global unicast 2000::/3" };
  return { ok: true, address: v6.toString(), family: 6 };
}
