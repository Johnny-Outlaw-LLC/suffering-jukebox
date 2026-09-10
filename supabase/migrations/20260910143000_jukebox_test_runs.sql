-- Historical test runs, for the admin Test Coverage calendar.
--
-- The report itself (test-results.json) is regenerated on every build, so it
-- only ever describes the run that shipped the current commit. One row here per
-- run is what makes a history possible. Deliberately NOT the whole report: the
-- calendar needs totals, the per-area split and what actually failed, and
-- keeping every test name for every run would grow without bound.
--
-- Same shape as jukebox.perf_events: RLS on, no anon or authenticated grants at
-- all, written and read only through the service role. A policy without a grant
-- verifies nothing, so both are stated.
create table if not exists jukebox.test_runs (
  id          uuid primary key default gen_random_uuid(),
  ran_at      timestamptz not null default now(),
  -- The commit the run describes. On a build this is the deployed commit; run
  -- locally it is HEAD, which may have uncommitted work on top of it.
  commit_sha  text,
  branch      text,
  subject     text,
  node        text,
  -- 'build' is a deploy regenerating it, 'local' is somebody running npm test.
  source      text not null default 'local',
  dirty       boolean not null default false,
  wall_ms     integer,
  suites      integer not null default 0,
  tests       integer not null default 0,
  passed      integer not null default 0,
  failed      integer not null default 0,
  areas       jsonb not null default '[]'::jsonb,
  -- [{ suite, name, error }] - only the failures, so a red day can be read
  -- without keeping every passing test name forever.
  failures    jsonb not null default '[]'::jsonb
);

create index if not exists test_runs_ran_at_idx on jukebox.test_runs (ran_at desc);

alter table jukebox.test_runs enable row level security;

revoke all on jukebox.test_runs from anon, authenticated;
grant select, insert, delete on jukebox.test_runs to service_role;

drop policy if exists test_runs_service_role on jukebox.test_runs;
create policy test_runs_service_role on jukebox.test_runs
  for all to service_role using (true) with check (true);
