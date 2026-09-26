-- 0003_audit_guard (SAAS §2.7, §9). WP19.
--
-- `audit_log` is append-only. Drizzle does not track triggers, so this is a `--custom` migration and
-- `drizzle-kit generate` stays diff-free: 0002 is the whole of the schema drizzle knows about.
--
-- DELETE is allowed only inside a transaction that has set `changeover.audit_purge = 'on'`, which is what the
-- retention purge does (`SET LOCAL`, so the setting dies with the transaction). UPDATE is never allowed:
-- a mistaken row is corrected by writing another row, never by editing history.
--
-- TRUNCATE needs a **second, statement-level** trigger: a row-level trigger never fires for it, so the row guard
-- below would let `TRUNCATE audit_log` erase the whole log in one statement — and this migration deliberately does
-- no `REVOKE`/ownership hardening (research/17-saas-stack.md §7), so the app's own role could issue it. The
-- statement guard has **no purge escape hatch on purpose**: the §3.5 retention purge is age-scoped and deletes
-- rows, so nothing legitimate ever truncates this table, and a purge transaction that reaches for TRUNCATE by
-- mistake is exactly the accident worth refusing. Dropping the table is still possible, but that is a schema
-- change, not a write, and it leaves evidence.
--
-- `CREATE OR REPLACE FUNCTION` and the `DROP TRIGGER IF EXISTS` make the whole file re-runnable, so applying it to
-- a database that somehow already has the trigger is a no-op rather than a failure.

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('changeover.audit_purge', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_log_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_no_truncate();
