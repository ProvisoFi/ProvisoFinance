CREATE TABLE "feed_wanted" (
	"feed" text PRIMARY KEY NOT NULL,
	"wanted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feed_wanted" ENABLE ROW LEVEL SECURITY;