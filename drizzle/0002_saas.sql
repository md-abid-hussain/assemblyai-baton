CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"is_anonymous" boolean DEFAULT false,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_label" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_key" text,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fanned_out_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "org_entitlements" (
	"org_id" text PRIMARY KEY NOT NULL,
	"plan" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"billing_user_id" text,
	"polar_subscription_id" text,
	"polar_product_id" text,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" jsonb,
	"synced_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_meta" (
	"org_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"created_via" text NOT NULL,
	"pinned_relay_ids" text[] DEFAULT '{}' NOT NULL,
	"connector_hosts" text[] DEFAULT '{}' NOT NULL,
	"onboarding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"quantity" double precision NOT NULL,
	"unit" text NOT NULL,
	"case_id" text,
	"relay_id" text,
	"source" text,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"polar_ingested_at" timestamp with time zone,
	"polar_error" text
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"response_status" integer,
	"response_ms" integer,
	"response_body" text,
	"error_code" text,
	"manual" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"events" text[] NOT NULL,
	"secret_ciphertext" "bytea" NOT NULL,
	"secret_iv" "bytea" NOT NULL,
	"secret_tag" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"secret_hint" text NOT NULL,
	"inbox_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_reason" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_inbox_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"inbox_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"headers" jsonb NOT NULL,
	"body" text NOT NULL,
	"signature_valid" boolean,
	"event_type" text
);
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "connector_calls" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "relay_publications" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "relay_versions" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "relay_versions" ADD COLUMN "source_format" text;--> statement-breakpoint
ALTER TABLE "relays" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "relays" ADD COLUMN "draft_source" text;--> statement-breakpoint
ALTER TABLE "relays" ADD COLUMN "draft_source_format" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_entitlements" ADD CONSTRAINT "org_entitlements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_meta" ADD CONSTRAINT "org_meta_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_userId_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "invitations_organizationId_idx" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "members_organizationId_idx" ON "members" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "members_userId_idx" ON "members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_userId_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_org_time_idx" ON "audit_log" USING btree ("org_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "domain_events_dedupe_key_unique" ON "domain_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "domain_events_pending_idx" ON "domain_events" USING btree ("created_at") WHERE "domain_events"."fanned_out_at" is null;--> statement-breakpoint
CREATE INDEX "domain_events_org_type_idx" ON "domain_events" USING btree ("org_id","type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_idempotency_key_unique" ON "usage_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "usage_events_org_time_idx" ON "usage_events" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_ingest_idx" ON "usage_events" USING btree ("occurred_at") WHERE "usage_events"."polar_ingested_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_event_manual_unique" ON "webhook_deliveries" USING btree ("endpoint_id","event_id","manual");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE "webhook_deliveries"."status" in ('pending','failed');--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_idx" ON "webhook_deliveries" USING btree ("endpoint_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_endpoints_inbox_id_unique" ON "webhook_endpoints" USING btree ("inbox_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_org_idx" ON "webhook_endpoints" USING btree ("org_id") WHERE "webhook_endpoints"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "webhook_inbox_idx" ON "webhook_inbox_requests" USING btree ("inbox_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cases_org_created_idx" ON "cases" USING btree ("org_id","created_at" DESC NULLS LAST);