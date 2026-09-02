CREATE TYPE "public"."schedule_change_operation" AS ENUM('upsert', 'remove');--> statement-breakpoint
CREATE TABLE "schedule_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"schedule_id" uuid NOT NULL,
	"target_device_id" uuid,
	"operation" "schedule_change_operation" NOT NULL,
	"record" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_workspace_revisions" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "schedule_workspace_revisions" ("workspace_id", "revision", "updated_at")
SELECT "workspace_id", MAX("revision"), now() FROM "schedules" GROUP BY "workspace_id";--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "next_run_at" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "args" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "schedules" SET "args" = COALESCE("input"->'args', '[]'::jsonb);--> statement-breakpoint
UPDATE "schedules" SET "status" = 'disabled' WHERE "next_run_at" = 0;--> statement-breakpoint
ALTER TABLE "schedule_changes" ADD CONSTRAINT "schedule_changes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_changes" ADD CONSTRAINT "schedule_changes_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_changes" ADD CONSTRAINT "schedule_changes_target_device_id_devices_id_fk" FOREIGN KEY ("target_device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_workspace_revisions" ADD CONSTRAINT "schedule_workspace_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_changes_workspace_revision_idx" ON "schedule_changes" USING btree ("workspace_id","revision");--> statement-breakpoint
CREATE INDEX "schedule_changes_device_revision_idx" ON "schedule_changes" USING btree ("target_device_id","revision");
