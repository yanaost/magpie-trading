CREATE TABLE "kill_switch" (
	"id" text PRIMARY KEY NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"reason" text,
	"tripped_by" text,
	"tripped_at" timestamp with time zone,
	"rearmed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
