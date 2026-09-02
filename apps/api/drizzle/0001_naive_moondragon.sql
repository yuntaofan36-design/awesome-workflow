CREATE TABLE "cli_authorizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"state" text NOT NULL,
	"user_id" uuid,
	"code_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"authorized_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cli_authorizations" ADD CONSTRAINT "cli_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cli_authorizations_code_hash_uq" ON "cli_authorizations" USING btree ("code_hash");