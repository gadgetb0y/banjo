CREATE TYPE "public"."contact_category" AS ENUM('salon', 'medical', 'restaurant', 'home_services', 'other');--> statement-breakpoint
CREATE TYPE "public"."preferred_channel" AS ENUM('phone', 'online');--> statement-breakpoint
CREATE TYPE "public"."relationship_tier" AS ENUM('family', 'friend');--> statement-breakpoint
CREATE TYPE "public"."call_attempt_status" AS ENUM('connecting', 'active', 'tool_pending', 'ending', 'ended', 'error');--> statement-breakpoint
CREATE TYPE "public"."task_channel" AS ENUM('phone', 'online');--> statement-breakpoint
CREATE TYPE "public"."task_mode" AS ENUM('booking', 'conversation');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'checking_availability', 'calling', 'negotiating', 'confirmed', 'voicemail_left', 'negotiation_failed', 'escalated', 'conversation_completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."inbound_booking_status" AS ENUM('active', 'rescheduled', 'cancelled');--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"phone_number" text NOT NULL,
	"category" "contact_category" DEFAULT 'other' NOT NULL,
	"preferred_channel" "preferred_channel",
	"booking_url" text,
	"notes" text,
	"email" text,
	"google_resource_name" text,
	"relationship_tier" "relationship_tier",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"provider_call_id" text,
	"status" "call_attempt_status" DEFAULT 'connecting' NOT NULL,
	"answered_by" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"error_detail" text
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel" "task_channel" NOT NULL,
	"mode" "task_mode" DEFAULT 'booking' NOT NULL,
	"goal_description" text NOT NULL,
	"constraints" jsonb NOT NULL,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"candidate_windows" jsonb,
	"outcome" jsonb,
	"calendar_event_id" text,
	"scheduled_for" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inbound_call_id" uuid NOT NULL,
	"caller_phone_number" text NOT NULL,
	"calendar_event_id" text NOT NULL,
	"confirmed_start" timestamp with time zone NOT NULL,
	"duration_minutes" integer NOT NULL,
	"purpose" text NOT NULL,
	"caller_name" text NOT NULL,
	"status" "inbound_booking_status" DEFAULT 'active' NOT NULL,
	"previous_booking_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"twilio_call_sid" text NOT NULL,
	"caller_phone_number" text NOT NULL,
	"contact_id" uuid,
	"status" "call_attempt_status" DEFAULT 'connecting' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_calls_twilio_call_sid_unique" UNIQUE("twilio_call_sid")
);
--> statement-breakpoint
CREATE TABLE "google_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"google_resource_name" text NOT NULL,
	"display_name" text NOT NULL,
	"phone_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"email" text,
	"relation_labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"group_labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_contacts_google_resource_name_unique" UNIQUE("google_resource_name")
);
--> statement-breakpoint
ALTER TABLE "call_attempts" ADD CONSTRAINT "call_attempts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_bookings" ADD CONSTRAINT "inbound_bookings_inbound_call_id_inbound_calls_id_fk" FOREIGN KEY ("inbound_call_id") REFERENCES "public"."inbound_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_bookings" ADD CONSTRAINT "inbound_bookings_previous_booking_id_inbound_bookings_id_fk" FOREIGN KEY ("previous_booking_id") REFERENCES "public"."inbound_bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_calls" ADD CONSTRAINT "inbound_calls_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_phone_number_unique" ON "contacts" USING btree ("phone_number");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_google_resource_name_unique" ON "contacts" USING btree ("google_resource_name");--> statement-breakpoint
CREATE INDEX "inbound_bookings_caller_status_idx" ON "inbound_bookings" USING btree ("caller_phone_number","status");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_bookings_one_active_per_caller" ON "inbound_bookings" USING btree ("caller_phone_number") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "google_contacts_phone_numbers_gin" ON "google_contacts" USING gin ("phone_numbers");