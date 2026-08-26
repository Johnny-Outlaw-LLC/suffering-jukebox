-- Private Spotify export history. This is intentionally separate from
-- play_events: a user's history may include music we do not have in the
-- Jukebox, podcasts, audiobooks, and other Spotify activity.
create table if not exists jukebox.spotify_history_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_fingerprint text not null,
  content_type text not null check (content_type in ('music', 'podcast', 'audiobook', 'other')),
  spotify_uri text,
  title text not null,
  artist text not null,
  album text,
  played_at timestamptz not null,
  duration_played_ms bigint not null default 0 check (duration_played_ms >= 0),
  skipped boolean not null default false,
  source_file_name text not null,
  created_at timestamptz not null default now(),
  unique (user_id, event_fingerprint)
);

create index if not exists spotify_history_events_user_played_at_idx
  on jukebox.spotify_history_events (user_id, played_at desc);
create index if not exists spotify_history_events_user_type_idx
  on jukebox.spotify_history_events (user_id, content_type);

-- The table is written/read only through authenticated server routes. Keep it
-- out of direct client access even if the custom schema is later Data-API exposed.
alter table jukebox.spotify_history_events enable row level security;
revoke all on table jukebox.spotify_history_events from anon, authenticated;
grant all on table jukebox.spotify_history_events to service_role;

create or replace function jukebox.spotify_history_summary(p_user_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, jukebox
as $$
  with mine as (
    select *
    from jukebox.spotify_history_events
    where user_id = p_user_id
  ), totals as (
    select
      count(*)::bigint as events,
      coalesce(sum(duration_played_ms), 0)::bigint as duration_ms,
      min(played_at) as first_played_at,
      max(played_at) as last_played_at
    from mine
  ), by_type as (
    select content_type, count(*)::bigint as events
    from mine
    group by content_type
  ), by_year as (
    select extract(year from played_at)::int as year, count(*)::bigint as events
    from mine
    group by 1
    order by 1 desc
  ), top_artists as (
    select artist, count(*)::bigint as events
    from mine
    where content_type = 'music'
    group by artist
    order by events desc, artist asc
    limit 12
  )
  select jsonb_build_object(
    'events', totals.events,
    'durationMs', totals.duration_ms,
    'firstPlayedAt', totals.first_played_at,
    'lastPlayedAt', totals.last_played_at,
    'byType', coalesce((select jsonb_object_agg(content_type, events) from by_type), '{}'::jsonb),
    'byYear', coalesce((select jsonb_agg(jsonb_build_object('year', year, 'events', events)) from by_year), '[]'::jsonb),
    'topArtists', coalesce((select jsonb_agg(jsonb_build_object('artist', artist, 'events', events)) from top_artists), '[]'::jsonb)
  )
  from totals;
$$;

revoke all on function jukebox.spotify_history_summary(uuid) from public, anon, authenticated;
grant execute on function jukebox.spotify_history_summary(uuid) to service_role;
