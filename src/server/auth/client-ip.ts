import "server-only";

/**
 * The client hop that `ipKey` is keyed on (PLATFORM v2.1 §10.2, "ipKey, fixed"; WP12·0 / P-0).
 *
 * v2.0 keyed on the LEFTMOST `X-Forwarded-For` entry, which the client controls (any `curl -H "X-Forwarded-For: …"`
 * got a fresh bucket). Zerops's L7 balancer (docs.zerops.io/references/networking/l7-balancer-config, "Forwarded
 * headers") sets `X-Real-IP` to the client address, OVERWRITING any client value, and APPENDS the client address to
 * `X-Forwarded-For`; it strips `Forwarded`. Vercel (the remote mirror) also sets `x-real-ip` itself. So:
 *
 *   mode `real-ip` (default)  `X-Real-IP` → else the RIGHTMOST `X-Forwarded-For` entry → else "unknown"
 *   mode `xff-right`          the rightmost `X-Forwarded-For` entry → else `X-Real-IP` → else "unknown"
 *   mode `off`                no trustworthy hop: a fresh random key per request, so per-ipKey buckets never bind
 *                             and only the per-visitor buckets and the global caps apply (P9)
 *
 * The hop is grouped by /24 for IPv4 and /48 for IPv6 (IPv4-mapped IPv6 counts as IPv4), so one household or office
 * shares a bucket and rotating through a /64 buys nothing. Unparseable values become "unknown" (bounded key space).
 * Without a balancer in front (local `next dev`, tests), `X-Real-IP` is client-controlled; that is accepted: buckets
 * are conveniences, and the global caps plus the ledger are the real guard.
 *
 * No Node imports (the proxy's bundling resolves `server-only` to the empty module, as for `./crypto.ts`), so
 * `src/proxy.ts`, route handlers and `src/server/cases/platform-stub.ts` (WP14b) can all share it:
 * `hmac(VISITOR_SECRET, "ip:" + dayUTC + ":" + clientHop(req.headers))`.
 */

export type IpKeyMode = "real-ip" | "xff-right" | "off";

export const IPKEY_MODES: readonly IpKeyMode[] = ["real-ip", "xff-right", "off"];

/** `IPKEY_MODE` env (default `real-ip`; an unknown value also falls back to `real-ip`). */
export function ipKeyMode(raw: string | undefined = process.env.IPKEY_MODE): IpKeyMode {
  const v = raw?.trim().toLowerCase();
  return (IPKEY_MODES as readonly string[]).includes(v ?? "") ? (v as IpKeyMode) : "real-ip";
}

const V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET_RE = /^[0-9a-f]{1,4}$/i;
/** Longest textual IPv6 is 45 chars; anything longer is not an address. */
const MAX_ADDR_LEN = 64;

/** Strip `[v6]:port`, `v4:port` and an IPv6 zone id. */
function bare(value: string): string {
  let v = value.trim();
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    v = end > 0 ? v.slice(1, end) : v;
  } else {
    const c = v.indexOf(":");
    if (c > 0 && v.indexOf(":", c + 1) < 0 && v.includes(".")) v = v.slice(0, c);
  }
  const zone = v.indexOf("%");
  return zone >= 0 ? v.slice(0, zone) : v;
}

