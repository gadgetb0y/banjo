CREATE TYPE "public"."transcript_quality" AS ENUM('ok', 'suspect');--> statement-breakpoint
CREATE TYPE "public"."transcript_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TABLE "call_transcript_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_attempt_id" uuid,
	"inbound_call_id" uuid,
	"seq" integer NOT NULL,
	"role" "transcript_role" NOT NULL,
	"text" text NOT NULL,
	"quality" "transcript_quality" NOT NULL,
	"voice_provider" text NOT NULL,
	"spoken_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_transcript_turns_one_call" CHECK (("call_transcript_turns"."call_attempt_id" IS NULL) <> ("call_transcript_turns"."inbound_call_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "call_transcript_turns" ADD CONSTRAINT "call_transcript_turns_call_attempt_id_call_attempts_id_fk" FOREIGN KEY ("call_attempt_id") REFERENCES "public"."call_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_transcript_turns" ADD CONSTRAINT "call_transcript_turns_inbound_call_id_inbound_calls_id_fk" FOREIGN KEY ("inbound_call_id") REFERENCES "public"."inbound_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "call_transcript_turns_attempt_seq" ON "call_transcript_turns" USING btree ("call_attempt_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "call_transcript_turns_inbound_seq" ON "call_transcript_turns" USING btree ("inbound_call_id","seq");--> statement-breakpoint
CREATE INDEX "call_transcript_turns_spoken_at_idx" ON "call_transcript_turns" USING btree ("spoken_at");