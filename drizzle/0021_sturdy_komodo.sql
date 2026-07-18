ALTER TABLE "conversation_steps" ADD COLUMN "cache_read_tokens" integer;--> statement-breakpoint
ALTER TABLE "conversation_steps" ADD COLUMN "cache_write_tokens" integer;--> statement-breakpoint
ALTER TABLE "conversation_steps" ADD COLUMN "reasoning_tokens" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "cache_read_tokens" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "cache_write_tokens" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "reasoning_tokens" integer;