-- Spotify Extended Streaming History → play_events.source = 'spotify'
-- Personal only: excluded from global play totals, included in my_* aggregates.

alter table jukebox.play_events
  add column if not exists spotify_track_uri text;

-- No anon/authenticated SELECT on the URI (service role / SECURITY DEFINER only).
revoke select (spotify_track_uri) on jukebox.play_events from anon, authenticated;

create unique index if not exists play_events_spotify_dedupe
  on jukebox.play_events (user_email, spotify_track_uri, played_at)
  where source = 'spotify'
    and user_email is not null
    and spotify_track_uri is not null;

-- Allow 'spotify' on live plays (and keep video/audio).
create or replace function jukebox.log_play_event(
  p_track_id text,
  p_artist_id text default null,
  p_album_id text default null,
  p_event_type text default 'card_open',
  p_source text default null,
  p_device_id text default null,
  p_rating_at_play integer default null
)
returns uuid
language plpgsql
security definer
set search_path to 'jukebox'
as $function$
declare
  v_id uuid;
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

  insert into jukebox.play_events (
    track_id, artist_id, album_id, event_type, source, device_id,
    rating_at_play, ip_address, user_email, user_name)
  values (
    left(p_track_id, 64), left(p_artist_id, 64), left(p_album_id, 64),
    coalesce(p_event_type, 'card_open'), p_source, left(p_device_id, 128),
    p_rating_at_play,
    jukebox.request_ip(), jukebox.jwt_email(), jukebox.jwt_name())
  returning id into v_id;

  return v_id;
end;
$function$;

-- Bulk import from a cleaned Spotify history payload. Idempotent via the unique index.
-- Prefer the JWT email; the Next route may pass p_email when calling with the service role.
create or replace function jukebox.import_spotify_plays(p_plays jsonb, p_email text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'jukebox', 'public'
as $function$
declare
  v_email text := coalesce(jukebox.jwt_email(), nullif(lower(trim(coalesce(p_email, ''))), ''));
  v_name text := jukebox.jwt_name();
  v_inserted int := 0;
  v_skipped int := 0;
  v_item jsonb;
  v_track_id text;
  v_uri text;
  v_played_at timestamptz;
  v_ms bigint;
  v_artist_id text;
  v_album_id text;
begin
  if v_email is null then
    raise exception 'sign in required';
  end if;
  -- When the JWT is present, ignore a forged p_email.
  if jukebox.jwt_email() is not null then
    v_email := jukebox.jwt_email();
  end if;
  if p_plays is null or jsonb_typeof(p_plays) <> 'array' then
    raise exception 'plays array required';
  end if;
  if jsonb_array_length(p_plays) > 2000 then
    raise exception 'at most 2000 plays per call';
  end if;

  for v_item in select * from jsonb_array_elements(p_plays)
  loop
    v_track_id := nullif(left(trim(coalesce(v_item->>'track_id', '')), 64), '');
    v_uri := nullif(left(trim(coalesce(v_item->>'spotify_track_uri', '')), 128), '');
    v_played_at := (v_item->>'played_at')::timestamptz;
    v_ms := nullif(v_item->>'duration_played_ms', '')::bigint;
    v_artist_id := nullif(left(trim(coalesce(v_item->>'artist_id', '')), 64), '');
    v_album_id := nullif(left(trim(coalesce(v_item->>'album_id', '')), 64), '');

    if v_track_id is null or v_uri is null or v_played_at is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if not exists (select 1 from jukebox.tracks t where t.id::text = v_track_id) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    begin
      insert into jukebox.play_events (
        track_id, artist_id, album_id, event_type, source,
        duration_played_ms, played_at, play_ended_at,
        spotify_track_uri, user_email, user_name, ip_address
      ) values (
        v_track_id, v_artist_id, v_album_id, 'play', 'spotify',
        v_ms, v_played_at, v_played_at + make_interval(secs => greatest(coalesce(v_ms, 0), 0) / 1000.0),
        v_uri, v_email, v_name, null
      );
      v_inserted := v_inserted + 1;
    exception when unique_violation then
      v_skipped := v_skipped + 1;
    end;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'skipped', v_skipped);
