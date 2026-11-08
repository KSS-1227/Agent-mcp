-- Give each confirmed Supabase user one owned agent so the dashboard has something to show.
-- Deliberately does NOT create an auth_users row: MCP access stays a separate, manual grant
-- until per-user isolation of resources and intents exists.
CREATE OR REPLACE FUNCTION public.handle_confirmed_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.agents WHERE owner_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.agents (id, key, name, owner_id)
  VALUES (
    gen_random_uuid(),
    'user:' || NEW.id::text,
    COALESCE(NULLIF(split_part(NEW.email, '@', 1), ''), 'My agent'),
    NEW.id
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'handle_confirmed_user failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_confirmed_user() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_confirmed ON auth.users;
CREATE TRIGGER on_auth_user_confirmed
  AFTER INSERT OR UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  WHEN (NEW.email_confirmed_at IS NOT NULL)
  EXECUTE FUNCTION public.handle_confirmed_user();