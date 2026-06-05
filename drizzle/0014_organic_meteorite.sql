CREATE TABLE "conversation_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"turn_id" text,
	"chat_id" text NOT NULL,
	"agent_id" text,
	"specialist_id" text,
	"phase" text DEFAULT 'main' NOT NULL,
	"step_index" integer NOT NULL,
	"finish_reason" text,
	"text" text,
	"reasoning" text,
	"tool_calls" jsonb,
	"tool_results" jsonb,
	"rag_context" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"model" text,
	"duration_ms" integer,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "specialist_runs" (
	"specialist_id" text PRIMARY KEY NOT NULL,
	"parent_session_id" text NOT NULL,
	"task_description" text NOT NULL,
	"context_snapshot" text,
	"status" text DEFAULT 'running' NOT NULL,
	"result" text,
	"duration_ms" integer,
	"max_steps_used" integer,
	"can_resume" boolean,
	"background" boolean,
	"parent_specialist_id" text,
	"agent_id" text,
	"model_used" text,
	"spawned_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "turn_id" text;--> statement-breakpoint
CREATE INDEX "conversation_steps_turn_id_idx" ON "conversation_steps" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "conversation_steps_specialist_id_idx" ON "conversation_steps" USING btree ("specialist_id");--> statement-breakpoint
CREATE INDEX "conversation_steps_chat_agent_created_idx" ON "conversation_steps" USING btree ("chat_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "specialist_runs_spawned_at_idx" ON "specialist_runs" USING btree ("spawned_at");--> statement-breakpoint
CREATE INDEX "specialist_runs_parent_specialist_id_idx" ON "specialist_runs" USING btree ("parent_specialist_id");--> statement-breakpoint
CREATE INDEX "conversations_turn_id_idx" ON "conversations" USING btree ("turn_id");