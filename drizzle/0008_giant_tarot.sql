CREATE TABLE "user_inputs" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"prompt" text NOT NULL,
	"options" text[],
	"status" text DEFAULT 'pending' NOT NULL,
	"response" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "user_guidance" text;