-- Idempotent bulk import for Spotify Extended Streaming History.
-- Distinct fingerprints in the payload, then ON CONFLICT DO NOTHING so a
-- partial re-run only fills gaps and never doubles existing listens.
create or replace function jukebox.import_spotify_history_events(
  p_user_id uuid,
  p_events jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'jukebox', 'pg_catalog'
as $function$
declare
  v_incoming int := 0;
  v_inserted int := 0;
begin
  if p_user_id is null then
    raise exception 'user required';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'events array required';
  end if;
  if jsonb_array_length(p_events) > 1000 then
    raise exception 'at most 1000 events per call';
  end if;

  with raw as (
    select
      nullif(trim(x.event_fingerprint), '') as event_fingerprint,
      nullif(trim(x.content_type), '') as content_type,
      nullif(trim(x.spotify_uri), '') as spotify_uri,
      nullif(trim(x.title), '') as title,
      nullif(trim(x.artist), '') as artist,
      nullif(trim(x.album), '') as album,
      x.played_at,
      greatest(coalesce(x.duration_played_ms, 0), 0)::bigint as duration_played_ms,
      coalesce(x.skipped, false) as skipped,
      coalesce(nullif(trim(x.source_file_name), ''), 'Spotify export') as source_file_name
    from jsonb_to_recordset(p_events) as x(
      event_fingerprint text,
      content_type text,
      spotify_uri text,
      title text,
      artist text,
      album text,
      played_at timestamptz,
      duration_played_ms bigint,
      skipped boolean,
      source_file_name text
    )
  ),
  cleaned as (
    select distinct on (event_fingerprint)
      event_fingerprint, content_type, spotify_uri, title, artist, album,
      played_at, duration_played_ms, skipped, source_file_name
    from raw
    where event_fingerprint is not null
      and content_type in ('music', 'podcast', 'audiobook', 'other')
      and title is not null
      and artist is not null
      and played_at is not null
    order by event_fingerprint
  ),
  counted as (
    select count(*)::int as n from cleaned
  ),
  inserted as (
    insert into jukebox.spotify_history_events (
      user_id, event_fingerprint, content_type, spotify_uri, title, artist, album,
      played_at, duration_played_ms, skipped, source_file_name
    )
    select
      p_user_id, c.event_fingerprint, c.content_type, c.spotify_uri, c.title, c.artist, c.album,
      c.played_at, c.duration_played_ms, c.skipped, c.source_file_name
    from cleaned c
    on conflict (user_id, event_fingerprint) do nothing
    returning 1
  )
  select
    (select n from counted),
    (select count(*)::int from inserted)
  into v_incoming, v_inserted;

  return jsonb_build_object(
    'incoming', coalesce(v_incoming, 0),
    'inserted', coalesce(v_inserted, 0),
    'skipped', greatest(coalesce(v_incoming, 0) - coalesce(v_inserted, 0), 0)
  );
end;
$function$;

revoke all on function jukebox.import_spotify_history_events(uuid, jsonb) from public;
grant execute on function jukebox.import_spotify_history_events(uuid, jsonb) to service_role;
