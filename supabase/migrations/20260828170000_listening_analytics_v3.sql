-- Analytics, second pass. Four changes that all had to happen in one function:
--
--   * Every measure is split by source, so Spotify and Suffering Jukebox can be
--     drawn in their own colours rather than summed into one bar.
--   * The artist and song filters gained an exclude mode. The pickers start
--     with everything ticked, so "all but these four" is the common shape and
--     sending 2,752 names to say it would be absurd.
--   * A ranking no longer filters itself. Hours by artist ignores the artist
--     filter (and hours by song the song filter), which is what lets several
--     bars be clicked in turn instead of the chart collapsing to the first one.
--   * The by-weekday and by-hour bar charts are gone, replaced by the day x
--     hour matrix beside a day-by-day calendar.
drop function if exists jukebox.listening_analytics(uuid, text, text, timestamptz, timestamptz, text[], text[], text);

create or replace function jukebox.listening_analytics(
  p_user_id uuid,
  p_tz text default 'America/Chicago',
  p_source text default 'all',
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_artists text[] default null,
  p_artists_mode text default 'include',
  p_tracks text[] default null,
  p_tracks_mode text default 'include',
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
  -- null means no filter; an explicit empty array means match nothing.
  v_artists text[] := p_artists;
  v_tracks text[] := p_tracks;
  v_artists_mode text := case when lower(coalesce(p_artists_mode, '')) = 'exclude' then 'exclude' else 'include' end;
  v_tracks_mode text := case when lower(coalesce(p_tracks_mode, '')) = 'exclude' then 'exclude' else 'include' end;
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
    -- listen held on both sides is not counted twice). Only about one play in
    -- seven records how long it ran, so the track's own length stands in.
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
      b.artist || chr(31) || b.title as track_key,
      case when b.listen_source = 'spotify' then b.ms else 0 end as spotify_ms,
      case when b.listen_source = 'jukebox' then b.ms else 0 end as jukebox_ms
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
  -- Each of the two names below carries every filter EXCEPT its own. That one
  -- rule feeds both the option lists and the rankings: an artist you have
  -- already chosen has to stay on screen to be unchosen.
  artist_scope as (
    select * from dated
    where v_tracks is null
      or (v_tracks_mode = 'include' and track_key = any(v_tracks))
      or (v_tracks_mode = 'exclude' and track_key <> all(v_tracks))
  ),
  track_scope as (
    select * from dated
    where v_artists is null
      or (v_artists_mode = 'include' and artist = any(v_artists))
      or (v_artists_mode = 'exclude' and artist <> all(v_artists))
  ),
  mine as (
    select * from track_scope
    where v_tracks is null
      or (v_tracks_mode = 'include' and track_key = any(v_tracks))
      or (v_tracks_mode = 'exclude' and track_key <> all(v_tracks))
  ),
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
      coalesce(sum(spotify_ms), 0)::bigint as spotify_ms,
      coalesce(sum(jukebox_ms), 0)::bigint as jukebox_ms,
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
  -- Only non-empty buckets travel; the page fills the silent ones.
  series as (
    select
      to_char(date_trunc((select b from buck), local_ts), 'YYYY-MM-DD') as bucket_start,
      count(*)::bigint as events,
      coalesce(sum(ms), 0)::bigint as duration_ms,
      coalesce(sum(spotify_ms), 0)::bigint as spotify_ms,
      coalesce(sum(jukebox_ms), 0)::bigint as jukebox_ms,
      count(*) filter (where listen_source = 'spotify')::bigint as spotify_events,
      count(*) filter (where listen_source = 'jukebox')::bigint as jukebox_events
    from mine
    group by 1
    order by 1
  ),
  calendar as (
    select
      to_char(local_ts::date, 'YYYY-MM-DD') as day,
      count(*)::bigint as events,
      coalesce(sum(ms), 0)::bigint as duration_ms,
      coalesce(sum(spotify_ms), 0)::bigint as spotify_ms,
      coalesce(sum(jukebox_ms), 0)::bigint as jukebox_ms,
      count(*) filter (where listen_source = 'spotify')::bigint as spotify_events,
      count(*) filter (where listen_source = 'jukebox')::bigint as jukebox_events
    from mine
    group by 1
    order by 1
  ),
  top_artists as (
    select
      artist,
      count(*)::bigint as events,
      coalesce(sum(ms), 0)::bigint as duration_ms,
      coalesce(sum(spotify_ms), 0)::bigint as spotify_ms,
      coalesce(sum(jukebox_ms), 0)::bigint as jukebox_ms,
      count(distinct track_key)::bigint as tracks,
      count(*) filter (where listen_source = 'spotify')::bigint as spotify_events,
      count(*) filter (where listen_source = 'jukebox')::bigint as jukebox_events
    from artist_scope
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
      coalesce(sum(ms), 0)::bigint as duration_ms,
      coalesce(sum(spotify_ms), 0)::bigint as spotify_ms,
      coalesce(sum(jukebox_ms), 0)::bigint as jukebox_ms,
      count(*) filter (where listen_source = 'spotify')::bigint as spotify_events,
      count(*) filter (where listen_source = 'jukebox')::bigint as jukebox_events
    from track_scope
    group by 1, 2, 3
    order by 5 desc, 4 desc, 2 asc
    limit 40
  ),
  by_hour_dow as (
    select
      extract(dow from local_ts)::int as dow,
      extract(hour from local_ts)::int as hour,
      count(*)::bigint as events,
      coalesce(sum(ms), 0)::bigint as duration_ms,
      coalesce(sum(spotify_ms), 0)::bigint as spotify_ms,
      coalesce(sum(jukebox_ms), 0)::bigint as jukebox_ms,
      count(*) filter (where listen_source = 'spotify')::bigint as spotify_events,
      count(*) filter (where listen_source = 'jukebox')::bigint as jukebox_events
    from mine
    group by 1, 2
    order by 1, 2
  ),
  artist_options as (
    select artist, count(*)::bigint as events, coalesce(sum(ms), 0)::bigint as duration_ms
    from artist_scope group by 1 order by 3 desc, 2 desc, 1 asc limit 3000
  ),
  track_options as (
    select track_key as key, title, artist, count(*)::bigint as events, coalesce(sum(ms), 0)::bigint as duration_ms
    from track_scope group by 1, 2, 3 order by 5 desc, 4 desc, 2 asc limit 1500
  )
  select jsonb_build_object(
    'tz', v_tz,
    'source', v_source,
    'bucket', (select b from buck),
    'bucketMode', v_bucket,
    'from', p_from,
    'to', p_to,
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
    'calendar', coalesce((select jsonb_agg(to_jsonb(x) order by x.day) from calendar x), '[]'::jsonb),
    -- in_jukebox decides whether a row offers Add to Jukebox. An artist is a
    -- name match; a song also accepts the catalogue name CONTAINING the title,
    -- because a catalogue track is often named after the raw YouTube upload
    -- ("Silver Jews - Random Rules HQ"). The 40% length floor is what stops
    -- "True Love" answering for "True Love Will Find You In The End".
    'topArtists', coalesce((
      select jsonb_agg(to_jsonb(x) || jsonb_build_object('in_jukebox', exists (
        select 1 from jukebox.artists a where lower(a.name) = lower(x.artist)
      )))
      from top_artists x
    ), '[]'::jsonb),
    'topTracks', coalesce((
      select jsonb_agg(to_jsonb(x) || jsonb_build_object('in_jukebox', exists (
        select 1
        from jukebox.tracks t
        join jukebox.albums al on al.id = t.album_id
        join jukebox.artists a on a.id = al.artist_id
        where lower(a.name) = lower(x.artist)
          and position(lower(x.title) in lower(t.name)) > 0
          and length(x.title) * 100 >= length(t.name) * 40
      )))
      from top_tracks x
    ), '[]'::jsonb),
    'byHourDow', coalesce((select jsonb_agg(to_jsonb(x) order by x.dow, x.hour) from by_hour_dow x), '[]'::jsonb),
    'artistOptions', coalesce((select jsonb_agg(to_jsonb(x)) from artist_options x), '[]'::jsonb),
    'trackOptions', coalesce((select jsonb_agg(to_jsonb(x)) from track_options x), '[]'::jsonb)
  ) into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$function$;

revoke all on function jukebox.listening_analytics(uuid, text, text, timestamptz, timestamptz, text[], text, text[], text, text) from public;
grant execute on function jukebox.listening_analytics(uuid, text, text, timestamptz, timestamptz, text[], text, text[], text, text) to service_role;
