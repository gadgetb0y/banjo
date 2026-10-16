ALTER TABLE "tasks" ADD COLUMN "approval_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "call_cap_override" boolean DEFAULT false NOT NULL;