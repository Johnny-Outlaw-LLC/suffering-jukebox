-- Google Takeout YouTube watch-history supplements the private listening
-- archive. It remains provenance-separated from Spotify and retains the
-- evidence used by the browser-side music-candidate review.
alter table jukebox.spotify_history_events
  add column if not exists history_source text not null default 'spotify',
  add column if not exists youtube_video_id text,
  add column if not exists youtube_url text,
  add column if not exists youtube_channel text,
  add column if not exists classification_confidence text,
  add column if not exists classification_reason text;

alter table jukebox.spotify_history_events
  drop constraint if exists spotify_history_events_history_source_check,
  add constraint spotify_history_events_history_source_check check (history_source in ('spotify', 'youtube')),
  drop constraint if exists spotify_history_events_classification_confidence_check,
  add constraint spotify_history_events_classification_confidence_check check (classification_confidence is null or classification_confidence in ('high', 'likely', 'uncertain'));

create index if not exists spotify_history_events_user_source_played_at_idx
  on jukebox.spotify_history_events (user_id, history_source, played_at desc)
  where deleted = false;

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
    select nullif(trim(x.event_fingerprint), '') as event_fingerprint,
      nullif(trim(x.content_type), '') as content_type,
      coalesce(nullif(lower(trim(x.history_source)), ''), 'spotify') as history_source,
      nullif(trim(x.spotify_uri), '') as spotify_uri,
      nullif(trim(x.youtube_video_id), '') as youtube_video_id,
      nullif(trim(x.youtube_url), '') as youtube_url,
      nullif(trim(x.youtube_channel), '') as youtube_channel,
      nullif(lower(trim(x.classification_confidence)), '') as classification_confidence,
      nullif(trim(x.classification_reason), '') as classification_reason,
      nullif(trim(x.title), '') as title, nullif(trim(x.artist), '') as artist,
      nullif(trim(x.album), '') as album, x.played_at,
      greatest(coalesce(x.duration_played_ms, 0), 0)::bigint as duration_played_ms,
      coalesce(x.skipped, false) as skipped,
      coalesce(nullif(trim(x.source_file_name), ''), 'Listening history export') as source_file_name
    from jsonb_to_recordset(p_events) as x(
      event_fingerprint text, content_type text, history_source text,
      spotify_uri text, youtube_video_id text, youtube_url text, youtube_channel text,
      classification_confidence text, classification_reason text,
      title text, artist text, album text, played_at timestamptz,
      duration_played_ms bigint, skipped boolean, source_file_name text)
  ), cleaned as (
    select distinct on (event_fingerprint) * from raw
    where event_fingerprint is not null
      and content_type in ('music', 'podcast', 'audiobook', 'other')
      and history_source in ('spotify', 'youtube')
      and (classification_confidence is null or classification_confidence in ('high', 'likely', 'uncertain'))
      and title is not null and artist is not null and played_at is not null
      and (history_source <> 'youtube' or youtube_video_id is not null)
    order by event_fingerprint
  ), counted as (select count(*)::int as n from cleaned), inserted as (
    insert into jukebox.spotify_history_events (
      user_id, event_fingerprint, content_type, history_source, spotify_uri,
      youtube_video_id, youtube_url, youtube_channel, classification_confidence, classification_reason,
      title, artist, album, played_at, duration_played_ms, skipped, source_file_name)
    select p_user_id, event_fingerprint, content_type, history_source, spotify_uri,
      youtube_video_id, youtube_url, youtube_channel, classification_confidence, classification_reason,
      title, artist, album, played_at, duration_played_ms, skipped, source_file_name from cleaned
    on conflict (user_id, event_fingerprint) do update set deleted = false, deleted_at = null
      where jukebox.spotify_history_events.deleted = true
    returning 1
  )
  select (select n from counted), (select count(*)::int from inserted) into v_incoming, v_inserted;
  return jsonb_build_object('incoming', coalesce(v_incoming, 0), 'inserted', coalesce(v_inserted, 0), 'skipped', greatest(coalesce(v_incoming, 0) - coalesce(v_inserted, 0), 0));
end;
$function$;

revoke all on function jukebox.import_spotify_history_events(uuid, jsonb) from public, anon, authenticated;
grant execute on function jukebox.import_spotify_history_events(uuid, jsonb) to service_role;

-- Do not silently label YouTube watches as Spotify in the existing duration
-- dashboard. YouTube Takeout has no playback duration, so it will get its own
-- event-focused view rather than manufacturing hours.
do $block$
declare v_definition text;
begin
  select pg_get_functiondef(p.oid) into v_definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'jukebox' and p.proname = 'listening_analytics'
  order by p.oid desc limit 1;
  if v_definition is null then raise exception 'listening_analytics is missing'; end if;
  v_definition := replace(v_definition,
    'where e.user_id = p_user_id',
    'where e.user_id = p_user_id' || chr(10) || '      and coalesce(e.history_source, ''spotify'') = ''spotify''');
  execute v_definition;
end;
$block$;
