-- Record Keeper joins the shared application; preserve existing attribution and access rules.
begin;

alter table jukebox.play_events drop constraint play_events_surface_id_check;
alter table jukebox.play_events add constraint play_events_surface_id_check check (surface_id is null or surface_id in ('sj','lp','rk'));

alter table jukebox.page_views drop constraint page_views_surface_check;
alter table jukebox.page_views add constraint page_views_surface_check check (surface in ('sj','lp','rk'));

CREATE OR REPLACE FUNCTION jukebox.listening_analytics(p_user_id uuid, p_tz text DEFAULT 'America/Chicago'::text, p_source text DEFAULT 'all'::text, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_artists text[] DEFAULT NULL::text[], p_artists_mode text DEFAULT 'include'::text, p_tracks text[] DEFAULT NULL::text[], p_tracks_mode text DEFAULT 'include'::text, p_bucket text DEFAULT 'auto'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'jukebox', 'auth', 'pg_catalog'
AS $function$
declare
  v_tz text := coalesce(nullif(trim(p_tz), ''), 'America/Chicago');
  v_source text := lower(coalesce(nullif(trim(p_source), ''), 'all'));
  v_bucket text := lower(coalesce(nullif(trim(p_bucket), ''), 'auto'));
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
  if v_source not in ('all', 'jukebox', 'sj', 'lp', 'rk', 'spotify', 'youtube') then
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
      and e.deleted = false
      and coalesce(e.history_source, 'spotify') = 'spotify'
      and v_source in ('all', 'spotify')

    union all

    select
      e.played_at,
      0::bigint as ms,
      coalesce(nullif(trim(e.artist), ''), 'Unknown artist') as artist,
      coalesce(nullif(trim(e.title), ''), 'Unknown track') as title,
      nullif(trim(e.album), '') as album,
      coalesce(e.skipped, false) as skipped,
      'youtube'::text as listen_source
    from jukebox.spotify_history_events e
    where e.user_id = p_user_id
      and e.deleted = false
      and e.history_source = 'youtube'
      and v_source in ('all', 'youtube')

    union all

    select
      pe.played_at,
      greatest(coalesce(nullif(pe.duration_played_ms, 0), t.duration_ms, 0), 0)::bigint as ms,
      coalesce(nullif(trim(ar.name), ''), 'Unknown artist') as artist,
      coalesce(nullif(trim(t.name), ''), 'Unknown track') as title,
      nullif(trim(al.name), '') as album,
      false as skipped,
      coalesce(pe.surface_id, 'sj') as listen_source
    from jukebox.play_events pe
    left join jukebox.tracks t on t.id::text = pe.track_id
    left join jukebox.albums al on al.id::text = coalesce(nullif(pe.album_id, ''), t.album_id::text)
    left join jukebox.artists ar on ar.id::text = coalesce(nullif(pe.artist_id, ''), al.artist_id::text)
    where v_source in ('all', 'jukebox', 'sj', 'lp', 'rk')
      and v_email is not null
      and lower(pe.user_email) = v_email
      and pe.event_type = 'play'
      and pe.deleted = false
      and pe.source is distinct from 'spotify'
      and (
        v_source in ('all', 'jukebox')
        or (v_source = 'sj' and coalesce(pe.surface_id, 'sj') = 'sj')
        or (v_source = 'lp' and coalesce(pe.surface_id, 'sj') = 'lp')
        or (v_source = 'rk' and pe.surface_id = 'rk')
      )
  ),
  tagged as (
    select
      b.*,
      (b.played_at at time zone v_tz) as local_ts,
      b.artist || chr(31) || b.title as track_key,
      case when b.listen_source = 'spotify' then b.ms else 0 end as spotify_ms,
      case when b.listen_source = 'youtube' then b.ms else 0 end as youtube_ms,
      case when b.listen_source = 'sj' then b.ms else 0 end as sj_ms,
      case when b.listen_source = 'lp' then b.ms else 0 end as lp_ms,
      case when b.listen_source = 'rk' then b.ms else 0 end as rk_ms,
      case when b.listen_source in ('sj', 'lp', 'rk') then b.ms else 0 end as jukebox_ms
    from base b
  ),
  bounds as (
    select min(played_at) as first_played_at, max(played_at) as last_played_at, count(*)::bigint as events
    from tagged
  ),
  dated as (
    select * from tagged
    where (p_from is null or played_at >= p_from)
      and (p_to is null or played_at < p_to)
  ),
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
      coalesce(sum(youtube_ms), 0)::bigint as youtube_ms,
      coalesce(sum(sj_ms), 0)::bigint as sj_ms,
      coalesce(sum(lp_ms), 0)::bigint as lp_ms,
      coalesce(sum(rk_ms), 0)::bigint as rk_ms,
      coalesce(sum(jukebox_ms), 0)::bigint as jukebox_ms,
      count(distinct artist)::bigint as artists,
      count(distinct track_key)::bigint as tracks,
      count(distinct case when album is not null then artist || chr(31) || album end)::bigint as albums,
      min(played_at) as first_played_at,
      max(played_at) as last_played_at,
      count(*) filter (where skipped)::bigint as skipped,
      count(*) filter (where listen_source = 'spotify')::bigint as spotify_events,
      count(*) filter (where listen_source = 'youtube')::bigint as youtube_events,
      count(*) filter (where listen_source = 'sj')::bigint as sj_events,
      count(*) filter (where listen_source = 'lp')::bigint as lp_events,
      count(*) filter (where listen_source = 'rk')::bigint as rk_events,
      count(*) filter (where listen_source in ('sj', 'lp', 'rk'))::bigint as jukebox_events,
      count(distinct local_ts::date)::bigint as active_days
    from mine
  ),
  series as (
    select
      to_char(date_trunc((select b from buck), local_ts), 'YYYY-MM-DD') as bucket_start,
      count(*)::bigint as events,
      coalesce(sum(ms), 0)::bigint as duration_ms,
      coalesce(sum(spotify_ms), 0)::bigint as spotify_ms,
      coalesce(sum(youtube_ms), 0)::bigint as youtube_ms,
      coalesce(sum(sj_ms), 0)::bigint as sj_ms,
      coalesce(sum(lp_ms), 0)::bigint as lp_ms,
      coalesce(sum(rk_ms), 0)::bigint as rk_ms,
      coalesce(sum(jukebox_ms), 0)::bigint as jukebox_ms,
      count(*) filter (where listen_source = 'spotify')::bigint as spotify_events,
      count(*) filter (where listen_source = 'youtube')::bigint as youtube_events,
      count(*) filter (where listen_source = 'sj')::bigint as sj_events,
      count(*) filter (where listen_source = 'lp')::bigint as lp_events,
      count(*) filter (where listen_source = 'rk')::bigint as rk_events,
      count(*) filter (where listen_source in ('sj', 'lp', 'rk'))::bigint as jukebox_events
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
      coalesce(sum(youtube_ms), 0)::bigint as youtube_ms,
      coalesce(sum(sj_ms), 0)::bigint as sj_ms,
      coalesce(sum(lp_ms), 0)::bigint as lp_ms,
      coalesce(sum(rk_ms), 0)::bigint as rk_ms,
      coalesce(sum(jukebox_ms), 0)::bigint as jukebox_ms,
      count(*) filter (where listen_source = 'spotify')::bigint as spotify_events,
      count(*) filter (where listen_source = 'youtube')::bigint as youtube_events,
      count(*) filter (where listen_source = 'sj')::bigint as sj_events,
      count(*) filter (where listen_source = 'lp')::bigint as lp_events,
      count(*) filter (where listen_source = 'rk')::bigint as rk_events,
      count(*) filter (where listen_source in ('sj', 'lp', 'rk'))::bigint as jukebox_events
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
      coalesce(sum(youtube_ms), 0)::bigint as youtube_ms,
      coalesce(sum(sj_ms), 0)::bigint as sj_ms,
      coalesce(sum(lp_ms), 0)::bigint as lp_ms,
      coalesce(sum(rk_ms), 0)::bigint as rk_ms,
      coalesce(sum(jukebox_ms), 0)::bigint as jukebox_ms,
      count(distinct track_key)::bigint as tracks,
      count(*) filter (where listen_source = 'spotify')::bigint as spotify_events,
      count(*) filter (where listen_source = 'youtube')::bigint as youtube_events,
      count(*) filter (where listen_source = 'sj')::bigint as sj_events,
      count(*) filter (where listen_source = 'lp')::bigint as lp_events,
      count(*) filter (where listen_source = 'rk')::bigint as rk_events,
      count(*) filter (where listen_source in ('sj', 'lp', 'rk'))::bigint as jukebox_events
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
      coalesce(sum(youtube_ms), 0)::bigint as youtube_ms,
      coalesce(sum(sj_ms), 0)::bigint as sj_ms,
      coalesce(sum(lp_ms), 0)::bigint as lp_ms,
      coalesce(sum(rk_ms), 0)::bigint as rk_ms,
      coalesce(sum(jukebox_ms), 0)::bigint as jukebox_ms,
      count(*) filter (where listen_source = 'spotify')::bigint as spotify_events,
      count(*) filter (where listen_source = 'youtube')::bigint as youtube_events,
      count(*) filter (where listen_source = 'sj')::bigint as sj_events,
      count(*) filter (where listen_source = 'lp')::bigint as lp_events,
      count(*) filter (where listen_source = 'rk')::bigint as rk_events,
      count(*) filter (where listen_source in ('sj', 'lp', 'rk'))::bigint as jukebox_events
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
      coalesce(sum(youtube_ms), 0)::bigint as youtube_ms,
      coalesce(sum(sj_ms), 0)::bigint as sj_ms,
      coalesce(sum(lp_ms), 0)::bigint as lp_ms,
      coalesce(sum(rk_ms), 0)::bigint as rk_ms,
      coalesce(sum(jukebox_ms), 0)::bigint as jukebox_ms,
      count(*) filter (where listen_source = 'spotify')::bigint as spotify_events,
      count(*) filter (where listen_source = 'youtube')::bigint as youtube_events,
      count(*) filter (where listen_source = 'sj')::bigint as sj_events,
      count(*) filter (where listen_source = 'lp')::bigint as lp_events,
      count(*) filter (where listen_source = 'rk')::bigint as rk_events,
      count(*) filter (where listen_source in ('sj', 'lp', 'rk'))::bigint as jukebox_events
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
      'spotify', exists (select 1 from jukebox.spotify_history_events e where e.user_id = p_user_id and e.deleted = false and coalesce(e.history_source, 'spotify') = 'spotify'),
      'youtube', exists (select 1 from jukebox.spotify_history_events e where e.user_id = p_user_id and e.deleted = false and e.history_source = 'youtube'),
      'sj', v_email is not null and exists (
        select 1 from jukebox.play_events pe
        where lower(pe.user_email) = v_email and pe.event_type = 'play'
          and pe.deleted = false
          and pe.source is distinct from 'spotify'
          and coalesce(pe.surface_id, 'sj') = 'sj'
      ),
      'rk', v_email is not null and exists (select 1 from jukebox.play_events pe where lower(pe.user_email) = v_email and pe.event_type = 'play' and pe.source is distinct from 'spotify' and pe.surface_id = 'rk'),
      'lp', v_email is not null and exists (
        select 1 from jukebox.play_events pe
        where lower(pe.user_email) = v_email and pe.event_type = 'play'
          and pe.deleted = false
          and pe.source is distinct from 'spotify'
          and pe.surface_id = 'lp'
      ),
      'jukebox', v_email is not null and exists (
        select 1 from jukebox.play_events pe
        where lower(pe.user_email) = v_email and pe.event_type = 'play' and pe.deleted = false and pe.source is distinct from 'spotify'
      )
    ),
    'totals', (select to_jsonb(t) from totals t),
    'series', coalesce((select jsonb_agg(to_jsonb(x) order by x.bucket_start) from series x), '[]'::jsonb),
    'calendar', coalesce((select jsonb_agg(to_jsonb(x) order by x.day) from calendar x), '[]'::jsonb),
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
$function$
;

