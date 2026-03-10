ALTER TABLE "conversations" ADD COLUMN "persona_id" text;--> statement-breakpoint
CREATE INDEX "chat_persona_created_idx" ON "conversations" USING btree ("chat_id","persona_id","created_at");