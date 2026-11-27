-- Row-level security.
-- User requests run inside a transaction that does `SET LOCAL ROLE fga_app` and sets
-- app.user_id / app.role / app.workspace_id. fga_app owns nothing and has no BYPASSRLS,
-- so every policy below applies. System jobs (migrations, seeding, imports) run as the
-- table owner and are not subject to these policies.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'fga_app') then
    create role fga_app nologin;
  end if;
end $$;
grant fga_app to current_user;
grant usage on schema public to fga_app;
grant select, insert, update, delete on all tables in schema public to fga_app;
grant usage, select on all sequences in schema public to fga_app;

create or replace function fga_uid() returns uuid language sql stable as
$$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
create or replace function fga_role() returns text language sql stable as
$$ select coalesce(current_setting('app.role', true), '') $$;
create or replace function fga_ws() returns uuid language sql stable as
$$ select nullif(current_setting('app.workspace_id', true), '')::uuid $$;
create or replace function fga_is_admin() returns boolean language sql stable as
$$ select fga_role() = 'admin' $$;

-- Campaign managers act on initiatives they are assigned to.
create or replace function fga_manages_initiative(init uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select init is not null and exists (
    select 1 from initiative_assignments ia
    where ia.initiative_id = init and ia.user_id = fga_uid())
$$;
-- ...or campaigns owned by the team member linked to their login.
create or replace function fga_manages_campaign(camp uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select camp is not null and exists (
    select 1 from campaigns c
    left join app_users u on u.id = fga_uid()
    where c.id = camp
      and (fga_manages_initiative(c.initiative_id)
           or (u.team_member_id is not null and c.owner_team_member_id = u.team_member_id)))
$$;

-- Enable RLS and add a workspace-scoped read policy on every table that has workspace_id.
do $$
declare t text;
begin
  for t in
    select c.table_name from information_schema.columns c
    join information_schema.tables tb on tb.table_name = c.table_name and tb.table_schema = 'public'
    where c.table_schema = 'public' and c.column_name = 'workspace_id' and tb.table_type = 'BASE TABLE'
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select to fga_app using (workspace_id = fga_ws())', t || '_read', t);
  end loop;
end $$;

alter table workspaces enable row level security;
create policy workspaces_read on workspaces for select to fga_app using (id = fga_ws());
create policy workspaces_admin on workspaces for update to fga_app using (id = fga_ws() and fga_is_admin());

-- Imported facts and dataset admin: admins only.
do $$
declare t text;
begin
  foreach t in array array['dataset_uploads','dataset_versions','raw_source_rows','import_errors','event_info',
                           'target_versions','people','interactions','registrations','campaign_daily','check_ins',
                           'team_members','app_users','initiative_assignments','strategy_configs']
  loop
    execute format('create policy %I on %I for all to fga_app using (workspace_id = fga_ws() and fga_is_admin()) with check (workspace_id = fga_ws() and fga_is_admin())', t || '_admin_write', t);
  end loop;
end $$;

-- Registration status corrections: admins, or managers for their campaigns' registrations.
create policy rsh_write on registration_status_history for insert to fga_app
  with check (workspace_id = fga_ws() and (fga_is_admin() or exists (
    select 1 from registrations r where r.id = registration_id and fga_manages_campaign(r.campaign_id))));

-- Campaigns: admins, or managers for campaigns in scope.
create policy campaigns_admin on campaigns for all to fga_app
  using (workspace_id = fga_ws() and fga_is_admin()) with check (workspace_id = fga_ws() and fga_is_admin());
create policy campaigns_manager_update on campaigns for update to fga_app
  using (workspace_id = fga_ws() and fga_role() = 'campaign_manager' and fga_manages_campaign(id))
  with check (workspace_id = fga_ws() and fga_role() = 'campaign_manager' and fga_manages_campaign(id));

-- Initiatives: admins; assigned managers may update their own.
create policy initiatives_admin on initiatives for all to fga_app
  using (workspace_id = fga_ws() and fga_is_admin()) with check (workspace_id = fga_ws() and fga_is_admin());
create policy initiatives_manager_update on initiatives for update to fga_app
  using (workspace_id = fga_ws() and fga_role() = 'campaign_manager' and fga_manages_initiative(id))
  with check (workspace_id = fga_ws() and fga_role() = 'campaign_manager' and fga_manages_initiative(id));

-- Tasks.
create policy tasks_admin on tasks for all to fga_app
  using (workspace_id = fga_ws() and fga_is_admin()) with check (workspace_id = fga_ws() and fga_is_admin());
create policy tasks_manager_insert on tasks for insert to fga_app
  with check (workspace_id = fga_ws() and fga_role() = 'campaign_manager'
              and (initiative_id is null or fga_manages_initiative(initiative_id)));
create policy tasks_manager_update on tasks for update to fga_app
  using (workspace_id = fga_ws() and fga_role() = 'campaign_manager'
         and (fga_manages_initiative(initiative_id) or owner_user_id = fga_uid() or created_by = fga_uid()))
  with check (workspace_id = fga_ws() and fga_role() = 'campaign_manager');
create policy tasks_member_update on tasks for update to fga_app
  using (workspace_id = fga_ws() and fga_role() = 'team_member' and owner_user_id = fga_uid())
  with check (workspace_id = fga_ws() and fga_role() = 'team_member' and owner_user_id = fga_uid());

create policy task_deps_write on task_dependencies for all to fga_app
  using (workspace_id = fga_ws() and fga_role() in ('admin', 'campaign_manager'))
  with check (workspace_id = fga_ws() and fga_role() in ('admin', 'campaign_manager'));

create policy task_comments_insert on task_comments for insert to fga_app
  with check (workspace_id = fga_ws() and user_id = fga_uid());

-- Budget lines: admins only. Managers request changes through approvals.
create policy budget_admin on budget_lines for all to fga_app
  using (workspace_id = fga_ws() and fga_is_admin()) with check (workspace_id = fga_ws() and fga_is_admin());

-- Experiments: admins and managers in scope.
create policy experiments_write on experiments for all to fga_app
  using (workspace_id = fga_ws() and (fga_is_admin() or (fga_role() = 'campaign_manager' and (initiative_id is null or fga_manages_initiative(initiative_id)))))
  with check (workspace_id = fga_ws() and (fga_is_admin() or (fga_role() = 'campaign_manager' and (initiative_id is null or fga_manages_initiative(initiative_id)))));

-- AI threads/messages: users see and write only their own threads.
drop policy ai_threads_read on ai_threads;
create policy ai_threads_own on ai_threads for all to fga_app
  using (workspace_id = fga_ws() and user_id = fga_uid()) with check (workspace_id = fga_ws() and user_id = fga_uid());
drop policy ai_messages_read on ai_messages;
create policy ai_messages_own on ai_messages for all to fga_app
  using (workspace_id = fga_ws() and exists (select 1 from ai_threads t where t.id = thread_id and t.user_id = fga_uid()))
  with check (workspace_id = fga_ws() and exists (select 1 from ai_threads t where t.id = thread_id and t.user_id = fga_uid()));

-- Approvals: anyone can propose; deciding is checked in the service layer and limited here
-- to admins and managers. Nobody can edit a decided approval.
create policy approvals_insert on approvals for insert to fga_app
  with check (workspace_id = fga_ws() and status = 'pending');
create policy approvals_decide on approvals for update to fga_app
  using (workspace_id = fga_ws() and status = 'pending' and fga_role() in ('admin', 'campaign_manager'))
  with check (workspace_id = fga_ws() and fga_role() in ('admin', 'campaign_manager'));

-- Audit log: insert-only for everyone (the trigger blocks update/delete for all roles).
create policy audit_insert on audit_logs for insert to fga_app
  with check (workspace_id = fga_ws());
