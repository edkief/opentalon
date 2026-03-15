CREATE TABLE "workflow_hitl_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"prompt" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"chat_id" text,
	"expires_at" timestamp NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_run_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"node_type" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"input_data" jsonb,
	"output_data" jsonb,
	"completed_child_count" integer DEFAULT 0 NOT NULL,
	"job_id" text,
	"hitl_id" text,
	"error_message" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"trigger_data" jsonb,
	"result" jsonb,
	"error_message" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"definition" jsonb NOT NULL,
	"layout" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_hitl_requests" ADD CONSTRAINT "workflow_hitl_requests_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_nodes" ADD CONSTRAINT "workflow_run_nodes_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_hitl_run_id_idx" ON "workflow_hitl_requests" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "workflow_hitl_status_idx" ON "workflow_hitl_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workflow_run_nodes_run_id_idx" ON "workflow_run_nodes" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "workflow_run_nodes_run_status_idx" ON "workflow_run_nodes" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "workflow_run_nodes_job_id_idx" ON "workflow_run_nodes" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_workflow_id_idx" ON "workflow_runs" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_status_idx" ON "workflow_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workflows_status_idx" ON "workflows" USING btree ("status");