end;
$function$;

revoke all on function jukebox.import_spotify_plays(jsonb, text) from public;
grant execute on function jukebox.import_spotify_plays(jsonb, text) to authenticated, service_role;

-- Global totals: never count Spotify history as "everyone's Jukebox Plays".
create or replace view jukebox.track_play_counts as
  select track_id,
    count(*) filter (
      where event_type = 'play'
        and (source is null or source in ('video', 'audio'))
    ) as play_count,
    count(*) filter (where event_type = 'queue') as queue_count,
    count(*) as total_events
  from jukebox.play_events
  group by track_id;

grant select on jukebox.track_play_counts to anon, authenticated, service_role;

-- Personal daily sparkline split (native jukebox vs Spotify import).
create or replace function jukebox.my_daily_plays(p_days integer default 30)
returns table(track_id text, day date, native bigint, spotify bigint)
language sql
stable
security definer
set search_path to 'jukebox'
as $function$
  select pe.track_id,
    (pe.played_at at time zone 'UTC')::date as day,
    count(*) filter (where pe.source is distinct from 'spotify')::bigint as native,
    count(*) filter (where pe.source = 'spotify')::bigint as spotify
  from jukebox.play_events pe
  where jukebox.jwt_email() is not null
    and lower(pe.user_email) = jukebox.jwt_email()
    and pe.event_type = 'play'
    and pe.played_at >= (now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 3650)))
    and pe.track_id <> 'test-verify'
  group by pe.track_id, (pe.played_at at time zone 'UTC')::date;
$function$;

revoke all on function jukebox.my_daily_plays(integer) from public;
grant execute on function jukebox.my_daily_plays(integer) to authenticated, anon, service_role;

-- Include source on personal dashboard rows so Analytics can shade Spotify plays.
create or replace function jukebox.my_dashboard_data(p_user text, p_days integer default 365)
returns jsonb
language plpgsql
security definer
set search_path to 'jukebox', 'public'
as $function$
declare
  v_user text := nullif(lower(trim(coalesce(p_user, ''))), '');
  v_days int := least(greatest(coalesce(p_days, 365), 1), 3650);
  v_cut timestamptz := now() - make_interval(days => v_days);
  v_plays jsonb;
  v_ratings jsonb;
