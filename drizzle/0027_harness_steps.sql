ALTER TABLE "conversation_steps" ADD COLUMN "harness" text;--> statement-breakpoint
ALTER TABLE "conversation_steps" ADD COLUMN "harness_cost_usd" double precision;--> statement-breakpoint
ALTER TABLE "specialist_runs" ADD COLUMN "executor" text;