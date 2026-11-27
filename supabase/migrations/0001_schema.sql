-- Fest Growth Analytics: core schema
-- Every workspace-owned row carries workspace_id; every imported fact also carries
-- dataset_version_id so datasets stay isolated and switchable.

-- gen_random_uuid() is built into Postgres 13+, no extension needed.

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active_dataset_version_id uuid,
  data_version bigint not null default 0,
  created_at timestamptz not null default now()
);

create table team_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  title text,
  source_owner_id text,
  created_at timestamptz not null default now(),
  unique (workspace_id, source_owner_id)
);

create table app_users (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email text not null unique,
  display_name text not null,
  role text not null check (role in ('admin', 'campaign_manager', 'team_member')),
  password_hash text not null,
  team_member_id uuid references team_members(id) on delete set null,
  is_demo boolean not null default true,
  created_at timestamptz not null default now()
);

-- Dataset versions -------------------------------------------------------------
create table dataset_uploads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  filename text not null,
  bytes bytea not null,
  sha256 text not null,
  uploaded_by uuid references app_users(id) on delete set null,
  uploaded_at timestamptz not null default now()
);

create table dataset_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  upload_id uuid references dataset_uploads(id) on delete set null,
  label text not null,
  source_filename text not null,
  uploaded_by uuid references app_users(id) on delete set null,
  uploaded_at timestamptz not null default now(),
  status text not null default 'processing' check (status in ('processing', 'ready', 'failed')),
  is_demo boolean not null default false,
  mapping jsonb not null default '{}'::jsonb,
  mapping_version int not null default 1,
  row_counts jsonb not null default '{}'::jsonb,
  quality jsonb not null default '{}'::jsonb,
  notes text
);
alter table workspaces add constraint workspaces_active_dv_fk
  foreign key (active_dataset_version_id) references dataset_versions(id) on delete set null;

create table raw_source_rows (
  id bigserial primary key,
  workspace_id uuid not null,
  dataset_version_id uuid not null references dataset_versions(id) on delete cascade,
  sheet text not null,
  row_number int not null,
  data jsonb not null
);
create index raw_rows_dv on raw_source_rows(dataset_version_id, sheet);

create table import_errors (
  id bigserial primary key,
  workspace_id uuid not null,
  dataset_version_id uuid not null references dataset_versions(id) on delete cascade,
  sheet text not null,
  row_number int,
  reason text not null,
  data jsonb
);

create table event_info (
  dataset_version_id uuid primary key references dataset_versions(id) on delete cascade,
  workspace_id uuid not null,
  name text,
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text,
  currency text,
  history_start date,
  history_end date
);

create table target_versions (
  id bigserial primary key,
  workspace_id uuid not null,
  dataset_version_id uuid not null references dataset_versions(id) on delete cascade,
  effective_at timestamptz not null,
  label text,
  identified_goal int,
  registration_goal int,
  visitor_goal int,
  budget_inr bigint
);

-- Strategy (planning, not observed) --------------------------------------------
create table initiatives (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  key text not null,
  name text not null,
  mechanism text,
  decision text not null check (decision in ('double_down', 'maintain', 'staged_pilot', 'deprioritize')),
  status text not null default 'not_started' check (status in ('not_started', 'pilot', 'scale', 'change', 'stop')),
  base_target int not null default 0,
  stretch_target int not null default 0,
  base_budget_inr bigint not null default 0,
  stretch_budget_inr bigint not null default 0,
  owner_user_id uuid references app_users(id) on delete set null,
  threshold jsonb not null default '{}'::jsonb,
  notes text,
  updated_at timestamptz not null default now(),
  unique (workspace_id, key)
);

create table initiative_assignments (
  initiative_id uuid not null references initiatives(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  workspace_id uuid not null,
  primary key (initiative_id, user_id)
);

create table strategy_configs (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  version int not null,
  config jsonb not null,
  change_note text,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, version)
);

-- Imported facts ---------------------------------------------------------------
create table campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  dataset_version_id uuid not null references dataset_versions(id) on delete cascade,
  source_id text not null,
  name text not null,
  channel text,
  target_audience text,
  objective text,
  owner_team_member_id uuid references team_members(id) on delete set null,
  status text not null default 'active' check (status in ('planned', 'active', 'paused', 'completed', 'cancelled')),
  initiative_id uuid references initiatives(id) on delete set null,
  planned_start timestamptz,
  planned_end timestamptz,
  budget_approved_inr bigint,
  budget_committed_inr bigint,
  utm_code text,
  kpi_registrations int,
  kpi_attendees int,
  notes text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (dataset_version_id, source_id)
);

