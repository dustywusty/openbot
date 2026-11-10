CREATE TABLE "desktop_computer_pairings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"computer_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"name" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desktop_pairing_installation" (
	"id" text PRIMARY KEY NOT NULL,
	"audience" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "desktop_computer_pairings" ADD CONSTRAINT "desktop_computer_pairings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_computer_pairings_installation_vm_idx" ON "desktop_computer_pairings" USING btree ("installation_id","computer_id");--> statement-breakpoint
CREATE INDEX "desktop_computer_pairings_owner_idx" ON "desktop_computer_pairings" USING btree ("owner_user_id");