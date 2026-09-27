CREATE TABLE "conversation_models" (
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"settings" jsonb NOT NULL,
	CONSTRAINT "conversation_models_user_id_agent_id_thread_id_pk" PRIMARY KEY("user_id","agent_id","thread_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_models" ADD CONSTRAINT "conversation_models_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;