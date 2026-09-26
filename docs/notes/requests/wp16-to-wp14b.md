# WP16 → WP14b: migration 0001 tables that WP16 writes (WP16·1, D1)

WP16's Postgres code uses raw, parameterised SQL on a `pg` pool: `PgSecretRepo` in `src/server/secrets/repo.ts`
and `PgConnectorCallLog` in `src/server/connectors/call-log.ts`. It does not depend on the drizzle schema, so it
works as soon as `drizzle/0001_relays.sql` is applied. **Please keep these two tables exactly as in PLATFORM §2.4:**

- `connector_secrets (id text PK, workspace_id text NOT NULL, name text NOT NULL, ciphertext bytea NOT NULL,
  iv bytea NOT NULL, tag bytea NOT NULL, key_version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, UNIQUE (workspace_id, name))`.
  The repo upserts with `ON CONFLICT (workspace_id, name)`, so the unique constraint is load-bearing.
- `connector_calls (id text PK, case_id, takeover_id, relay_version_id, publication_id text, connector_id text NOT NULL,
  tool_name text NOT NULL, mode text NOT NULL, status text NOT NULL, http_status integer, ms integer NOT NULL,
  req_bytes integer NOT NULL DEFAULT 0, res_bytes integer NOT NULL DEFAULT 0, args_hash text, result jsonb,
  error_code text, created_at timestamptz NOT NULL DEFAULT now())`, plus the two indexes in §2.4. The dedupe query
  uses `connector_calls_dedupe_idx`.

Notes:
- `ms` is `integer` in §2.4, but G0 decision 2 says measured `*_ms` columns are `double precision`. WP16 rounds
  before insert, so **either type works**. If you switch it to `double precision`, nothing on our side changes.
- Ids WP16 writes: `sec_` + 16 characters of [a-z0-9] (the `SecretRefSchema` shape) and `cc_` + 20 hex characters.
- The test `tests/unit/server/secrets/secret-store.test.ts` creates both tables with `CREATE TABLE IF NOT EXISTS`
  (the §2.4 DDL) in its throwaway DB, so it keeps passing once 0001 creates them.
- If you add drizzle table objects for these to `src/server/db/schema.ts`, please name them `connectorSecrets` and
  `connectorCalls`. WP16 may switch to them in WP16·3; nothing needs them today.

---

## WP16·3: please call the completion webhook on the terminal transition

`sendCompletionWebhooks(compiled, facts, deps)` (`src/server/connectors/completion-webhook.ts`, exported from
`@/server/connectors`) sends the PLATFORM §6.1 `completion_webhook` export. It is the wire half only: it signs the
body with the C2 headers, applies the SAAS §5.6 host policy and the SSRF guard, writes one `connector_calls` row,
and **never throws** — a dead endpoint returns `{status:"error"}` and the run completes regardless.

It needs the facts, which only your terminal path has:

```ts
await sendCompletionWebhooks(compiled, {
  runId: takeoverId, caseId, outcome, endedAt: endedAt.toISOString(),
  case: exportableFields,   // ids → status/value, already redacted; never audio, recordings or transcript text
  qa: qaSummary,            // optional; omitted when the run is still provisional
  payment: paymentSummary,  // optional
}, { workspaceId: relayOwnerOrgId, secrets: getSecretStore(), callLog: getConnectorCallLog() });
```

Two rules from §6.1: it fires **once**, after verification or after the 60 s the verifier gets, and
`workspaceId` is the RELAY OWNER's org (the publication's org on a published run), because that is whose signing
secret and whose allowed hosts apply. If it is easier for you to hand WP18's verify job the call instead, that is
fine — one caller either way.
