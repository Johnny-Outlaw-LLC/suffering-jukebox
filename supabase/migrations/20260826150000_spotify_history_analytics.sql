-- Rich private Spotify-history analytics for /analytics.
-- Aggregates over jukebox.spotify_history_events only; never mixes into public totals.
create or replace function jukebox.spotify_history_analytics(
  p_user_id uuid,
  p_tz text default 'America/Chicago',
  p_artist text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'jukebox', 'pg_catalog'
as $function$
declare
  v_tz text := coalesce(nullif(trim(p_tz), ''), 'America/Chicago');
  v_artist text := nullif(trim(p_artist), '');
  v_result jsonb;
begin
  if p_user_id is null then
    raise exception 'user required';
  end if;
  begin
    perform now() at time zone v_tz;
  exception when others then
    v_tz := 'America/Chicago';
  end;

  with mine as (
    select
      e.*,
      (e.played_at at time zone v_tz) as local_ts
    from jukebox.spotify_history_events e
    where e.user_id = p_user_id
      and (v_artist is null or e.artist = v_artist)
  ),
  totals as (
    select
      count(*)::bigint as events,
      coalesce(sum(duration_played_ms), 0)::bigint as duration_ms,
      count(distinct artist)::bigint as artists,
      count(distinct title)::bigint as tracks,
      min(played_at) as first_played_at,
      max(played_at) as last_played_at,
      count(*) filter (where skipped)::bigint as skipped
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
    limit 200
  ),
  tracks as (
    select
      artist,
      title,
      count(*)::bigint as events,
      coalesce(sum(duration_played_ms), 0)::bigint as duration_ms,
      min(played_at) as first_played_at,
      max(played_at) as last_played_at
    from mine
    where content_type = 'music'
    group by artist, title
  ),
  forgotten as (
    select artist, title, events, duration_ms, first_played_at, last_played_at
    from tracks
    where events >= 8
      and last_played_at < now() - interval '180 days'
    order by events desc, last_played_at asc
    limit 25
  ),
  rising as (
    select
      artist,
      count(*) filter (where played_at >= now() - interval '90 days')::bigint as recent,
      count(*) filter (where played_at >= now() - interval '180 days' and played_at < now() - interval '90 days')::bigint as prior
    from mine
    where content_type = 'music'
    group by artist
  ),
  comebacks as (
    select a.artist, a.events, a.first_played_at, a.last_played_at, a.duration_ms
    from artists a
    where a.first_played_at < now() - interval '2 years'
      and a.last_played_at >= now() - interval '90 days'
      and exists (
        select 1 from mine m
        where m.artist = a.artist
          and m.played_at < now() - interval '365 days'
      )
      and not exists (
        select 1 from mine m
        where m.artist = a.artist
          and m.played_at >= now() - interval '365 days'
          and m.played_at < now() - interval '90 days'
      )
    order by a.events desc
    limit 15
  ),
  binge as (
    select
      artist,
      date_trunc('week', local_ts)::date::text as week_start,
      count(*)::bigint as events
    from mine
    group by 1, 2
    order by events desc
    limit 12
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
    'artistFilter', v_artist,
    'totals', (select to_jsonb(t) from totals t),
    'byMonth', coalesce((select jsonb_agg(to_jsonb(x) order by x.year, x.month) from by_month x), '[]'::jsonb),
    'byDayOfYear', coalesce((select jsonb_agg(to_jsonb(x) order by x.year, x.doy) from by_doy x), '[]'::jsonb),
    'calendar', coalesce((select jsonb_agg(to_jsonb(x) order by x.day) from calendar x), '[]'::jsonb),
    'hourDow', coalesce((select jsonb_agg(to_jsonb(x) order by x.dow, x.hour) from hour_dow x), '[]'::jsonb),
    'artists', coalesce((select jsonb_agg(to_jsonb(x)) from artists x), '[]'::jsonb),
    'insights', jsonb_build_object(
      'forgottenFavorites', coalesce((select jsonb_agg(to_jsonb(x)) from forgotten x), '[]'::jsonb),
      'risingArtists', coalesce((
        select jsonb_agg(jsonb_build_object(
          'artist', artist, 'recent', recent, 'prior', prior, 'delta', recent - prior
        ) order by (recent - prior) desc, recent desc)
        from rising where recent >= 5 and recent > prior * 2
      ), '[]'::jsonb),
      'comebacks', coalesce((select jsonb_agg(to_jsonb(x)) from comebacks x), '[]'::jsonb),
      'binges', coalesce((select jsonb_agg(to_jsonb(x)) from binge x), '[]'::jsonb),
      'habits', (select payload from habits)
    )
  ) into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$function$;

revoke all on function jukebox.spotify_history_analytics(uuid, text, text) from public;
grant execute on function jukebox.spotify_history_analytics(uuid, text, text) to service_role;
