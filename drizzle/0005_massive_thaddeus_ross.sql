ALTER TYPE "public"."task_mode" ADD VALUE 'ask';--> statement-breakpoint
ALTER TYPE "public"."task_status" ADD VALUE 'answered' BEFORE 'failed';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "questions" jsonb;