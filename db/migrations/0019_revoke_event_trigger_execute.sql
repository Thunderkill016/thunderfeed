BEGIN;

-- ============================================================================
-- 0019: the auto-RLS event-trigger function must not be RPC-callable.
--
-- Supabase advisor (anon_security_definer_function_executable /
-- authenticated_security_definer_function_executable): public schema
-- functions are exposed as /rest/v1/rpc/* to the API roles; PUBLIC grants
-- EXECUTE by default. The function only makes sense inside a DDL event
-- trigger context — strip EXECUTE from everyone but the owner.
-- == PG-ONLY: grants — pg-mem cannot parse REVOKE ==

REVOKE EXECUTE ON FUNCTION public.tf_enable_rls_on_new_table()
  FROM PUBLIC, anon, authenticated;

COMMIT;
