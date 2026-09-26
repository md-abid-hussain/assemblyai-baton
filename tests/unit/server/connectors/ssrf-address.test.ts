/**
 * WP16 acceptance 1 (SSRF suite), address level: every non-public form is refused by `checkAddress`, and public
 * unicast v4/v6 passes. PLATFORM §6.2 "Allowlist, not a deny list".
 */
import { describe, expect, it } from "vitest";

import { checkAddress, isIpLiteral } from "@/server/connectors/address";

const REFUSED: [string, string][] = [
  // IPv4 loopback, unspecified, RFC 1918, link-local + metadata, CGNAT, reserved/documentation/benchmarking, multicast, broadcast
  ["127.0.0.1", "loopback"], ["127.255.255.254", "loopback"], ["0.0.0.0", "unspecified"], ["0.1.2.3", "unspecified"],
  ["10.0.0.1", "private"], ["172.16.0.1", "private"], ["172.31.255.255", "private"], ["192.168.1.1", "private"],
  ["169.254.169.254", "linkLocal"], ["169.254.0.1", "linkLocal"],
  ["100.64.0.1", "carrierGradeNat"], ["100.127.255.254", "carrierGradeNat"],
  ["192.0.0.1", "reserved"], ["192.0.2.1", "reserved (TEST-NET-1)"], ["198.51.100.7", "reserved (TEST-NET-2)"],
  ["203.0.113.9", "reserved (TEST-NET-3)"], ["198.18.0.1", "benchmarking"], ["198.19.255.1", "benchmarking"],
  ["192.88.99.1", "6to4 relay anycast"], ["240.0.0.1", "reserved class E"], ["255.255.255.255", "broadcast"],
  ["224.0.0.1", "multicast"], ["239.255.255.250", "multicast"], ["192.31.196.1", "as112"], ["192.52.193.1", "amt"],
  // IPv6 unspecified, loopback, ULA, link-local, site-local, multicast, discard, documentation
  ["::", "unspecified"], ["::1", "loopback"], ["fc00::1", "ULA"], ["fd12:3456:789a::1", "ULA"],
  ["fe80::1", "link-local"], ["febf::1", "link-local"], ["fec0::1", "site-local"], ["ff02::1", "multicast"],
  ["100::1", "discard 100::/64"], ["100::", "discard"], ["2001:db8::1", "documentation"], ["3fff::1", "documentation (RFC 9637)"],
  ["2001:2::1", "benchmarking"],
  // IPv4-mapped forms of private addresses (dotted and hex spellings)
  ["::ffff:127.0.0.1", "mapped loopback"], ["::ffff:7f00:1", "mapped loopback (hex)"], ["::ffff:10.0.0.1", "mapped private"],
  ["::ffff:169.254.169.254", "mapped metadata"], ["::ffff:192.168.0.1", "mapped private"],
  // IPv4-compatible (deprecated ::/96)
  ["::127.0.0.1", "compatible loopback"], ["::7f00:1", "compatible loopback (hex)"], ["::10.0.0.1", "compatible private"],
  ["::a9fe:a9fe", "compatible metadata"],
  // SIIT ::ffff:0:0:0/96
  ["::ffff:0:7f00:1", "SIIT loopback"],
  // NAT64 well-known and local-use
  ["64:ff9b::7f00:1", "NAT64 loopback"], ["64:ff9b::10.0.0.1", "NAT64 private"], ["64:ff9b::a9fe:a9fe", "NAT64 metadata"],
  ["64:ff9b:1::a00:1", "NAT64 local-use private"],
  // 6to4 of private addresses
  ["2002:7f00:1::1", "6to4 loopback"], ["2002:a00:1::", "6to4 private"], ["2002:a9fe:a9fe::1", "6to4 metadata"],
  // Teredo (client IPv4 obfuscated in the last 32 bits: 127.0.0.1 → 80ff:fffe)
  ["2001:0:4136:e378:8000:63bf:80ff:fffe", "Teredo loopback"], ["2001::1", "Teredo"],
  // Outside global unicast 2000::/3 though ipaddr.js calls it "unicast"
  ["4000::1", "outside 2000::/3"], ["::2", "compatible-range"],
  // scoped, non-canonical, junk
  ["fe80::1%eth0", "zone id"], ["2130706433", "decimal IPv4"], ["0x7f.0.0.1", "hex IPv4"], ["0177.0.0.1", "octal IPv4"],
  ["127.1", "short IPv4"], ["localhost", "a name"], ["", "empty"],
];

const ACCEPTED: [string, 4 | 6][] = [
  ["93.184.215.14", 4], ["8.8.8.8", 4], ["1.1.1.1", 4], ["172.32.0.1", 4], ["100.128.0.1", 4], ["11.0.0.1", 4],
  ["2606:4700:4700::1111", 6], ["2a00:1450:4001:82a::200e", 6], ["[2606:4700:4700::1111]", 6],
];

describe("checkAddress: refused", () => {
  it.each(REFUSED)("%s (%s)", (addr) => {
    const v = checkAddress(addr);
    expect(v.ok, `${addr} must be refused`).toBe(false);
    if (!v.ok) expect(v.reason.length).toBeGreaterThan(0);
  });

  it("names the embedded IPv4 of a transition form", () => {
    const v = checkAddress("64:ff9b::a9fe:a9fe");
    expect(v).toMatchObject({ ok: false });
    expect(!v.ok && v.reason).toContain("169.254.169.254");
    const t = checkAddress("2001:0:4136:e378:8000:63bf:80ff:fffe");
    expect(!t.ok && t.reason).toContain("127.0.0.1");
    const s = checkAddress("2002:a00:1::");
    expect(!s.ok && s.reason).toContain("10.0.0.1");
  });

  it("refuses transition forms even when the embedded IPv4 is public (stricter than the spec)", () => {
    for (const a of ["::ffff:8.8.8.8", "::8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"]) expect(checkAddress(a).ok).toBe(false);
  });
});

describe("checkAddress: accepted", () => {
  it.each(ACCEPTED)("%s", (addr, family) => {
    const v = checkAddress(addr);
    expect(v).toMatchObject({ ok: true, family });
  });
});

describe("isIpLiteral", () => {
  it("recognises dotted quads and IPv6 (bracketed or not), not names or odd IPv4 spellings", () => {
    expect(isIpLiteral("1.2.3.4")).toBe(true);
    expect(isIpLiteral("[::1]")).toBe(true);
    expect(isIpLiteral("::1")).toBe(true);
    expect(isIpLiteral("example.com")).toBe(false);
    expect(isIpLiteral("2130706433")).toBe(false);
  });
});
