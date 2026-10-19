CREATE TABLE "telegram_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "x_handles" (
	"handle" text PRIMARY KEY NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_id" text
);
--> statement-breakpoint
ALTER TABLE "x_handles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "telegram_codes" ADD CONSTRAINT "telegram_codes_address_users_address_fk" FOREIGN KEY ("address") REFERENCES "public"."users"("address") ON DELETE no action ON UPDATE no action;