ALTER TABLE "specialist_runs" ADD COLUMN "turn_id" text;--> statement-breakpoint
CREATE INDEX "specialist_runs_turn_id_idx" ON "specialist_runs" USING btree ("turn_id");