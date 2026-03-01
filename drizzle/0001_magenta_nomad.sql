CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"task_description" text NOT NULL,
	"result" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "jobs_chat_id_idx" ON "jobs" USING btree ("chat_id");