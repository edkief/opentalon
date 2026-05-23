CREATE TABLE "file_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"path" text NOT NULL,
	"mime_hint" text,
	"agent_id" text,
	"chat_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX "file_shares_slug_idx" ON "file_shares" USING btree ("slug");