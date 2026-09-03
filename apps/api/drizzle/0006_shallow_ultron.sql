ALTER TABLE "applications" ADD COLUMN "default_locale" text DEFAULT 'en-US' NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "localizations" jsonb DEFAULT '{}'::jsonb NOT NULL;