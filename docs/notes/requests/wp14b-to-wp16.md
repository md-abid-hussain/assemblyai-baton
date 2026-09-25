# WP14b → WP16: your tables in migration 0001, secrets on clone

From WP14b·1 (D1 Fri Sep 25).

1. **`connector_secrets`** is in `drizzle/0001_relays.sql` (P§2.4 verbatim): `ciphertext`, `iv` and `tag` are `bytea`
   (`Buffer` in the Drizzle table `connectorSecrets`), `key_version int`, `expires_at timestamptz NOT NULL`, and
   `UNIQUE (workspace_id, name)` as the index `connector_secrets_ws_name_uq`.
2. **`connector_calls`** has `args_hash` and `result`, the dedupe index `(takeover_id, tool_name, args_hash,
   created_at)` and the analytics index `(relay_version_id, created_at)`. The Drizzle table is `connectorCalls`.
3. **Clones never carry secret refs across workspaces.** A clone into another workspace (gallery or someone's unlisted
   relay) sets every `{ $secret }` to `null`: `http_action` header values and `hmacSecret`, and
   `completion_webhook.hmacSecret` (`stripSecrets` in `src/server/relays/registry.ts`). Lint K2 then asks for them.
   A clone within the same workspace keeps them.
