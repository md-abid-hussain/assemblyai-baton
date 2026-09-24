CREATE TABLE "app_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"call_id" text,
	"scenario_id" text NOT NULL,
	"intent" text DEFAULT 'add_driver' NOT NULL,
	"policy" jsonb NOT NULL,
	"state" jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'shadowing' NOT NULL,
	"visitor_id" text NOT NULL,
	"ip_key" text NOT NULL,
	"t_arm_ms" double precision,
	"run_plan" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_events" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"turn_id" text,
	"turn_end_ms" double precision NOT NULL,
	"seq" integer NOT NULL,
	"field" text NOT NULL,
	"kind" text NOT NULL,
	"party" text NOT NULL,
	"value_raw" text,
	"value_norm" text,
	"acknowledges_turn_id" text,
	"confidence" text NOT NULL,
	"late" boolean DEFAULT false NOT NULL,
	"cut" boolean DEFAULT false NOT NULL,
	"evidence" jsonb,
	"extractor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"ok" boolean NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"state" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"case_id" text,
	"visitor_id" text,
	"ledger_id" text,
	"provider_session_id" text,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"billed_seconds" double precision,
	"cap_ms" integer NOT NULL,
	"run_id" text,
	"deploy_id" text NOT NULL,
	"source" text,
	"hold_expires_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"takeover_id" text NOT NULL,
	"provider" text NOT NULL,
	"checkout_id" text,
	"checkout_url" text,
	"amount_cents" integer NOT NULL,
	"total_amount_cents" integer,
	"tax_amount_cents" integer,
	"simulated" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'none' NOT NULL,
	"status_source" text,
	"failure_reason" text,
	"esign_consent_at" timestamp with time zone,
	"esign_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promoted_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"intent" text NOT NULL,
	"config_hash" text NOT NULL,
	"config" jsonb NOT NULL,
	"evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rate_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bucket" text NOT NULL,
	"key" text NOT NULL,
	"cost" integer DEFAULT 1 NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"day" date DEFAULT (now() at time zone 'utc')::date NOT NULL,
	"provider" text NOT NULL,
	"action" text NOT NULL,
	"ref_id" text NOT NULL,
	"env" text NOT NULL,
	"est_usd" numeric(10, 5) NOT NULL,
	"actual_usd" numeric(10, 5),
	"status" text DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stream_queue" (
	"ticket" text PRIMARY KEY NOT NULL,
	"visitor_id" text NOT NULL,
	"ip_key" text,
	"n" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_at" timestamp with time zone,
	"last_poll_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "takeovers" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"armed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"t_arm_ms" double precision NOT NULL,
	"mid_utterance" boolean DEFAULT false NOT NULL,
	"phase" text DEFAULT 'armed' NOT NULL,
	"protocol" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot" jsonb,
	"greeting" text,
	"system_prompt_hash" text,
	"prompt_version" text,
	"stage" text,
	"va_session_id" text,
	"retries" integer DEFAULT 0 NOT NULL,
	"last_failure_at" timestamp with time zone,
	"va_session_cap_ms" integer,
	"outcome" text,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"takeover_id" text NOT NULL,
	"call_id" text NOT NULL,
	"name" text NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"status" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"channel" text NOT NULL,
	"source" text NOT NULL,
	"text" text NOT NULL,
	"start_ms" double precision NOT NULL,
	"end_ms" double precision NOT NULL,
	"recv_ms" double precision NOT NULL,
	"words" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cut" boolean DEFAULT false NOT NULL,
	"late" boolean DEFAULT false NOT NULL,
	"extract_status" text DEFAULT 'pending' NOT NULL,
	"extract_ms" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"takeover_id" text PRIMARY KEY NOT NULL,
	"aai_transcript_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"qa" jsonb,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "verifier_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"upto_turn_recv_ms" double precision NOT NULL,
	"result" jsonb NOT NULL,
	"disagreements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ms" double precision NOT NULL,
	"usd" numeric(10, 5) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "fact_events" ADD CONSTRAINT "fact_events_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_takeover_id_takeovers_id_fk" FOREIGN KEY ("takeover_id") REFERENCES "public"."takeovers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takeovers" ADD CONSTRAINT "takeovers_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_takeover_id_takeovers_id_fk" FOREIGN KEY ("takeover_id") REFERENCES "public"."takeovers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_takeover_id_takeovers_id_fk" FOREIGN KEY ("takeover_id") REFERENCES "public"."takeovers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifier_runs" ADD CONSTRAINT "verifier_runs_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cases_visitor_created_idx" ON "cases" USING btree ("visitor_id","created_at");--> statement-breakpoint
CREATE INDEX "cases_created_idx" ON "cases" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fact_events_case_seq_uq" ON "fact_events" USING btree ("case_id","seq");--> statement-breakpoint
CREATE INDEX "health_checks_created_idx" ON "health_checks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "jobs_status_run_after_idx" ON "jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "live_sessions_kind_status_idx" ON "live_sessions" USING btree ("kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_checkout_uq" ON "payments" USING btree ("checkout_id");--> statement-breakpoint
CREATE INDEX "promoted_agents_intent_deleted_idx" ON "promoted_agents" USING btree ("intent","deleted_at");--> statement-breakpoint
CREATE INDEX "rate_events_bucket_key_ts_idx" ON "rate_events" USING btree ("bucket","key","ts");--> statement-breakpoint
CREATE INDEX "spend_ledger_day_provider_idx" ON "spend_ledger" USING btree ("day","provider");--> statement-breakpoint
CREATE INDEX "spend_ledger_ref_idx" ON "spend_ledger" USING btree ("ref_id");--> statement-breakpoint
CREATE INDEX "stream_queue_status_created_idx" ON "stream_queue" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "takeovers_case_idx" ON "takeovers" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "takeovers_va_session_idx" ON "takeovers" USING btree ("va_session_id");--> statement-breakpoint
CREATE INDEX "tool_calls_takeover_idx" ON "tool_calls" USING btree ("takeover_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_calls_takeover_call_uq" ON "tool_calls" USING btree ("takeover_id","call_id");--> statement-breakpoint
CREATE INDEX "turns_case_recv_idx" ON "turns" USING btree ("case_id","recv_ms");--> statement-breakpoint
CREATE INDEX "verifier_runs_case_created_idx" ON "verifier_runs" USING btree ("case_id","created_at");