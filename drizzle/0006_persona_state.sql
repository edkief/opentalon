CREATE TABLE "persona_state" (
  "chat_id"      text PRIMARY KEY NOT NULL,
  "persona_name" text NOT NULL DEFAULT 'default',
  "updated_at"   timestamp DEFAULT now() NOT NULL
);
