ALTER TABLE "persona_state" RENAME TO "agent_state";--> statement-breakpoint
ALTER TABLE "conversations" RENAME COLUMN "persona_id" TO "agent_id";--> statement-breakpoint
ALTER TABLE "agent_state" RENAME COLUMN "persona_name" TO "agent_name";--> statement-breakpoint
DROP INDEX "chat_persona_created_idx";--> statement-breakpoint
CREATE INDEX "chat_agent_created_idx" ON "conversations" USING btree ("chat_id","agent_id","created_at");