function v4Octets(s: string): number[] | null {
  const m = V4_RE.exec(s);
  if (!m) return null;
  const o = m.slice(1, 5).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** The 8 hextets of an IPv6 address, or null. Handles `::` and a trailing dotted IPv4. */
function v6Hextets(s: string): number[] | null {
  if (!s.includes(":")) return null;
  let text = s;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const last = text.slice(lastColon + 1);
  if (last.includes(".")) {
    const o = v4Octets(last);
    if (!o) return null;
    tail.push((o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!);
    text = text.slice(0, lastColon + 1) + "0:0"; // two placeholder hextets, replaced below
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const h of part.split(":")) {
      if (!HEXTET_RE.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups;
}

/** `a.b.c.0/24` for IPv4 (and IPv4-mapped IPv6), `x:y:z::/48` for IPv6, else null. */
export function ipPrefix(value: string): string | null {
  if (!value || value.length > MAX_ADDR_LEN) return null;
  const s = bare(value);
  const o = v4Octets(s);
  if (o) return `${o[0]}.${o[1]}.${o[2]}.0/24`;
  const g = v6Hextets(s);
  if (!g) return null;
  const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  if (mapped) return `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.0/24`;
  return `${g[0]!.toString(16)}:${g[1]!.toString(16)}:${g[2]!.toString(16)}::/48`;
}

/** The rightmost non-empty `X-Forwarded-For` entry (the hop the balancer appended). */
export function rightmostForwardedFor(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  if (!xff) return null;
  const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : null;
}

function randomKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

/**
 * The ipKey material for a request: a /24 or /48 prefix, "unknown", or (mode `off`) `off:<random>`.
 * Callers hmac it with the day; the raw IP never leaves this function.
 */
export function clientHop(headers: Headers, opts: { mode?: IpKeyMode } = {}): string {
  const mode = opts.mode ?? ipKeyMode();
  if (mode === "off") return `off:${randomKey()}`;
  const realIp = headers.get("x-real-ip")?.trim() || null;
  const right = rightmostForwardedFor(headers);
  const order = mode === "xff-right" ? [right, realIp] : [realIp, right];
  for (const candidate of order) {
    if (!candidate) continue;
    const p = ipPrefix(candidate);
    if (p) return p;
  }
  return "unknown";
}

// ------------------------------------------------------------------------------------------------ P-0 probe

/** Address class only (never the address): what the P-0 probe logs. */
export type AddrClass = "none" | "invalid" | "public" | "private" | "cgnat" | "loopback" | "linklocal" | "testnet";

/** The P-0 request header: `GET /api/status` with `x-ipkey-probe: 1` logs `describeForwarding` (PII-free). */
export const IPKEY_PROBE_HEADER = "x-ipkey-probe";

export function addrClass(value: string | null | undefined): AddrClass {
  if (!value) return "none";
  if (value.length > MAX_ADDR_LEN) return "invalid";
  const s = bare(value);
  let o = v4Octets(s);
  if (!o) {
    const g = v6Hextets(s);
    if (!g) return "invalid";
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      o = [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff];
    } else {
      if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
      if ((g[0]! & 0xfe00) === 0xfc00) return "private"; // fc00::/7 ULA
      if ((g[0]! & 0xffc0) === 0xfe80) return "linklocal";
      if (g[0] === 0x2001 && g[1] === 0x0db8) return "testnet";
      return "public";
    }
  }
  const [a, b, c] = o as [number, number, number, number];
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "linklocal";
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return "testnet";
  return "public";
}

export interface ForwardingSummary {
  mode: IpKeyMode;
  xffEntries: number;
  xffLeft: AddrClass;
  xffRight: AddrClass;
  realIp: AddrClass;
  realIpEqualsXffRight: boolean;
  forwardedHeaderPresent: boolean;
  /** The ipKey source `clientHop` picks under `mode`: "x-real-ip" | "xff-right" | "unknown" | "off". */
  keyedOn: string;
}

/**
 * What the app received, as classes only (P-0, PLATFORM §10.2). Probe: send `X-Forwarded-For: 203.0.113.7`,
 * `X-Real-IP: 203.0.113.9` and `x-ipkey-probe: 1`. Trustworthy balancer: `realIp:"public"`, `xffLeft:"testnet"`,
 * `xffRight:"public"`, `realIpEqualsXffRight:true`, `forwardedHeaderPresent:false`. `realIp:"testnet"` → the client
 * value survived (use `IPKEY_MODE=xff-right`); a private/cgnat `realIp` and `xffRight` → an inner hop (`IPKEY_MODE=off`).
 */
export function describeForwarding(headers: Headers, opts: { mode?: IpKeyMode } = {}): ForwardingSummary {
  const mode = opts.mode ?? ipKeyMode();
  const xff = (headers.get("x-forwarded-for") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const realIp = headers.get("x-real-ip")?.trim() || null;
  const right = xff.length ? xff[xff.length - 1]! : null;
  let keyedOn = "unknown";
  if (mode === "off") keyedOn = "off";
  else {
    const order: [string, string | null][] = mode === "xff-right" ? [["xff-right", right], ["x-real-ip", realIp]] : [["x-real-ip", realIp], ["xff-right", right]];
    keyedOn = order.find(([, v]) => v && ipPrefix(v))?.[0] ?? "unknown";
  }
  return {
    mode,
    xffEntries: xff.length,
    xffLeft: addrClass(xff[0] ?? null),
    xffRight: addrClass(right),
    realIp: addrClass(realIp),
    realIpEqualsXffRight: !!realIp && !!right && bare(realIp) === bare(right),
    forwardedHeaderPresent: headers.has("forwarded"),
    keyedOn,
  };
}