create table campaign_daily (
  id bigserial primary key,
  workspace_id uuid not null,
  dataset_version_id uuid not null references dataset_versions(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  source_id text,
  activity_date date not null,
  impressions bigint,
  clicks bigint,
  reported_reach bigint,
  sessions bigint,
  registration_starts bigint,
  spend_inr bigint,
  platform text,
  unique (dataset_version_id, source_id)
);
create index campaign_daily_dv on campaign_daily(dataset_version_id, campaign_id, activity_date);

create table people (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  dataset_version_id uuid not null references dataset_versions(id) on delete cascade,
  source_id text not null,
  display_name text,
  person_type text,
  first_seen_at timestamptz,
  first_touch_source text,
  first_campaign_id uuid references campaigns(id) on delete set null,
  owner_team_member_id uuid references team_members(id) on delete set null,
  extra jsonb not null default '{}'::jsonb,
  unique (dataset_version_id, source_id)
);
create index people_dv on people(dataset_version_id, person_type);

create table interactions (
  id bigserial primary key,
  workspace_id uuid not null,
  dataset_version_id uuid not null references dataset_versions(id) on delete cascade,
  source_id text not null,
  person_id uuid not null references people(id) on delete cascade,
  campaign_id uuid references campaigns(id) on delete set null,
  occurred_at timestamptz not null,
  event_type text not null,
  unique (dataset_version_id, source_id)
);
create index interactions_dv on interactions(dataset_version_id, person_id);

create table registrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  dataset_version_id uuid not null references dataset_versions(id) on delete cascade,
  source_id text not null,
  person_id uuid not null references people(id) on delete cascade,
  campaign_id uuid references campaigns(id) on delete set null,
  registered_at timestamptz not null,
  unique (dataset_version_id, source_id)
);
create index registrations_dv on registrations(dataset_version_id, person_id);

create table registration_status_history (
  id bigserial primary key,
  workspace_id uuid not null,
  dataset_version_id uuid not null references dataset_versions(id) on delete cascade,
  source_id text not null,
  registration_id uuid not null references registrations(id) on delete cascade,
  status text not null,
  effective_at timestamptz not null,
  edited_by uuid references app_users(id) on delete set null,
  unique (dataset_version_id, source_id)
);
create index rsh_dv on registration_status_history(dataset_version_id, registration_id, effective_at desc);

create table check_ins (
  id bigserial primary key,
  workspace_id uuid not null,
  dataset_version_id uuid not null references dataset_versions(id) on delete cascade,
  source_id text not null,
  person_id uuid not null references people(id) on delete cascade,
  registration_id uuid references registrations(id) on delete set null,
  campaign_id uuid references campaigns(id) on delete set null,
  occurred_at timestamptz not null,
  result text,
  verification text,
  method text,
  unique (dataset_version_id, source_id)
);
create index check_ins_dv on check_ins(dataset_version_id, person_id);

-- Execution ---------------------------------------------------------------------
create table tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null,
  description text,
  initiative_id uuid references initiatives(id) on delete set null,
  campaign_id uuid references campaigns(id) on delete set null,
  owner_user_id uuid references app_users(id) on delete set null,
  reviewer_user_id uuid references app_users(id) on delete set null,
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'critical')),
  status text not null default 'todo' check (status in ('backlog', 'todo', 'in_progress', 'blocked', 'review', 'done', 'cancelled')),
  progress int not null default 0 check (progress between 0 and 100),
  start_date date,
  due_date date,
  effort_hours numeric,
  origin text not null default 'user' check (origin in ('user', 'ai', 'seed')),
  created_by uuid references app_users(id) on delete set null,
  approval_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_ws on tasks(workspace_id, status, due_date);

create table task_dependencies (
  task_id uuid not null references tasks(id) on delete cascade,
  depends_on_id uuid not null references tasks(id) on delete cascade,
  workspace_id uuid not null,
  primary key (task_id, depends_on_id),
  check (task_id <> depends_on_id)
);

create table task_comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid references app_users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

create table budget_lines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  scenario text not null check (scenario in ('base', 'stretch')),
  initiative_id uuid references initiatives(id) on delete set null,
  category text not null,
  label text not null,
  approved_inr bigint not null default 0,
  committed_inr bigint not null default 0,
  spent_inr bigint not null default 0,
  funding_source text not null default 'festival' check (funding_source in ('festival', 'sponsor')),
  notes text,
  updated_at timestamptz not null default now()
);

create table experiments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  initiative_id uuid references initiatives(id) on delete set null,
  name text not null,
  hypothesis text,
  segment text,
  treatment text,
  control text,
  start_date date,
  end_date date,
  owner_user_id uuid references app_users(id) on delete set null,
  primary_metric text,
  guardrail_metric text,
  decision_rule text,
  treatment_n int,
  control_n int,
  treatment_conversions int,
  control_conversions int,
  status text not null default 'planned' check (status in ('planned', 'running', 'completed', 'stopped')),
  decision text check (decision in ('scale', 'change', 'stop')),
  caveats text,
  updated_at timestamptz not null default now()
);

-- AI and governance -------------------------------------------------------------
create table ai_threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now()
);

create table ai_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  thread_id uuid not null references ai_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content jsonb not null,
  trace jsonb,
  created_at timestamptz not null default now()
);

create table approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('create_task', 'update_task', 'update_campaign', 'budget_change')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  payload jsonb not null,
  before jsonb,
  rationale text,
  evidence jsonb,
  proposed_by_kind text not null check (proposed_by_kind in ('ai', 'user')),
  requested_by uuid references app_users(id) on delete set null,
  thread_id uuid references ai_threads(id) on delete set null,
  decided_by uuid references app_users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  result_entity_id uuid,
  created_at timestamptz not null default now()
);

create table audit_logs (
  id bigserial primary key,
  workspace_id uuid not null,
  actor_user_id uuid,
  actor_kind text not null default 'user' check (actor_kind in ('user', 'ai', 'system')),
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index audit_ws on audit_logs(workspace_id, created_at desc);

-- Audit rows can never be changed or removed.
create or replace function fga_audit_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_logs is append-only';
end $$;
create trigger audit_no_update before update or delete on audit_logs
  for each row execute function fga_audit_immutable();
