ALTER TABLE "artifacts" ALTER COLUMN "signature" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "releases" ALTER COLUMN "signature" DROP NOT NULL;