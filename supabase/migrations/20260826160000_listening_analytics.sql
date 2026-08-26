-- Unified private listening analytics: Suffering Jukebox plays + Spotify history.
-- Filters: source (all|jukebox|spotify), date range, artist. Habits stay; Insights removed.
create or replace function jukebox.listening_analytics(
  p_user_id uuid,
  p_tz text default 'America/Chicago',
  p_artist text default null,
  p_source text default 'all',
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'jukebox', 'auth', 'pg_catalog'
as $function$
declare
  v_tz text := coalesce(nullif(trim(p_tz), ''), 'America/Chicago');
  v_artist text := nullif(trim(p_artist), '');
  v_source text := lower(coalesce(nullif(trim(p_source), ''), 'all'));
  v_email text;
  v_result jsonb;
begin
  if p_user_id is null then
    raise exception 'user required';
  end if;
  if v_source not in ('all', 'jukebox', 'spotify') then
    v_source := 'all';
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
      coalesce(e.duration_played_ms, 0)::bigint as duration_played_ms,
      coalesce(nullif(trim(e.artist), ''), 'Unknown artist') as artist,
      coalesce(nullif(trim(e.title), ''), 'Unknown track') as title,
      coalesce(e.skipped, false) as skipped,
      'spotify'::text as listen_source
    from jukebox.spotify_history_events e
    where e.user_id = p_user_id
      and v_source in ('all', 'spotify')

    union all

    -- Native Suffering Jukebox plays (exclude matched Spotify play_events rows)
    select
      pe.played_at,
      coalesce(pe.duration_played_ms, 0)::bigint as duration_played_ms,
      coalesce(nullif(trim(ar.name), ''), 'Unknown artist') as artist,
      coalesce(nullif(trim(t.name), ''), 'Unknown track') as title,
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
  dated as (
    select
      b.*,
      (b.played_at at time zone v_tz) as local_ts
    from base b
    where (p_from is null or b.played_at >= p_from)
      and (p_to is null or b.played_at < p_to)
  ),
  mine as (
    select *
    from dated
    where v_artist is null or artist = v_artist
  ),
  totals as (
    select
      count(*)::bigint as events,
      coalesce(sum(duration_played_ms), 0)::bigint as duration_ms,
      count(distinct artist)::bigint as artists,
      count(distinct title)::bigint as tracks,
      min(played_at) as first_played_at,
      max(played_at) as last_played_at,
      count(*) filter (where skipped)::bigint as skipped,
      count(*) filter (where listen_source = 'spotify')::bigint as spotify_events,
      count(*) filter (where listen_source = 'jukebox')::bigint as jukebox_events
    from mine
  ),
  by_month as (
    select
      extract(year from local_ts)::int as year,
      extract(month from local_ts)::int as month,
      count(*)::bigint as events,
      coalesce(sum(duration_played_ms), 0)::bigint as duration_ms
    from mine
    group by 1, 2
    order by 1, 2
  ),
  by_doy as (
    select
      extract(year from local_ts)::int as year,
      extract(doy from local_ts)::int as doy,
      count(*)::bigint as events
    from mine
    group by 1, 2
    order by 1, 2
  ),
  calendar as (
    select
      (local_ts::date)::text as day,
      count(*)::bigint as events,
      coalesce(sum(duration_played_ms), 0)::bigint as duration_ms
    from mine
    group by 1
    order by 1
  ),
  hour_dow as (
    select
      extract(dow from local_ts)::int as dow,
      extract(hour from local_ts)::int as hour,
      count(*)::bigint as events,
      coalesce(sum(duration_played_ms), 0)::bigint as duration_ms
    from mine
    group by 1, 2
    order by 1, 2
  ),
  artists as (
    select
      artist,
      count(*)::bigint as events,
      coalesce(sum(duration_played_ms), 0)::bigint as duration_ms,
      min(played_at) as first_played_at,
      max(played_at) as last_played_at,
      count(distinct title)::bigint as tracks
    from mine
    group by artist
    order by events desc, artist asc
    limit 250
  ),
  -- Artist picker options ignore the artist filter so you can switch artists.
  artist_options as (
    select
      artist,
      count(*)::bigint as events
    from dated
    group by artist
    order by events desc, artist asc
    limit 400
  ),
  habits as (
    select jsonb_build_object(
      'peakHour', (select hour from hour_dow order by events desc, hour asc limit 1),
      'peakDow', (select dow from hour_dow order by events desc, dow asc limit 1),
      'nightOwlShare', round(
        100.0 * coalesce((select sum(events) from hour_dow where hour >= 22 or hour < 5), 0)
        / nullif((select sum(events) from hour_dow), 0), 1),
      'weekendShare', round(
        100.0 * coalesce((select sum(events) from hour_dow where dow in (0, 6)), 0)
        / nullif((select sum(events) from hour_dow), 0), 1),
      'avgPerActiveDay', round(
        (select events::numeric from totals)
        / nullif((select count(*) from calendar), 0), 1),
      'activeDays', (select count(*) from calendar),
      'skipRate', round(
        100.0 * (select skipped from totals)
        / nullif((select events from totals), 0), 1),
      'uniqueArtists', (select artists from totals),
      'uniqueTracks', (select tracks from totals)
    ) as payload
  )
  select jsonb_build_object(
    'tz', v_tz,
    'source', v_source,
    'artistFilter', v_artist,
    'from', p_from,
    'to', p_to,
    'totals', (select to_jsonb(t) from totals t),
    'byMonth', coalesce((select jsonb_agg(to_jsonb(x) order by x.year, x.month) from by_month x), '[]'::jsonb),
    'byDayOfYear', coalesce((select jsonb_agg(to_jsonb(x) order by x.year, x.doy) from by_doy x), '[]'::jsonb),
    'calendar', coalesce((select jsonb_agg(to_jsonb(x) order by x.day) from calendar x), '[]'::jsonb),
    'hourDow', coalesce((select jsonb_agg(to_jsonb(x) order by x.dow, x.hour) from hour_dow x), '[]'::jsonb),
    'artists', coalesce((select jsonb_agg(to_jsonb(x)) from artists x), '[]'::jsonb),
    'artistOptions', coalesce((select jsonb_agg(to_jsonb(x)) from artist_options x), '[]'::jsonb),
    'habits', (select payload from habits)
  ) into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$function$;

revoke all on function jukebox.listening_analytics(uuid, text, text, text, timestamptz, timestamptz) from public;
grant execute on function jukebox.listening_analytics(uuid, text, text, text, timestamptz, timestamptz) to service_role;
