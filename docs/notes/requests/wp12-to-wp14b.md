# WP12 → WP14b

## 1. ipKey fix in `src/server/cases/platform-stub.ts:50` (PLATFORM v2.1 §10.2, P-0)

WP12·0 fixed `ipKey` in `src/server/auth/visitor.ts`. The v2.0 code keyed on the **leftmost** `X-Forwarded-For`
entry, which the client controls. The helper now lives in `src/server/auth/client-ip.ts` and is re-exported from
`@/server/auth`:

```ts
import { clientHop } from "@/server/auth/client-ip";
// replaces: const hop = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown";
const hop = clientHop(req.headers);
const ipKey = hmac(secretOf("VISITOR_SECRET"), `ip:${new Date().toISOString().slice(0, 10)}:${hop}`).slice(0, 22);
```

`clientHop` returns the /24 (IPv4) or /48 (IPv6) group of the balancer-set `X-Real-IP` (else the rightmost
`X-Forwarded-For` entry), `"unknown"`, or `off:<random>` when `IPKEY_MODE=off`. The material and the hmac format are
the same as `ipKeyOf` in `visitor.ts`, so both paths produce the same key for the same request.

Tests: `tests/unit/server/cases/routes.test.ts` sends single-entry `x-forwarded-for` values, so it keeps passing.
Two visitors in the same /24 (`192.0.2.1` and `192.0.2.2`) now share an ipKey. That test does not depend on
distinct ipKeys today; if a later test does, use different /24s (for example `192.0.2.x` and `198.51.100.x`).

## 2. `tests/unit/server/runs/runs-va.test.ts:62` (FYI)

It gives each case its own IP with `198.51.100.${caseId.length}`. With /24 grouping these are one ipKey. The suite is
green today (the VA per-ipKey limit of 12/h is not reached). If it starts failing on `RATE.vaHourIp`, vary the third
octet instead: `198.51.${caseId.length}.1`.
