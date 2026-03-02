CREATE TABLE "scheduled_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"description" text NOT NULL,
	"cron_expression" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp,
	"next_run_at" timestamp,
	"last_result" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "scheduled_tasks_chat_id_idx" ON "scheduled_tasks" USING btree ("chat_id");