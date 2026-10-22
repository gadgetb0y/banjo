CREATE TYPE "public"."transcript_leg" AS ENUM('banjo', 'transferred');--> statement-breakpoint
ALTER TYPE "public"."transcript_role" ADD VALUE 'owner';--> statement-breakpoint
CREATE TABLE "owner_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"call_attempt_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_transcript_turns" ADD COLUMN "leg" "transcript_leg" DEFAULT 'banjo' NOT NULL;--> statement-breakpoint
ALTER TABLE "owner_questions" ADD CONSTRAINT "owner_questions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_questions" ADD CONSTRAINT "owner_questions_call_attempt_id_call_attempts_id_fk" FOREIGN KEY ("call_attempt_id") REFERENCES "public"."call_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_questions_call_attempt_idx" ON "owner_questions" USING btree ("call_attempt_id");--> statement-breakpoint
CREATE INDEX "owner_questions_asked_at_idx" ON "owner_questions" USING btree ("asked_at");