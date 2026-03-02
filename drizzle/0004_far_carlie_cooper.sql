ALTER TABLE "conversations" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "model" text;