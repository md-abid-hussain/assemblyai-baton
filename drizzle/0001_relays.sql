CREATE TABLE "connector_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text,
	"takeover_id" text,
	"relay_version_id" text,
	"publication_id" text,
	"connector_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"http_status" integer,
	"ms" integer NOT NULL,
	"req_bytes" integer DEFAULT 0 NOT NULL,
	"res_bytes" integer DEFAULT 0 NOT NULL,
	"args_hash" text,
	"result" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"tag" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"lint" jsonb,
	"repairs" integer DEFAULT 0 NOT NULL,
	"usd" double precision DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"relay_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_publications" (
	"id" text PRIMARY KEY NOT NULL,
	"relay_id" text NOT NULL,
	"version_id" text NOT NULL,
	"aai_agent_id" text,
	"share_slug" text NOT NULL,
	"key_hash" text NOT NULL,
	"status" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"active_run_id" text,
	"active_until" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "relay_publications_share_slug_unique" UNIQUE("share_slug")
);
--> statement-breakpoint
CREATE TABLE "relay_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"relay_id" text NOT NULL,
	"version" integer NOT NULL,
	"blueprint" jsonb NOT NULL,
	"blueprint_hash" text NOT NULL,
	"kernel_version" text NOT NULL,
	"moderation" jsonb,
	"preset" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relays" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"flagship" boolean DEFAULT false NOT NULL,
	"draft" jsonb NOT NULL,
	"draft_rev" integer DEFAULT 0 NOT NULL,
	"lint" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_version_id" text,
	"origin" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "relays_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "sim_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'audio' NOT NULL,
	"relay_version_id" text NOT NULL,
	"sample_index" integer NOT NULL,
	"script" jsonb NOT NULL,
	"rep" "bytea",
	"customer" "bytea",
	"peaks" jsonb,
	"duration_ms" integer NOT NULL,
	"handoff" jsonb NOT NULL,
	"ai_clips" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usd" double precision NOT NULL,
	"gallery" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tts_cache" (
	"hash" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"voice" text NOT NULL,
	"text" text NOT NULL,
	"pcm24k" "bytea" NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "relay_version_id" text;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "sim_call_id" text;--> statement-breakpoint
ALTER TABLE "relay_versions" ADD CONSTRAINT "relay_versions_relay_id_relays_id_fk" FOREIGN KEY ("relay_id") REFERENCES "public"."relays"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_calls_version_idx" ON "connector_calls" USING btree ("relay_version_id","created_at");--> statement-breakpoint
CREATE INDEX "connector_calls_dedupe_idx" ON "connector_calls" USING btree ("takeover_id","tool_name","args_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_secrets_ws_name_uq" ON "connector_secrets" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_versions_relay_version_uq" ON "relay_versions" USING btree ("relay_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_versions_relay_hash_uq" ON "relay_versions" USING btree ("relay_id","blueprint_hash");--> statement-breakpoint
CREATE INDEX "relays_ws_updated_idx" ON "relays" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "relays_lru_idx" ON "relays" USING btree ("last_used_at") WHERE deleted_at IS NULL AND visibility <> 'gallery';--> statement-breakpoint
CREATE INDEX "cases_relay_version_idx" ON "cases" USING btree ("relay_version_id","created_at");