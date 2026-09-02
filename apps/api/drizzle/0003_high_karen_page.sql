DROP INDEX "users_primary_email_uq";--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "actor_device_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "credential_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_device_id_devices_id_fk" FOREIGN KEY ("actor_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_credential_hash_uq" ON "devices" USING btree ("credential_hash");--> statement-breakpoint
CREATE INDEX "users_primary_email_idx" ON "users" USING btree ("primary_email");