-- Client performance telemetry for Suffering Jukebox.
-- Written ONLY by the service role via /api/sj-perf. RLS is on and there are no
-- anon or authenticated grants at all, matching the jukebox_* room tables: the
-- browser never touches PostgREST for this.
--
-- Rows carry timings, counts and heap sizes. Never song names, account details
-- or request credentials -- see sjPerf() in public/index.html.

create table if not exists jukebox.perf_events (
  id             bigserial primary key,
  created_at     timestamptz not null default now(),
  -- Random per-tab id from the client. Not derived from identity; it exists so
  -- the entries around one freeze can be read back in order.
  session_id     text        not null,
  user_id        uuid,
  email          text,
  event          text        not null,
  -- Milliseconds since page load, from performance.now().
  page_ms        integer,
  duration_ms    numeric(12,1),
  heap_used_mb   integer,
  heap_total_mb  integer,
  detail         jsonb       not null default '{}'::jsonb,
  user_agent     text,
  viewport       jsonb,
  path           text
);

create index if not exists perf_events_created_idx  on jukebox.perf_events (created_at desc);
create index if not exists perf_events_event_idx    on jukebox.perf_events (event, created_at desc);
create index if not exists perf_events_session_idx  on jukebox.perf_events (session_id, created_at);

alter table jukebox.perf_events enable row level security;

drop policy if exists perf_events_service on jukebox.perf_events;
create policy perf_events_service on jukebox.perf_events
  for all to service_role using (true) with check (true);

revoke all on jukebox.perf_events from anon, authenticated;
revoke all on sequence jukebox.perf_events_id_seq from anon, authenticated;
