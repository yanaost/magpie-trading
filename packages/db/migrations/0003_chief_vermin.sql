CREATE TABLE "backtest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"label" text NOT NULL,
	"params" jsonb NOT NULL,
	"from_ts" timestamp with time zone NOT NULL,
	"to_ts" timestamp with time zone NOT NULL,
	"bars" integer NOT NULL,
	"report" jsonb NOT NULL,
	"replay_stubbed" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "backtest_runs_strategy_idx" ON "backtest_runs" USING btree ("strategy_id","instance_id");