CREATE OR REPLACE FUNCTION jukebox.log_play_event(p_track_id text, p_artist_id text DEFAULT NULL::text, p_album_id text DEFAULT NULL::text, p_event_type text DEFAULT 'card_open'::text, p_source text DEFAULT NULL::text, p_device_id text DEFAULT NULL::text, p_rating_at_play integer DEFAULT NULL::integer, p_surface_id text DEFAULT NULL::text, p_listen_context text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'jukebox'
AS $function$
declare
  v_id uuid;
  v_surface text := lower(nullif(trim(coalesce(p_surface_id, '')), ''));
  v_context text := lower(nullif(trim(coalesce(p_listen_context, '')), ''));
  v_artist text;
  v_album text;
begin
  if coalesce(trim(p_track_id), '') = '' then
    raise exception 'track_id is required';
  end if;
  if coalesce(p_event_type, 'card_open') not in ('card_open', 'play', 'queue') then
    raise exception 'invalid event_type';
  end if;
  if p_source is not null and p_source not in ('video', 'audio', 'spotify') then
    raise exception 'invalid source';
  end if;
  if v_surface is not null and v_surface not in ('sj', 'lp', 'rk') then
    raise exception 'invalid surface_id';
  end if;
  if v_context not in ('web', 'web_background', 'app', 'app_background') then
    v_context := null;
  end if;

  if p_track_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select al.artist_id::text, t.album_id::text
      into v_artist, v_album
      from jukebox.tracks t
      left join jukebox.albums al on al.id = t.album_id
     where t.id = p_track_id::uuid;
  end if;

  insert into jukebox.play_events (
    track_id, artist_id, album_id, event_type, source, device_id,
    rating_at_play, surface_id, listen_context, ip_address, user_email, user_name)
  values (
    left(p_track_id, 64),
    coalesce(v_artist, left(nullif(p_artist_id, ''), 64)),
    coalesce(v_album, left(nullif(p_album_id, ''), 64)),
    coalesce(p_event_type, 'card_open'), p_source, left(p_device_id, 128),
    p_rating_at_play, v_surface, v_context,
    jukebox.request_ip(), jukebox.jwt_email(), jukebox.jwt_name())
  returning id into v_id;

  return v_id;
end;
$function$
;

commit;