begin
  if v_user is null then
    return jsonb_build_object('plays', '[]'::jsonb, 'ratings', '[]'::jsonb, 'days', v_days);
  end if;

  select coalesce(jsonb_agg(row_to_json(p)::jsonb order by p.played_at desc), '[]'::jsonb)
  into v_plays
  from (
    select pe.id, pe.played_at, pe.track_id,
      coalesce(t.name, pe.track_id) as track,
      coalesce(al.name, '') as album,
      coalesce(al.name, '') as playlist_name,
      to_char(al.release_date, 'YYYY') as album_year,
      al.id::text as album_id,
      coalesce(ar.name, 'Unknown Artist') as artist,
      ar.id::text as artist_id,
      t.duration_ms, pe.duration_played_ms,
      coalesce(pe.rating_at_close, pe.rating_at_play) as rating,
      coalesce(pe.source, 'video') as source,
      (
        select 'https://www.youtube.com/watch?v=' || tv.video_id
        from jukebox.track_videos tv
        where tv.track_id = t.id and tv.video_id is not null
        order by tv.is_primary desc nulls last, tv.view_count desc nulls last, tv.created_at asc
        limit 1
      ) as youtube_link,
      (
        select 'https://www.youtube.com/watch?v=' || tv.video_id
        from jukebox.track_videos tv
        where tv.track_id = t.id and tv.video_id is not null
        order by tv.is_primary desc nulls last, tv.view_count desc nulls last, tv.created_at asc
        offset 1 limit 1
      ) as secondary_youtube_link,
      case
        when ar.is_community is false then 'SufferingJukebox.Stream'
        else coalesce(ar.added_by_name, al.added_by_name)
      end as added_to_jukebox_by
    from jukebox.play_events pe
    left join jukebox.tracks t on t.id::text = pe.track_id
    left join jukebox.albums al on al.id = t.album_id
    left join jukebox.artists ar on ar.id = al.artist_id
    where pe.event_type = 'play'
      and lower(pe.user_email) = v_user
      and pe.played_at >= v_cut
      and pe.track_id <> 'test-verify'
  ) p;

  select coalesce(jsonb_agg(row_to_json(r)::jsonb), '[]'::jsonb)
  into v_ratings
  from (
    select distinct on (re.track_id)
      re.track_id,
      coalesce(t.name, re.track_id) as track,
      coalesce(ar.name, 'Unknown Artist') as artist,
      ar.id::text as artist_id,
      re.new_rating as rating,
      re.rated_at,
      (
        select coalesce(sum(v.latest_rating), 0)::bigint
        from (
          select distinct on (coalesce(re2.user_email, re2.ip_address))
            re2.new_rating as latest_rating
          from jukebox.rating_events re2
          where re2.track_id = re.track_id
          order by coalesce(re2.user_email, re2.ip_address), re2.rated_at desc
        ) v
        where v.latest_rating <> 0
      ) as jukebox_score
    from jukebox.rating_events re
    left join jukebox.tracks t on t.id::text = re.track_id
    left join jukebox.albums al on al.id = t.album_id
    left join jukebox.artists ar on ar.id = al.artist_id
    where lower(re.user_email) = v_user
    order by re.track_id, re.rated_at desc
  ) r;

  return jsonb_build_object('plays', v_plays, 'ratings', v_ratings, 'days', v_days);
end;
$function$;

