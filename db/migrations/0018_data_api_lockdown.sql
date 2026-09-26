BEGIN;

-- ============================================================================
-- 0018: Data-API lockdown — raw Supabase Data API must not reach app tables.
--
-- ThunderFeed has NO client-side Supabase access: browser → Next.js server →
-- privileged `pg` connection → Postgres. The `postgres` pooler role bypasses
-- RLS, so enabling RLS + revoking the PostgREST roles' grants locks the raw
-- table surface without affecting the application.
--
--   (a) ENABLE ROW LEVEL SECURITY on every public table, with NO policies —
--       deny-by-default for anon/authenticated. Deliberately no permissive
--       policies: silence the risk, not just the advisor.
--   (b) REVOKE all table privileges from anon/authenticated — belt+braces;
--       even if RLS were disabled later the roles still hold nothing.
--   (c) ALTER DEFAULT PRIVILEGES for the migration owner (postgres) so tables
--       created by future migrations (Instrument Master etc.) are born with
--       no anon/authenticated grants.
--   (d) Event trigger auto-enables RLS on any future CREATE TABLE — the one
--       half of the invariant default privileges cannot express.
--   (e) Fix function_search_path_mutable on ThunderFeed functions.
--
-- Everything here is PG-ONLY: pg-mem cannot parse RLS/GRANT/ALTER FUNCTION
-- and does not need these statements — test fixtures never exercise the
-- Data API. Regression coverage asserts the declarations exist.
-- == PG-ONLY: everything below runs only on real Postgres ==

-- (a) RLS deny-by-default on all current app tables
ALTER TABLE changes                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_evidence             ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_versions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_state             ENABLE ROW LEVEL SECURITY;
ALTER TABLE edition_snapshots          ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_aliases             ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_identifiers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_relationships       ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_embeddings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_entities             ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_evidence             ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_versions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE events                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_discoveries       ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_documents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_entities          ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_lineage           ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_metadata_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_versions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_cycles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_source_stats        ENABLE ROW LEVEL SECURITY;
ALTER TABLE resolver_decisions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources                    ENABLE ROW LEVEL SECURITY;

-- (b) revoke PostgREST-role table privileges (Supabase auto-grants these
--     by default on the public schema)
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
  FROM anon, authenticated;

-- (c) future tables/sequences created by the migration owner (postgres —
--     verified via pg_class.relowner) get no auto-grants
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- (d) auto-enable RLS on every future table — the invariant default
--     privileges cannot express. SECURITY DEFINER so it can ALTER TABLE
--     regardless of which role runs the CREATE; fixed search_path.
CREATE OR REPLACE FUNCTION public.tf_enable_rls_on_new_table()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    IF r.object_type = 'table'
       AND r.schema_name = 'public' THEN
      EXECUTE format(
        'ALTER TABLE %s ENABLE ROW LEVEL SECURITY', r.object_identity);
    END IF;
  END LOOP;
END;
$$;

DROP EVENT TRIGGER IF EXISTS tf_enable_rls_on_create;
CREATE EVENT TRIGGER tf_enable_rls_on_create ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE')
  EXECUTE FUNCTION public.tf_enable_rls_on_new_table();

-- (e) fixed search_path on ThunderFeed functions
--     uuid_v7 needs extensions.gen_random_bytes (pgcrypto lives in the
--     extensions schema on Supabase); the trigger function uses only
--     built-ins.
ALTER FUNCTION public.uuid_v7()
  SET search_path = pg_catalog, extensions;
ALTER FUNCTION public.reject_history_mutation()
  SET search_path = pg_catalog;

COMMIT;
