-- One-screen listening analytics: Suffering Jukebox plays + Spotify history.
--
-- Replaces the tab-per-view payload with the four things the page draws:
-- a time series bucketed to the range, hours by artist, hours by track, and
-- when-you-listen. Filters are multi-select now (artists, songs), so the
-- signature changed from single text args to text[] and the old function is
-- dropped rather than overloaded.
--
-- Two notes on the numbers:
--   * A Jukebox play often has no measured duration (only ~14% do), so it
--     falls back to the track's own length. Without that fallback the Jukebox
--     side of "hours listened" reads as near zero next to Spotify's.
--   * A song is identified by artist + title joined with chr(31), not by title
--     alone, because two artists share a title often enough to matter.
drop function if exists jukebox.listening_analytics(uuid, text, text, text, timestamptz, timestamptz);

create or replace function jukebox.listening_analytics(
  p_user_id uuid,
  p_tz text default 'America/Chicago',
  p_source text default 'all',
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_artists text[] default null,
  p_tracks text[] default null,
  p_bucket text default 'auto'
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'jukebox', 'auth', 'pg_catalog'
as $function$
declare
  v_tz text := coalesce(nullif(trim(p_tz), ''), 'America/Chicago');
  v_source text := lower(coalesce(nullif(trim(p_source), ''), 'all'));
  v_bucket text := lower(coalesce(nullif(trim(p_bucket), ''), 'auto'));
  v_artists text[] := case when p_artists is null or cardinality(p_artists) = 0 then null else p_artists end;
  v_tracks text[] := case when p_tracks is null or cardinality(p_tracks) = 0 then null else p_tracks end;
  v_email text;
  v_result jsonb;
begin
  if p_user_id is null then
    raise exception 'user required';
  end if;
  if v_source not in ('all', 'jukebox', 'spotify') then
    v_source := 'all';
  end if;
  if v_bucket not in ('auto', 'day', 'week', 'month', 'year') then
    v_bucket := 'auto';
  end if;
  begin
    perform now() at time zone v_tz;
  exception when others then
    v_tz := 'America/Chicago';
  end;

  select lower(nullif(trim(u.email), '')) into v_email
  from auth.users u
  where u.id = p_user_id;

  with base as (
    -- Spotify Extended Streaming History (GDPR export)
    select
      e.played_at,
      greatest(coalesce(e.duration_played_ms, 0), 0)::bigint as ms,
      coalesce(nullif(trim(e.artist), ''), 'Unknown artist') as artist,
      coalesce(nullif(trim(e.title), ''), 'Unknown track') as title,
      nullif(trim(e.album), '') as album,
      coalesce(e.skipped, false) as skipped,
      'spotify'::text as listen_source
    from jukebox.spotify_history_events e
    where e.user_id = p_user_id
      and v_source in ('all', 'spotify')

    union all

    -- Native Suffering Jukebox plays (matched Spotify rows are excluded so a
    -- listen held on both sides is not counted twice)
    select
      pe.played_at,
      greatest(coalesce(nullif(pe.duration_played_ms, 0), t.duration_ms, 0), 0)::bigint as ms,
      coalesce(nullif(trim(ar.name), ''), 'Unknown artist') as artist,
      coalesce(nullif(trim(t.name), ''), 'Unknown track') as title,
      nullif(trim(al.name), '') as album,
      false as skipped,
      'jukebox'::text as listen_source
    from jukebox.play_events pe
    left join jukebox.tracks t on t.id::text = pe.track_id
    left join jukebox.albums al on al.id::text = coalesce(nullif(pe.album_id, ''), t.album_id::text)
    left join jukebox.artists ar on ar.id::text = coalesce(nullif(pe.artist_id, ''), al.artist_id::text)
    where v_source in ('all', 'jukebox')
      and v_email is not null
      and lower(pe.user_email) = v_email
      and pe.event_type = 'play'
      and pe.source is distinct from 'spotify'
  ),
  tagged as (
    select
      b.*,
      (b.played_at at time zone v_tz) as local_ts,
      b.artist || chr(31) || b.title as track_key
    from base b
  ),
  -- Unfiltered by date so the date picker knows the whole span it can offer.
  bounds as (
    select min(played_at) as first_played_at, max(played_at) as last_played_at, count(*)::bigint as events
    from tagged
  ),
  dated as (
    select * from tagged
    where (p_from is null or played_at >= p_from)
      and (p_to is null or played_at < p_to)
  ),
  -- Each picker leaves its own filter off its option list, so a chosen artist
  -- can still be unchosen, and choosing one narrows the song list.
  for_artist_options as (select * from dated where v_tracks is null or track_key = any(v_tracks)),
  for_track_options as (select * from dated where v_artists is null or artist = any(v_artists)),
  mine as (select * from for_track_options where v_tracks is null or track_key = any(v_tracks)),
  span as (select min(local_ts) as mn, max(local_ts) as mx from mine),
  buck as (
    select case
      when v_bucket <> 'auto' then v_bucket
      when mn is null then 'month'
      when (mx::date - mn::date) <= 62 then 'day'
      when (mx::date - mn::date) <= 400 then 'week'
      when (mx::date - mn::date) <= 3700 then 'month'
      else 'year'
    end as b
    from span
  ),
  totals as (
    select
      count(*)::bigint as events,
      coalesce(sum(ms), 0)::bigint as duration_ms,
      count(distinct artist)::bigint as artists,
      count(distinct track_key)::bigint as tracks,
      count(distinct case when album is not null then artist || chr(31) || album end)::bigint as albums,
      min(played_at) as first_played_at,
      max(played_at) as last_played_at,
      count(*) filter (where skipped)::bigint as skipped,
      count(*) filter (where listen_source = 'spotify')::bigint as spotify_events,
      count(*) filter (where listen_source = 'jukebox')::bigint as jukebox_events,
      count(distinct local_ts::date)::bigint as active_days
    from mine
  ),
  -- Only non-empty buckets travel; the page fills the silent ones itself.
  series as (
    select
      to_char(date_trunc((select b from buck), local_ts), 'YYYY-MM-DD') as bucket_start,
      count(*)::bigint as events,
      coalesce(sum(ms), 0)::bigint as duration_ms
    from mine
    group by 1
    order by 1
  ),
  top_artists as (
    select
      artist,
      count(*)::bigint as events,
      coalesce(sum(ms), 0)::bigint as duration_ms,
      count(distinct track_key)::bigint as tracks
    from mine
    group by 1
    order by 3 desc, 2 desc, 1 asc
    limit 40
  ),
  top_tracks as (
    select
      track_key as key,
      title,
      artist,
      count(*)::bigint as events,
      coalesce(sum(ms), 0)::bigint as duration_ms
    from mine
    group by 1, 2, 3
    order by 5 desc, 4 desc, 2 asc
    limit 40
  ),
  by_dow as (
    select extract(dow from local_ts)::int as dow, count(*)::bigint as events, coalesce(sum(ms), 0)::bigint as duration_ms
    from mine group by 1 order by 1
  ),
  by_hour as (
    select extract(hour from local_ts)::int as hour, count(*)::bigint as events, coalesce(sum(ms), 0)::bigint as duration_ms
    from mine group by 1 order by 1
  ),
  by_hour_dow as (
    select extract(dow from local_ts)::int as dow, extract(hour from local_ts)::int as hour,
      count(*)::bigint as events, coalesce(sum(ms), 0)::bigint as duration_ms
    from mine group by 1, 2 order by 1, 2
  ),
  artist_options as (
    select artist, count(*)::bigint as events, coalesce(sum(ms), 0)::bigint as duration_ms
    from for_artist_options group by 1 order by 3 desc, 2 desc, 1 asc limit 3000
  ),
  track_options as (
    select track_key as key, title, artist, count(*)::bigint as events, coalesce(sum(ms), 0)::bigint as duration_ms
    from for_track_options group by 1, 2, 3 order by 5 desc, 4 desc, 2 asc limit 1500
  )
  select jsonb_build_object(
    'tz', v_tz,
    'source', v_source,
    'bucket', (select b from buck),
    'bucketMode', v_bucket,
    'from', p_from,
    'to', p_to,
    'artistFilter', coalesce(to_jsonb(v_artists), '[]'::jsonb),
    'trackFilter', coalesce(to_jsonb(v_tracks), '[]'::jsonb),
    'bounds', (select to_jsonb(b) from bounds b),
    'available', jsonb_build_object(
      'spotify', exists (select 1 from jukebox.spotify_history_events e where e.user_id = p_user_id),
      'jukebox', v_email is not null and exists (
        select 1 from jukebox.play_events pe
        where lower(pe.user_email) = v_email and pe.event_type = 'play' and pe.source is distinct from 'spotify'
      )
    ),
    'totals', (select to_jsonb(t) from totals t),
    'series', coalesce((select jsonb_agg(to_jsonb(x) order by x.bucket_start) from series x), '[]'::jsonb),
    'topArtists', coalesce((select jsonb_agg(to_jsonb(x)) from top_artists x), '[]'::jsonb),
    'topTracks', coalesce((select jsonb_agg(to_jsonb(x)) from top_tracks x), '[]'::jsonb),
    'byDow', coalesce((select jsonb_agg(to_jsonb(x) order by x.dow) from by_dow x), '[]'::jsonb),
    'byHour', coalesce((select jsonb_agg(to_jsonb(x) order by x.hour) from by_hour x), '[]'::jsonb),
    'byHourDow', coalesce((select jsonb_agg(to_jsonb(x) order by x.dow, x.hour) from by_hour_dow x), '[]'::jsonb),
    'artistOptions', coalesce((select jsonb_agg(to_jsonb(x)) from artist_options x), '[]'::jsonb),
    'trackOptions', coalesce((select jsonb_agg(to_jsonb(x)) from track_options x), '[]'::jsonb)
  ) into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$function$;

revoke all on function jukebox.listening_analytics(uuid, text, text, timestamptz, timestamptz, text[], text[], text) from public;
grant execute on function jukebox.listening_analytics(uuid, text, text, timestamptz, timestamptz, text[], text[], text) to service_role;
