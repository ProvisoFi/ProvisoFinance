ALTER TABLE "test_runs" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_request_id_unique" UNIQUE("request_id");