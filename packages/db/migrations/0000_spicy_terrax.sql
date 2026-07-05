CREATE TYPE "public"."bracket_role" AS ENUM('parent', 'stop', 'target');--> statement-breakpoint
CREATE TYPE "public"."decided_by" AS ENUM('user', 'auto');--> statement-breakpoint
CREATE TYPE "public"."journal_entry_type" AS ENUM('decision', 'note');--> statement-breakpoint
CREATE TYPE "public"."mode" AS ENUM('AUTO', 'APPROVE', 'WATCH', 'OFF');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending_submit', 'submitted', 'working', 'filled', 'cancelled', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."position_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'approved', 'rejected', 'expired', 'executed');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."side" AS ENUM('long', 'short');--> statement-breakpoint
CREATE TYPE "public"."execution_target" AS ENUM('SIM', 'PAPER', 'LIVE');--> statement-breakpoint
CREATE TYPE "public"."timeframe" AS ENUM('intraday', 'swing', 'weekly', 'observation', 'filter');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('proceed', 'veto');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candles" (
	"ticker" text NOT NULL,
	"timeframe" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"open" numeric(20, 8) NOT NULL,
	"high" numeric(20, 8) NOT NULL,
	"low" numeric(20, 8) NOT NULL,
	"close" numeric(20, 8) NOT NULL,
	"volume" numeric(20, 2) NOT NULL,
	CONSTRAINT "candles_ticker_timeframe_ts_pk" PRIMARY KEY("ticker","timeframe","ts")
);
--> statement-breakpoint
CREATE TABLE "crowded_tickers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticker" text NOT NULL,
	"source_evidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"target" "execution_target" NOT NULL,
	"broker_exec_id" text,
	"ticker" text NOT NULL,
	"side" "side" NOT NULL,
	"qty" numeric(20, 8) NOT NULL,
	"price" numeric(20, 8) NOT NULL,
	"commission" numeric(20, 2) DEFAULT '0' NOT NULL,
	"filled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" text,
	"entry_type" "journal_entry_type" NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"title" text NOT NULL,
	"body" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"verdict" "verdict" NOT NULL,
	"confidence" numeric(5, 4),
	"reasoning" text,
	"flagged_risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_response" text,
	"latency_ms" integer,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid,
	"strategy_id" text NOT NULL,
	"parent_order_id" uuid,
	"bracket_role" "bracket_role" NOT NULL,
	"target" "execution_target" NOT NULL,
	"broker_order_id" text,
	"ticker" text NOT NULL,
	"side" "side" NOT NULL,
	"qty" numeric(20, 8) NOT NULL,
	"limit_price" numeric(20, 8),
	"stop_price" numeric(20, 8),
	"status" "order_status" DEFAULT 'pending_submit' NOT NULL,
	"submitted_at" timestamp with time zone,
	"filled_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" text NOT NULL,
	"sim_portfolio_id" uuid,
	"target" "execution_target" NOT NULL,
	"ticker" text NOT NULL,
	"side" "side" NOT NULL,
	"status" "position_status" DEFAULT 'open' NOT NULL,
	"qty" numeric(20, 8) NOT NULL,
	"avg_entry_price" numeric(20, 8) NOT NULL,
	"avg_exit_price" numeric(20, 8),
	"stop_price" numeric(20, 8),
	"realized_pnl" numeric(20, 2) DEFAULT '0' NOT NULL,
	"unrealized_pnl" numeric(20, 2) DEFAULT '0' NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"strategy_id" text NOT NULL,
	"ticker" text NOT NULL,
	"side" "side" NOT NULL,
	"qty" numeric(20, 8) NOT NULL,
	"entry" numeric(20, 8) NOT NULL,
	"stop" numeric(20, 8) NOT NULL,
	"target" numeric(20, 8),
	"exit_plan" jsonb NOT NULL,
	"risk_usd" numeric(20, 2) NOT NULL,
	"risk_pct" numeric(8, 4) NOT NULL,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"execution_target" "execution_target" NOT NULL,
	"decided_by" "decided_by",
	"decided_at" timestamp with time zone,
	"expiry" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" text,
	"proposal_id" uuid,
	"rule" text NOT NULL,
	"reason" text NOT NULL,
	"context" jsonb,
	"severity" "severity" DEFAULT 'warning' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" text NOT NULL,
	"ticker" text NOT NULL,
	"trigger" jsonb NOT NULL,
	"quant_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_portfolios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_instance_id" text NOT NULL,
	"variant_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"starting_cash" numeric(20, 2) NOT NULL,
	"virtual_cash" numeric(20, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reset_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"timeframe" timeframe NOT NULL,
	"mode" "mode" DEFAULT 'WATCH' NOT NULL,
	"target" "execution_target" DEFAULT 'SIM' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_analyses" ADD CONSTRAINT "llm_analyses_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_sim_portfolio_id_sim_portfolios_id_fk" FOREIGN KEY ("sim_portfolio_id") REFERENCES "public"."sim_portfolios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "crowded_tickers_ticker_idx" ON "crowded_tickers" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "fills_order_idx" ON "fills" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "journal_strategy_idx" ON "journal_entries" USING btree ("strategy_id");--> statement-breakpoint
CREATE INDEX "llm_analyses_signal_idx" ON "llm_analyses" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX "orders_proposal_idx" ON "orders" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "orders_broker_idx" ON "orders" USING btree ("broker_order_id");--> statement-breakpoint
CREATE INDEX "orders_parent_idx" ON "orders" USING btree ("parent_order_id");--> statement-breakpoint
CREATE INDEX "positions_strategy_idx" ON "positions" USING btree ("strategy_id");--> statement-breakpoint
CREATE INDEX "positions_status_idx" ON "positions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "positions_ticker_idx" ON "positions" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "proposals_status_idx" ON "proposals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "proposals_strategy_idx" ON "proposals" USING btree ("strategy_id");--> statement-breakpoint
CREATE INDEX "risk_events_strategy_idx" ON "risk_events" USING btree ("strategy_id");--> statement-breakpoint
CREATE INDEX "signals_strategy_idx" ON "signals" USING btree ("strategy_id");--> statement-breakpoint
CREATE INDEX "signals_ticker_idx" ON "signals" USING btree ("ticker");