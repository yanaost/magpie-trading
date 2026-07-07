ALTER TABLE "llm_analyses" ALTER COLUMN "signal_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_analyses" ALTER COLUMN "verdict" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_analyses" ADD COLUMN "purpose" text DEFAULT 'signal_analysis' NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_analyses" ADD COLUMN "strategy_id" text;--> statement-breakpoint
ALTER TABLE "llm_analyses" ADD COLUMN "ticker" text;--> statement-breakpoint
ALTER TABLE "llm_analyses" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "llm_analyses" ADD COLUMN "system_prompt" text;--> statement-breakpoint
ALTER TABLE "llm_analyses" ADD COLUMN "user_prompt" text;--> statement-breakpoint
ALTER TABLE "llm_analyses" ADD COLUMN "params" jsonb;--> statement-breakpoint
ALTER TABLE "llm_analyses" ADD COLUMN "web_searches" jsonb;--> statement-breakpoint
ALTER TABLE "llm_analyses" ADD COLUMN "error_text" text;--> statement-breakpoint
CREATE INDEX "llm_analyses_purpose_idx" ON "llm_analyses" USING btree ("purpose");--> statement-breakpoint
CREATE INDEX "llm_analyses_ticker_idx" ON "llm_analyses" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "llm_analyses_created_idx" ON "llm_analyses" USING btree ("created_at");