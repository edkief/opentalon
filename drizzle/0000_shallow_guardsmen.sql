CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "chat_id_idx" ON "conversations" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "created_at_idx" ON "conversations" USING btree ("created_at");