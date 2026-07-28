DROP TRIGGER "user_status_session_version_trigger" ON "user";

CREATE OR REPLACE FUNCTION "bump_user_session_version"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."session_version" < OLD."session_version" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'user session version cannot decrease',
      CONSTRAINT = 'user_session_version_monotonic_check';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NEW."session_version" < OLD."session_version" + 1 THEN
    NEW."session_version" := OLD."session_version" + 1;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "user_status_session_version_trigger"
BEFORE UPDATE OF "status", "session_version" ON "user"
FOR EACH ROW
EXECUTE FUNCTION "bump_user_session_version"();
