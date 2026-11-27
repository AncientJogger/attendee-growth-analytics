-- On Supabase, the anon and authenticated roles (used by the auto-generated REST API) get
-- table privileges by default. This app never uses them: every query goes through the
-- server with the fga_app role. Revoke their access so the REST API exposes nothing.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
    end if;
  end loop;
end $$;
