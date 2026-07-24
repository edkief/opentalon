CREATE TABLE "pending_turns" (
	"turn_id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"message_id" integer NOT NULL,
	"scope" text NOT NULL,
	"user_content" text NOT NULL,
	"model_override" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pending_turns_chat_id_idx" ON "pending_turns" USING btree ("chat_id");
