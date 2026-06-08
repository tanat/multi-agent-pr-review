-- Durable state for the multi-agent review: one `runs` row per PR review, many
-- `findings` rows. The orchestration is a state machine persisted here, so a run
-- can pause at `awaiting_approval` (human-in-the-loop, possibly for hours) and
-- resume from its checkpoint even after the process restarts.

set search_path = public;

create table if not exists runs (
  id         uuid primary key default gen_random_uuid(),
  pr_url     text not null,
  owner      text not null,
  repo       text not null,
  number     integer not null,
  title      text,
  status     text not null default 'reviewing'
             check (status in ('reviewing','awaiting_approval','publishing','done','failed')),
  model      text not null,
  error      text,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_runs_status on runs(status);
create index if not exists idx_runs_pr on runs(owner, repo, number);

create table if not exists findings (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid not null references runs(id) on delete cascade,
  specialist text not null check (specialist in ('security','correctness','tests','style')),
  file       text not null,
  line       integer,
  severity   text not null check (severity in ('critical','high','medium','low')),
  title      text not null,
  rationale  text not null,
  suggestion text,
  dedup_key  text not null,
  decision   text not null default 'pending'
             check (decision in ('pending','approved','rejected')),
  published  boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_findings_run on findings(run_id);
-- Cross-specialist dedup + idempotent re-runs: inserting the same logical finding
-- twice is a no-op (the orchestrator uses ON CONFLICT DO NOTHING on this key).
create unique index if not exists uq_findings_run_dedup on findings(run_id, dedup_key);

create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end;
$$;

drop trigger if exists runs_set_updated_at on runs;
create trigger runs_set_updated_at before update on runs
  for each row execute function public.set_updated_at();

-- All access is server-side over the direct DATABASE_URL (superuser, bypasses
-- RLS). Enable RLS with no policies so neither table is exposed through the
-- auto-generated anon PostgREST API.
alter table runs     enable row level security;
alter table findings enable row level security;
