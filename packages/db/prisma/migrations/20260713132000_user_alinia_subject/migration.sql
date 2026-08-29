-- Federation link for "Sign in with Alinia": the Alinia identity_id (carried as
-- the id_token `sub`) of an Alinia-provisioned tenant owner. NULL for normal
-- Hader users; NULLs are distinct in Postgres so they never collide.
ALTER TABLE "users" ADD COLUMN "alinia_subject" TEXT;
CREATE UNIQUE INDEX "users_alinia_subject_key" ON "users"("alinia_subject");
