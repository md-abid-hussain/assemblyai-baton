# WP14b → WP19: the tenancy-manifest rows for relays, source and cases, and one boot wiring line

**From:** WP14b·4 (D2 PM) · **To:** WP19·3 (the core tenancy suite) + the integrator · **Severity:** §1 is a
correctness gap in the guest path; §2 is the data WP19·3 needs and would otherwise have to reverse-engineer.

WP14b·4 has landed the three things WP19·2 left ports for: `RelaySourceStore`, `GuestSeeder`, and the `relays`
count source. All three register through `installRelaySaas` in `src/server/relays/saas.ts`.

---

## 1. `/api/guest/start` must have the ports installed before it seeds (the integrator's one line)

`src/server/identity/guest-start.ts` step 5 calls `getGuestSeeder().seed(org.id)`. That reads WP19's port
registry, and WP14b's real seeder is registered as a **side effect of building the relay graph**, which happens
lazily on the first touch of `/api/relays/**`.

**So on a cold container whose first request is a guest start, the registry still holds the no-op default and the
guest lands in an empty workspace** — no Dental copy, no YAML source for the Code tab. That is precisely the judge
path and the landing CTA's background start (SAAS §3.3), and it is invisible in tests and in any warm process,
because anything that lists relays installs the real seeder first.

WP14b·4 has exported the fix from its own path (`9270427`):

```ts
// src/server/relays/index.ts
export function installRelaySaasPorts(): void   // idempotent; re-points the three slots at the current graph
```

**The ask (`src/instrumentation.ts`, the integrator's file — WP14b will not touch it):** one block beside
`[WIRE-PUBLISHING]`, which exists for the same reason.

```ts
// [WIRE-RELAY-SAAS] WP14b·4. Registers the RelaySourceStore, the GuestSeeder and the `relays` count with the v3
// port registry. Without it, a cold container's first /api/guest/start seeds with WP19's no-op default.
// Cheap at boot: getDb() wraps a pg Pool that does not connect until its first query.
try {
  const { installRelaySaasPorts } = await import("./server/relays");
  installRelaySaasPorts();
} catch (err) {
  log.child({ component: "boot" }).error("relay saas ports failed to install", { err });
}
```

Belt and braces if you would rather not depend on boot order at all: `guest-start.ts` can `await import(
"../relays")` before step 5. Either is fine; the instrumentation block is the one that matches the file's
existing precedent, and it also covers the `RelaySourceStore` for any future non-relay caller.

---

## 2. The manifest rows (`tests/tenancy/manifest.ts`, WP19·3's file)

SAAS §11 wants one row per org route with its method, permission and a fixture id per org. These are WP14b's
routes as they now behave. Every one of them resolves through `relayPrincipal` → `requirePrincipal`
(`src/server/relays/index.ts`), so there is exactly one decision point for all of them.

| Route | Method | Permission | Cross-org expectation |
|---|---|---|---|
| `/api/relays` | GET | `relay:read` | A's list never contains B's ids; the gallery is in both |
| `/api/relays` | POST | `relay:write` | `kind:"clone"` of B's **private** id → 404; of a gallery id → 201 |
| `/api/relays/:id` | GET | `relay:read` | B's id → 404 |
| `/api/relays/:id` | PUT | `relay:write` | B's id → 404; a gallery id → `E_READ_ONLY` |
| `/api/relays/:id` | DELETE | `relay:write` | B's id → 404 |
| `/api/relays/:id/draft` | PUT | `relay:write` | B's id → 404 |
| `/api/relays/:id/source` | GET | `relay:read` | B's id → 404; a gallery id → 200 (readable, `stored:false` when it was seeded from JSON) |
| `/api/relays/:id/source` | PUT | `relay:write` | B's id → 404; a gallery id → `E_READ_ONLY` |
| `/api/relays/:id/versions` | POST | `relay:write` | B's id → 404 |
| `/api/relays/:id/compiled` | GET | `relay:read` | B's id → 404 |
| `/api/cases` | POST | *(none — `allowVisitor: true`)* | **Not a 404 row.** See §3 |

**Three rules the rows depend on, so the suite asserts the behaviour and not an accident:**

1. **A foreign id and a nonexistent id are indistinguishable** (SAAS §10.1 rule 2): both are 404 with the same
   body. The manifest should assert the *bodies* match, not only the statuses — that is the part that rots.
2. **Readable-but-not-writable is `E_READ_ONLY` (403), not 404.** Gallery relays, and anything else
   `accessOf` calls readable. A row that expects 404 for a gallery write will fail, correctly.
3. **`relay:write` on a relay you can see but not own is still 403, not 404** — the permission is checked before
   the row, the row's access after it.

`tests/unit/server/relays/saas.test.ts` already pins the relay and source rows against real Postgres
("B gets 404 on A's relay source, for the read and the write, exactly as for an unknown id"; "a gallery relay's
source is readable by anyone but not writable"). Those are unit-level and stay; they are not a substitute for the
manifest, and they should not block you if you reshape the fixtures.

---

## 3. `POST /api/cases` is deliberately **not** a 401 row

`/call/[id]` is the judge path and the public demo and has no account behind it, so `caseTenantOf`
(`src/server/cases/tenancy.ts`) resolves with `requirePrincipal(req, { allowVisitor: true })` and **never 401s a
visitor**. The tenancy expectations for it are:

- a visitor with no org → the case is created with `org_id = null` under `TENANCY_MODE=orgs` (under `legacy` the
  visitor's `ws_<visitorId>` is the org, which is the v2 behaviour unchanged);
- a session principal → `cases.org_id` = the token's active org, **never** a body field;
- `cases.created_by_user_id` = the principal's user id, null on the device path. It is **provenance only** — §6.1
  forbids authorizing off it, and nothing in WP14b's code does;
- over `liveRunsPerDay` → the labelled replay, **200 not 402** (§4.2). `checkRunBudget` reports, never throws.

If the manifest is table-driven on "cross-org → 404", `/api/cases` needs to be an explicit exception row rather
than omitted, so that a later change that starts 401ing visitors fails a test instead of the demo.

---

## 4. What WP14b will not be changing

- `src/server/saas/ports.ts`, `src/server/identity/**`, `tests/tenancy/**` and `src/instrumentation.ts` are not
  WP14b's paths; everything above is a request, not a pending edit on `wp/wp14b`.
- The `relays` count source is `countRelaysForOrg` (live, non-archived, non-gallery, matching
  `PgRelayRegistry.countLive`, which is the number the Studio's quota shows). A gallery clone is **exempt** from
  the plan wall, as in v2 — step 1 of every first session must not hit an upgrade card.
