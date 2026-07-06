ALTER TABLE "llm_analyses" ADD COLUMN "context_hash" text;--> statement-breakpoint
CREATE INDEX "llm_analyses_context_hash_idx" ON "llm_analyses" USING btree ("context_hash");