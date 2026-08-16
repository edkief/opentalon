CREATE TABLE "embed_inbound" (
	"chat_id" text NOT NULL,
	"client_message_id" text NOT NULL,
	"turn_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "embed_inbound_chat_id_client_message_id_pk" PRIMARY KEY("chat_id","client_message_id")
);
--> statement-breakpoint
CREATE TABLE "embed_outbox" (
	"chat_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text DEFAULT 'message' NOT NULL,
	"role" text DEFAULT 'assistant' NOT NULL,
	"content" text NOT NULL,
	"format" text DEFAULT 'markdown' NOT NULL,
	"turn_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "embed_outbox_chat_id_seq_pk" PRIMARY KEY("chat_id","seq")
);
--> statement-breakpoint
CREATE TABLE "embed_threads" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"user_key" text NOT NULL,
	"user_label" text,
	"title" text,
	"url" text,
	"context" jsonb,
	"context_version" text,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "embed_outbox_created_at_idx" ON "embed_outbox" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "embed_threads_client_resource_idx" ON "embed_threads" USING btree ("client_id","resource_id");