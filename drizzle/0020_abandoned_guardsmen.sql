CREATE TABLE "email_messages" (
	"message_id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"direction" text NOT NULL,
	"imap_uid" integer,
	"mailbox" text,
	"from_address" text NOT NULL,
	"to_addresses" text[] NOT NULL,
	"cc_addresses" text[],
	"subject" text,
	"normalized_subject" text,
	"in_reply_to" text,
	"references_ids" text[],
	"processed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_sync_state" (
	"mailbox" text PRIMARY KEY NOT NULL,
	"uid_validity" text NOT NULL,
	"last_uid" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "email_messages_chat_id_idx" ON "email_messages" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "email_messages_norm_subject_created_idx" ON "email_messages" USING btree ("normalized_subject","created_at");