CREATE TABLE "activity" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_keys" (
	"address" text NOT NULL,
	"version" integer NOT NULL,
	"agent_addr" text NOT NULL,
	"name" text NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"sealed_priv" "bytea" NOT NULL,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_keys_address_version_pk" PRIMARY KEY("address","version")
);
--> statement-breakpoint
ALTER TABLE "agent_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "caller_shares" (
	"epoch" bigint NOT NULL,
	"caller" text NOT NULL,
	"amount_usdg" numeric NOT NULL,
	"proof" jsonb NOT NULL,
	"claimed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "caller_shares_epoch_caller_pk" PRIMARY KEY("epoch","caller")
);
--> statement-breakpoint
ALTER TABLE "caller_shares" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "candles" (
	"coin" text NOT NULL,
	"interval" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"o" numeric NOT NULL,
	"h" numeric NOT NULL,
	"l" numeric NOT NULL,
	"c" numeric NOT NULL,
	"v" numeric NOT NULL,
	CONSTRAINT "candles_coin_interval_ts_pk" PRIMARY KEY("coin","interval","ts")
);
--> statement-breakpoint
ALTER TABLE "candles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "epochs" (
	"epoch" bigint PRIMARY KEY NOT NULL,
	"root" text NOT NULL,
	"total_usdg" numeric NOT NULL,
	"tx" text,
	"posted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "epochs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "fear_greed" (
	"ts" timestamp with time zone PRIMARY KEY NOT NULL,
	"value" smallint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fear_greed" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "fires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thesis_id" bigint NOT NULL,
	"fired_at" timestamp with time zone NOT NULL,
	"ref_mark" numeric NOT NULL,
	"flags" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fires" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "follows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"follower" text NOT NULL,
	"caller" text NOT NULL,
	"thesis_id" bigint,
	"size_rule" jsonb NOT NULL,
	"limits" jsonb NOT NULL,
	"sealed_allowlist" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "follows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "link_flags" (
	"a" text NOT NULL,
	"b" text NOT NULL,
	"reason" text NOT NULL,
	"score" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_flags_a_b_pk" PRIMARY KEY("a","b")
);
--> statement-breakpoint
ALTER TABLE "link_flags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "market_snapshots" (
	"coin" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"mark" numeric NOT NULL,
	"oracle" numeric,
	"funding" numeric,
	"oi" numeric,
	"volume_24h" numeric,
	CONSTRAINT "market_snapshots_coin_ts_pk" PRIMARY KEY("coin","ts")
);
--> statement-breakpoint
ALTER TABLE "market_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fire_id" uuid,
	"thesis_id" bigint NOT NULL,
	"account" text NOT NULL,
	"role" text NOT NULL,
	"wave" smallint NOT NULL,
	"venue" text NOT NULL,
	"cloid" text,
	"venue_order_id" text,
	"coin" text NOT NULL,
	"side" text NOT NULL,
	"size" numeric NOT NULL,
	"px" numeric,
	"reduce_only" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"filled_size" numeric DEFAULT '0' NOT NULL,
	"avg_px" numeric,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_cloid_unique" UNIQUE("cloid"),
	CONSTRAINT "orders_role" CHECK ("orders"."role" in ('caller','follower')),
	CONSTRAINT "orders_venue" CHECK ("orders"."venue" in ('hl','rhc')),
	CONSTRAINT "orders_side" CHECK ("orders"."side" in ('long','short','buy','sell')),
	CONSTRAINT "orders_status" CHECK ("orders"."status" in ('pending','acked','partial','filled','cancelled','rejected','failed'))
);
--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"endpoint" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"keys" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reveals" (
	"thesis_id" bigint NOT NULL,
	"part" text NOT NULL,
	"kind" text,
	"due_at" timestamp with time zone NOT NULL,
	"revealed_at" timestamp with time zone,
	"tx" text,
	CONSTRAINT "reveals_thesis_id_part_pk" PRIMARY KEY("thesis_id","part"),
	CONSTRAINT "reveals_part" CHECK ("reveals"."part" in ('entry','exit')),
	CONSTRAINT "reveals_kind" CHECK ("reveals"."kind" in ('FIRED','EXPIRED','RETIRED','MANUAL_NO_TRADE'))
);
--> statement-breakpoint
ALTER TABLE "reveals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "routes" (
	"id" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"kind" text NOT NULL,
	"amount_in" numeric NOT NULL,
	"amount_out" numeric,
	"status" text DEFAULT 'quoted' NOT NULL,
	"src_tx" text,
	"dst_tx" text,
	"refund_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routes_kind" CHECK ("routes"."kind" in ('fund','exit')),
	CONSTRAINT "routes_status" CHECK ("routes"."status" in ('quoted','submitted','bridging','done','refunded','failed'))
);
--> statement-breakpoint
ALTER TABLE "routes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stamp_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"enc_spec" "bytea" NOT NULL,
	"stamp" jsonb NOT NULL,
	"owner_sig" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"thesis_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stamp_requests_status" CHECK ("stamp_requests"."status" in ('pending','relaying','sealed','failed'))
);
--> statement-breakpoint
ALTER TABLE "stamp_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stamp_roots" (
	"hour_start" timestamp with time zone PRIMARY KEY NOT NULL,
	"root" text NOT NULL,
	"leaf_count" integer NOT NULL,
	"tx" text,
	"posted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "stamp_roots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stamps" (
	"leaf" text PRIMARY KEY NOT NULL,
	"thesis_id" bigint NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"hour_start" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stamps_thesis_seq" UNIQUE("thesis_id","seq"),
	CONSTRAINT "stamps_kind" CHECK ("stamps"."kind" in ('FIRE','FILL','EXIT','PNL','EXPIRE'))
);
--> statement-breakpoint
ALTER TABLE "stamps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "swap_keys" (
	"address" text PRIMARY KEY NOT NULL,
	"key_addr" text NOT NULL,
	"signed_policy" jsonb NOT NULL,
	"policy_sig" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "swap_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "telegram_links" (
	"address" text PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_links_chat_id_unique" UNIQUE("chat_id")
);
--> statement-breakpoint
ALTER TABLE "telegram_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "test_runs" (
	"test_id" text PRIMARY KEY NOT NULL,
	"owner" text,
	"snapshot_ids" text[] NOT NULL,
	"tester_version" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "theses" (
	"id" bigint PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"enc_spec" "bytea" NOT NULL,
	"entry_hash" text NOT NULL,
	"exit_hash" text NOT NULL,
	"mode" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"stamped_at" timestamp with time zone NOT NULL,
	"seal_tx" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	"state" text NOT NULL,
	"flags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "theses_state" CHECK ("theses"."state" in ('draft','live','alert','fired','closed','stopped','retired','expired')),
	CONSTRAINT "theses_mode" CHECK ("theses"."mode" in ('live','alert'))
);
--> statement-breakpoint
ALTER TABLE "theses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"address" text PRIMARY KEY NOT NULL,
	"auth_user_id" uuid,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hl_builders_approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_auth_user_id_unique" UNIQUE("auth_user_id")
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_address_users_address_fk" FOREIGN KEY ("address") REFERENCES "public"."users"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caller_shares" ADD CONSTRAINT "caller_shares_epoch_epochs_epoch_fk" FOREIGN KEY ("epoch") REFERENCES "public"."epochs"("epoch") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fires" ADD CONSTRAINT "fires_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_users_address_fk" FOREIGN KEY ("follower") REFERENCES "public"."users"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_caller_users_address_fk" FOREIGN KEY ("caller") REFERENCES "public"."users"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_fire_id_fires_id_fk" FOREIGN KEY ("fire_id") REFERENCES "public"."fires"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_address_users_address_fk" FOREIGN KEY ("address") REFERENCES "public"."users"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reveals" ADD CONSTRAINT "reveals_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_address_users_address_fk" FOREIGN KEY ("address") REFERENCES "public"."users"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stamp_requests" ADD CONSTRAINT "stamp_requests_owner_users_address_fk" FOREIGN KEY ("owner") REFERENCES "public"."users"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stamps" ADD CONSTRAINT "stamps_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swap_keys" ADD CONSTRAINT "swap_keys_address_users_address_fk" FOREIGN KEY ("address") REFERENCES "public"."users"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_address_users_address_fk" FOREIGN KEY ("address") REFERENCES "public"."users"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_owner_users_address_fk" FOREIGN KEY ("owner") REFERENCES "public"."users"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theses" ADD CONSTRAINT "theses_owner_users_address_fk" FOREIGN KEY ("owner") REFERENCES "public"."users"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_auth_user_id_users_id_fk" FOREIGN KEY ("auth_user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_address_idx" ON "activity" USING btree ("address","at");--> statement-breakpoint
CREATE INDEX "fires_thesis_idx" ON "fires" USING btree ("thesis_id");--> statement-breakpoint
CREATE INDEX "follows_caller_idx" ON "follows" USING btree ("caller") WHERE "follows"."active";--> statement-breakpoint
CREATE INDEX "orders_fire_idx" ON "orders" USING btree ("fire_id");--> statement-breakpoint
CREATE INDEX "orders_account_idx" ON "orders" USING btree ("account");--> statement-breakpoint
CREATE INDEX "reveals_due_idx" ON "reveals" USING btree ("due_at") WHERE "reveals"."revealed_at" is null;--> statement-breakpoint
CREATE INDEX "stamps_hour_idx" ON "stamps" USING btree ("hour_start");--> statement-breakpoint
CREATE INDEX "theses_owner_idx" ON "theses" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "theses_active_idx" ON "theses" USING btree ("state") WHERE "theses"."state" in ('live','alert');--> statement-breakpoint
CREATE POLICY "activity_select_own" ON "activity" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("activity"."address" = (select address from public.users where auth_user_id = (select auth.uid())));--> statement-breakpoint
CREATE POLICY "users_select_own" ON "users" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("users"."auth_user_id" = (select auth.uid()));