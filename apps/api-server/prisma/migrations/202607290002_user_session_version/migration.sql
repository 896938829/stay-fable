ALTER TABLE "user"
ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0,
ADD CONSTRAINT "user_session_version_nonnegative_check"
CHECK ("session_version" >= 0);

-- Session invalidation is a database invariant: every real status transition,
-- including direct SQL updates, advances the epoch exactly once.
CREATE FUNCTION "bump_user_session_version"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."session_version" := OLD."session_version" + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "user_status_session_version_trigger"
BEFORE UPDATE OF "status" ON "user"
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status")
EXECUTE FUNCTION "bump_user_session_version"();