-- Landing cards: global total_plays exclude Spotify; my_plays still include them.
create or replace function jukebox.landing_stats(p_user_email text default null)
returns table(
  artist_id uuid, name text, slug text, color text, is_community boolean,
  added_by_name text, created_at timestamp with time zone,
  album_count integer, track_count integer, total_views bigint, total_plays bigint,
  my_plays bigint, jukebox_score bigint, my_rating smallint, hidden boolean,
  member_ids uuid[], top_album_name text, top_album_art_url text, top_album_thumb text,
  visibility text, discography_complete boolean, can_manage boolean
)
language sql
stable
security definer
set search_path to 'jukebox', 'public'
as $function$
  with base_artist as (
    select a.id as artist_id, array[a.id] as member_ids,
           a.name, a.slug, a.color, a.is_community, a.added_by_name, a.created_at,
           a.visibility, a.discography_complete,
           case
             when jukebox.jwt_email() is null then false
             when jukebox.is_app_admin(jukebox.jwt_email()) then true
             else lower(jukebox.jwt_email()) = lower(nullif(a.added_by, ''))
           end as can_manage
    from jukebox.artists a
    where a.visibility = 'public'
       or exists (
         select 1 from jukebox.content_access ca
         where ca.artist_id = a.id
           and jukebox.jwt_email() is not null
           and lower(ca.user_email) = jukebox.jwt_email()
       )
  ),
  albums_f as (
    select al.id, al.artist_id, al.name, al.art_url
    from jukebox.albums al
    join base_artist ba on ba.artist_id = al.artist_id
    where al.name not ilike '%early times%'
  ),
  album_count_agg as (
    select artist_id, count(*)::int as album_count from albums_f group by artist_id
  ),
  track_ids as (
    select ba.artist_id, t.id as track_uuid, t.id::text as track_text
    from base_artist ba
    join albums_f al on al.artist_id = ba.artist_id
    join jukebox.tracks t on t.album_id = al.id
  ),
  views_agg as (
    select ti.artist_id,
           coalesce(sum(m.metric_value) filter (where m.metric_name = 'youtube_views'), 0)::bigint as total_views,
           count(distinct ti.track_uuid)::int as track_count
    from track_ids ti
    left join jukebox.metrics m on m.track_id = ti.track_uuid and m.metric_source = 'youtube'
    group by ti.artist_id
  ),
  plays_agg as (
    select ti.artist_id, count(*)::bigint as total_plays
    from track_ids ti
    join jukebox.play_events pe on pe.track_id = ti.track_text and pe.event_type = 'play'
      and (pe.source is null or pe.source in ('video', 'audio'))
    group by ti.artist_id
  ),
  my_plays_agg as (
    select ti.artist_id, count(*)::bigint as my_plays
    from track_ids ti
    join jukebox.play_events pe on pe.track_id = ti.track_text and pe.event_type = 'play'
      and jukebox.jwt_email() is not null
      and lower(pe.user_email) = jukebox.jwt_email()
    group by ti.artist_id
  ),
  latest_votes as (
    select distinct on (track_id, coalesce(user_email, ip_address))
      track_id, new_rating as latest_rating
    from jukebox.rating_events
    order by track_id, coalesce(user_email, ip_address), rated_at desc
  ),
  score_agg as (
    select ti.artist_id, coalesce(sum(lv.latest_rating), 0)::bigint as jukebox_score
    from track_ids ti
    join latest_votes lv on lv.track_id = ti.track_text and lv.latest_rating != 0
    group by ti.artist_id
  ),
  my_pref as (
    select artist_id, vote as my_rating, hidden
    from jukebox.feedback
    where target_type = 'artist'
      and jukebox.jwt_email() is not null
      and lower(user_email) = jukebox.jwt_email()
  ),
  album_stats as (
    select al.id as album_id, al.artist_id, al.name as album_name, al.art_url,
           coalesce(sum(m.metric_value) filter (where m.metric_name = 'youtube_views'), 0)::bigint as album_views
    from albums_f al
    left join jukebox.tracks t on t.album_id = al.id
    left join jukebox.metrics m on m.track_id = t.id and m.metric_source = 'youtube'
    group by al.id, al.artist_id, al.name, al.art_url
  ),
  top_album as (
    select album_id, artist_id, album_name, art_url from (
      select *, row_number() over (partition by artist_id order by album_views desc, album_name asc) as rn
      from album_stats
    ) x where rn = 1
  ),
  track_views as (
    select t.id as track_id, t.album_id,
           coalesce(sum(m.metric_value) filter (where m.metric_name = 'youtube_views'), 0)::bigint as views,
           max(m.metric_text_value) filter (where m.metric_name = 'youtube_thumbnail') as thumb
    from top_album ta
    join jukebox.tracks t on t.album_id = ta.album_id
    left join jukebox.metrics m on m.track_id = t.id and m.metric_source = 'youtube'
    group by t.id, t.album_id
  ),
  top_track as (
    select album_id, thumb from (
      select *, row_number() over (partition by album_id order by views desc) as rn
      from track_views
    ) x where rn = 1
  )
  select
    ba.artist_id, ba.name, ba.slug, ba.color, ba.is_community, ba.added_by_name, ba.created_at,
    coalesce(ac.album_count, 0),
    coalesce(va.track_count, 0),
    coalesce(va.total_views, 0),
    coalesce(pa.total_plays, 0),
    coalesce(mpa.my_plays, 0),
    coalesce(sa.jukebox_score, 0),
    mp.my_rating,
    coalesce(mp.hidden, false),
    ba.member_ids,
    ta.album_name,
    ta.art_url,
    tt.thumb,
    ba.visibility,
    ba.discography_complete,
    ba.can_manage
  from base_artist ba
  left join album_count_agg ac on ac.artist_id = ba.artist_id
  left join views_agg va on va.artist_id = ba.artist_id
  left join plays_agg pa on pa.artist_id = ba.artist_id
  left join my_plays_agg mpa on mpa.artist_id = ba.artist_id
  left join score_agg sa on sa.artist_id = ba.artist_id
  left join my_pref mp on mp.artist_id = ba.artist_id
  left join top_album ta on ta.artist_id = ba.artist_id
  left join top_track tt on tt.album_id = ta.album_id
  order by ba.name;
$function$;
