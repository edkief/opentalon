CREATE TABLE "specialist_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"agent_id" text,
	"expected_count" integer NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"original_request" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "batch_id" text;--> statement-breakpoint
CREATE INDEX "jobs_batch_id_idx" ON "jobs" USING btree ("batch_id");