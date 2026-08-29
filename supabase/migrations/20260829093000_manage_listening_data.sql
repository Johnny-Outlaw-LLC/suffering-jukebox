-- Users can archive listening-history batches from My Data.  Archived rows are
-- excluded immediately, retain their original row for 30 days, and are then
-- purged by a small daily database job.
alter table jukebox.spotify_history_events
  add column if not exists deleted boolean not null default false,
  add column if not exists deleted_at timestamptz;

alter table jukebox.play_events
  add column if not exists deleted boolean not null default false,
  add column if not exists deleted_at timestamptz;

create index if not exists spotify_history_events_active_user_played_at_idx
  on jukebox.spotify_history_events (user_id, played_at desc)
  where deleted = false;

create index if not exists play_events_active_user_played_at_idx
  on jukebox.play_events (lower(user_email), played_at desc)
  where deleted = false and event_type = 'play' and source is distinct from 'spotify';

create or replace function jukebox.listening_data_batches(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = jukebox, auth, pg_catalog
as $$
  with mine as (
    select lower(nullif(trim(email), '')) as email
    from auth.users where id = p_user_id
  ), batches as (
    select
      'spotify'::text as source,
      extract(year from e.played_at at time zone 'America/Chicago')::int as year,
      count(*) filter (where e.deleted = false)::bigint as active_records,
      count(*) filter (where e.deleted = true)::bigint as pending_deletion_records
    from jukebox.spotify_history_events e
    where e.user_id = p_user_id
    group by 1, 2

    union all

    select
      'jukebox'::text as source,
      extract(year from pe.played_at at time zone 'America/Chicago')::int as year,
      count(*) filter (where pe.deleted = false)::bigint as active_records,
      count(*) filter (where pe.deleted = true)::bigint as pending_deletion_records
    from jukebox.play_events pe
    join mine on mine.email is not null and lower(pe.user_email) = mine.email
    where pe.event_type = 'play' and pe.source is distinct from 'spotify'
    group by 1, 2
  )
  select jsonb_build_object(
    'batches', coalesce((
      select jsonb_agg(jsonb_build_object(
        'source', source,
        'year', year,
        'activeRecords', active_records,
        'pendingDeletionRecords', pending_deletion_records
      ) order by year desc, source)
      from batches
    ), '[]'::jsonb)
  );
$$;

create or replace function jukebox.set_listening_data_archive(
  p_user_id uuid,
  p_batches jsonb,
  p_archive boolean
)
returns jsonb
language plpgsql
security definer
set search_path = jukebox, auth, pg_catalog
as $function$
declare
  v_email text;
  v_spotify_years int[];
  v_jukebox_years int[];
  v_spotify_count bigint := 0;
  v_jukebox_count bigint := 0;
begin
  if p_user_id is null then raise exception 'user required'; end if;
  if jsonb_typeof(p_batches) <> 'array' or jsonb_array_length(p_batches) = 0 then
    raise exception 'at least one data batch is required';
  end if;
  if jsonb_array_length(p_batches) > 100 then raise exception 'too many data batches'; end if;

  select lower(nullif(trim(email), '')) into v_email from auth.users where id = p_user_id;

  with parsed as (
    select distinct
      lower(nullif(trim(value ->> 'source'), '')) as source,
      (value ->> 'year')::int as year
    from jsonb_array_elements(p_batches)
    where lower(coalesce(value ->> 'source', '')) in ('spotify', 'jukebox')
      and coalesce(value ->> 'year', '') ~ '^[0-9]{4}$'
  )
  select
    array_agg(year) filter (where source = 'spotify'),
    array_agg(year) filter (where source = 'jukebox')
  into v_spotify_years, v_jukebox_years
  from parsed;

  if coalesce(array_length(v_spotify_years, 1), 0) = 0
     and coalesce(array_length(v_jukebox_years, 1), 0) = 0 then
    raise exception 'valid source and year batches are required';
  end if;

  if coalesce(array_length(v_spotify_years, 1), 0) > 0 then
    update jukebox.spotify_history_events
    set deleted = p_archive,
        deleted_at = case when p_archive then now() else null end
    where user_id = p_user_id
      and extract(year from played_at at time zone 'America/Chicago')::int = any(v_spotify_years)
      and deleted is distinct from p_archive;
    get diagnostics v_spotify_count = row_count;
  end if;

  if coalesce(array_length(v_jukebox_years, 1), 0) > 0 and v_email is not null then
    update jukebox.play_events
    set deleted = p_archive,
        deleted_at = case when p_archive then now() else null end
    where lower(user_email) = v_email
      and event_type = 'play'
      and source is distinct from 'spotify'
      and extract(year from played_at at time zone 'America/Chicago')::int = any(v_jukebox_years)
      and deleted is distinct from p_archive;
    get diagnostics v_jukebox_count = row_count;
  end if;

  return jsonb_build_object(
    'spotifyRecords', v_spotify_count,
    'jukeboxRecords', v_jukebox_count,
    'records', v_spotify_count + v_jukebox_count,
    'archived', p_archive
  );
end;
$function$;

-- A deleted Spotify row can be deliberately re-imported before the retention
-- period ends; restore it rather than treating its fingerprint as a duplicate.
create or replace function jukebox.import_spotify_history_events(p_user_id uuid, p_events jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'jukebox', 'pg_catalog'
as $function$
declare v_incoming int := 0; v_inserted int := 0;
begin
  if p_user_id is null then raise exception 'user required'; end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then raise exception 'events array required'; end if;
  if jsonb_array_length(p_events) > 1000 then raise exception 'at most 1000 events per call'; end if;
  with raw as (
    select nullif(trim(x.event_fingerprint), '') as event_fingerprint, nullif(trim(x.content_type), '') as content_type,
      nullif(trim(x.spotify_uri), '') as spotify_uri, nullif(trim(x.title), '') as title, nullif(trim(x.artist), '') as artist,
      nullif(trim(x.album), '') as album, x.played_at, greatest(coalesce(x.duration_played_ms, 0), 0)::bigint as duration_played_ms,
      coalesce(x.skipped, false) as skipped, coalesce(nullif(trim(x.source_file_name), ''), 'Spotify export') as source_file_name
    from jsonb_to_recordset(p_events) as x(event_fingerprint text, content_type text, spotify_uri text, title text, artist text, album text, played_at timestamptz, duration_played_ms bigint, skipped boolean, source_file_name text)
  ), cleaned as (
    select distinct on (event_fingerprint) * from raw
    where event_fingerprint is not null and content_type in ('music', 'podcast', 'audiobook', 'other') and title is not null and artist is not null and played_at is not null
    order by event_fingerprint
  ), counted as (select count(*)::int as n from cleaned), inserted as (
    insert into jukebox.spotify_history_events (user_id, event_fingerprint, content_type, spotify_uri, title, artist, album, played_at, duration_played_ms, skipped, source_file_name)
    select p_user_id, event_fingerprint, content_type, spotify_uri, title, artist, album, played_at, duration_played_ms, skipped, source_file_name from cleaned
    on conflict (user_id, event_fingerprint) do update set deleted = false, deleted_at = null where jukebox.spotify_history_events.deleted = true
    returning 1
  )
  select (select n from counted), (select count(*)::int from inserted) into v_incoming, v_inserted;
  return jsonb_build_object('incoming', coalesce(v_incoming, 0), 'inserted', coalesce(v_inserted, 0), 'skipped', greatest(coalesce(v_incoming, 0) - coalesce(v_inserted, 0), 0));
end;
$function$;

create or replace function jukebox.purge_archived_listening_data()
returns jsonb
language plpgsql
security definer
set search_path = jukebox, pg_catalog
as $function$
declare v_spotify bigint; v_jukebox bigint;
begin
  delete from jukebox.spotify_history_events where deleted = true and deleted_at <= now() - interval '30 days';
  get diagnostics v_spotify = row_count;
  delete from jukebox.play_events where deleted = true and deleted_at <= now() - interval '30 days';
  get diagnostics v_jukebox = row_count;
  return jsonb_build_object('spotifyRecords', v_spotify, 'jukeboxRecords', v_jukebox, 'records', v_spotify + v_jukebox);
end;
$function$;

-- The cron job is idempotent across re-applied migrations and runs after the
-- 30-day grace period, not at archive time.
select cron.unschedule(jobid) from cron.job where jobname = 'purge-archived-listening-data';
select cron.schedule('purge-archived-listening-data', '17 3 * * *', $$select jukebox.purge_archived_listening_data();$$);

-- Archived events must disappear from both the full analytics dashboard and
-- its lightweight Spotify import summary immediately.
create or replace function jukebox.spotify_history_summary(p_user_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, jukebox
as $$
  with mine as (
    select * from jukebox.spotify_history_events where user_id = p_user_id and deleted = false
  ), totals as (
    select count(*)::bigint as events, coalesce(sum(duration_played_ms), 0)::bigint as duration_ms,
      min(played_at) as first_played_at, max(played_at) as last_played_at from mine
  ), by_type as (select content_type, count(*)::bigint as events from mine group by content_type),
  by_year as (select extract(year from played_at)::int as year, count(*)::bigint as events from mine group by 1 order by 1 desc),
  top_artists as (select artist, count(*)::bigint as events from mine where content_type = 'music' group by artist order by events desc, artist asc limit 12)
  select jsonb_build_object('events', totals.events, 'durationMs', totals.duration_ms, 'firstPlayedAt', totals.first_played_at, 'lastPlayedAt', totals.last_played_at,
    'byType', coalesce((select jsonb_object_agg(content_type, events) from by_type), '{}'::jsonb),
    'byYear', coalesce((select jsonb_agg(jsonb_build_object('year', year, 'events', events)) from by_year), '[]'::jsonb),
    'topArtists', coalesce((select jsonb_agg(jsonb_build_object('artist', artist, 'events', events)) from top_artists), '[]'::jsonb)) from totals;
$$;

-- Keep the deployed analytics function in sync without changing its public
-- signature or duplicating its large aggregation body in this retention-only
-- migration.
do $block$
declare v_definition text;
begin
  select pg_get_functiondef(p.oid) into v_definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'jukebox' and p.proname = 'listening_analytics'
  order by p.oid desc limit 1;
  if v_definition is null then raise exception 'listening_analytics is missing'; end if;
  v_definition := replace(
    v_definition,
    'where e.user_id = p_user_id',
    'where e.user_id = p_user_id' || chr(10) || '      and e.deleted = false'
  );
  v_definition := replace(
    v_definition,
    'and pe.source is distinct from ''spotify''',
    'and pe.source is distinct from ''spotify''' || chr(10) || '      and pe.deleted = false'
  );
  execute v_definition;
end;
$block$;

revoke all on function jukebox.listening_data_batches(uuid) from public, anon, authenticated;
grant execute on function jukebox.listening_data_batches(uuid) to service_role;
revoke all on function jukebox.set_listening_data_archive(uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function jukebox.set_listening_data_archive(uuid, jsonb, boolean) to service_role;
revoke all on function jukebox.purge_archived_listening_data() from public, anon, authenticated;
grant execute on function jukebox.purge_archived_listening_data() to service_role;
revoke all on function jukebox.import_spotify_history_events(uuid, jsonb) from public;
grant execute on function jukebox.import_spotify_history_events(uuid, jsonb) to service_role;
revoke all on function jukebox.spotify_history_summary(uuid) from public, anon, authenticated;
grant execute on function jukebox.spotify_history_summary(uuid) to service_role;
