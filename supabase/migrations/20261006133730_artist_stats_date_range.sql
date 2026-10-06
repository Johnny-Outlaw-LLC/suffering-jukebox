-- Range-aware private picker. The midnight boundary matches artist_stats.
-- Keep the original all-time RPC for existing clients during rollout.
create or replace function jukebox.artists_with_stats_in_range(
  p_artist_ids uuid[] default null,
  p_days integer default null,
  p_tz text default 'UTC'
)
returns table(id uuid, name text, slug text)
language sql stable security invoker set search_path = ''
as $function$
  with cfg as (
    select coalesce((select name from pg_timezone_names where name = p_tz limit 1), 'UTC') as tz
  ), win as (
    select (date_trunc('day', now() at time zone tz)
      - make_interval(days => greatest(1, least(coalesce(p_days, 30), 3650)) - 1)) at time zone tz as since
    from cfg
  )
  select a.id, a.name::text, a.slug::text
  from jukebox.artists a cross join win w
  where nullif(a.slug, '') is not null
    and (p_artist_ids is null or a.id = any(p_artist_ids))
    and exists (
      select 1 from jukebox.play_events p
      where p.artist_id = a.id::text and p.event_type = 'play'
        and coalesce(p.deleted, false) = false
        and p.source is distinct from 'spotify'
        and (p_days is null or p.played_at >= w.since)
    )
  order by a.name, a.id;
$function$;
revoke all on function jukebox.artists_with_stats_in_range(uuid[], integer, text) from public, anon, authenticated;
grant execute on function jukebox.artists_with_stats_in_range(uuid[], integer, text) to service_role;

-- Aggregate events before counting distinct listeners and visits. Never sum
-- artist totals: the same fan can listen to multiple artists. Null scope is
-- admin-only at the API gate; non-admin accounts pass their authorized IDs.
create or replace function jukebox.all_artist_stats(
  p_artist_ids uuid[] default null,
  p_days integer default 30,
  p_tz text default 'UTC'
)
returns jsonb
language sql
stable
security invoker
set search_path to 'jukebox'
as $function$
with
cfg as (
  select greatest(1, least(coalesce(p_days, 30), 3650)) as days,
         coalesce((select name from pg_timezone_names where name = p_tz limit 1), 'UTC') as tz
),
win as (
  select c.days, c.tz,
         (date_trunc('day', now() at time zone c.tz) - make_interval(days => c.days - 1)) at time zone c.tz as since,
         (date_trunc('day', now() at time zone c.tz) - make_interval(days => 2 * c.days - 1)) at time zone c.tz as prev_since
    from cfg c
),
art as (
  select a.id, a.name, a.slug from jukebox.artists a where p_artist_ids is null or a.id = any(p_artist_ids)
),
trk as (
  select t.id, t.id::text as tid, t.name, t.duration_ms, t.lyrics_synced,
         al.name as album_name, al.art_url, al.release_date,
         coalesce(t.disc_number, 1) as disc, coalesce(t.track_number, 0) as num
    from jukebox.tracks t
    join jukebox.albums al on al.id = t.album_id
   where al.artist_id in (select id from art)
),
pe as (
  -- Listen time only from plays that measured it properly: the web player's
  -- listen meter (any listen_context) or the native engine. Older web rows
  -- hold fragments - the time between a pause and a resume - not a listen.
  select p.track_id, p.played_at, p.source, p.surface_id, p.ip_address,
         case when p.listen_context is not null or p.device_id like 'carplay:%'
              then p.duration_played_ms end as duration_played_ms,
         coalesce(p.listen_context, case when p.device_id like 'carplay:%' then 'native' end) as ctx,
         coalesce(lower(nullif(p.user_email, '')), nullif(p.device_id, ''), nullif(p.ip_address, '')) as who,
         p.played_at >= w.since as is_cur
    from jukebox.play_events p
    cross join win w
   where p.artist_id in (select id::text from art)
     and p.event_type = 'play'
     and coalesce(p.deleted, false) = false
     and p.source is distinct from 'spotify'
     and p.played_at >= w.prev_since
),
cur as (select * from pe where is_cur),
hearts as (
  select r.track_id, r.position_ms
    from jukebox.track_reactions r
    join trk on trk.id = r.track_id
    cross join win w
   where r.reaction = 'heart' and r.created_at >= w.since
),
quotes as (
  select lr.track_id, lr.quote
    from jukebox.lyric_reactions lr
    join trk on trk.id = lr.track_id
    cross join win w
   where lr.created_at >= w.since and nullif(trim(lr.quote), '') is not null
),
adds as (
  select pt.track_id
    from jukebox.playlist_tracks pt
    join trk on trk.tid = pt.track_id
    cross join win w
   where pt.added_at >= w.since
),
visits as (
  select pv.referrer_host, pv.session_id
    from jukebox.page_views pv
    cross join win w
    cross join art a
   where pv.visited_at >= w.since
     and (pv.page_path = '/' || a.slug
          or pv.page_path like '/' || a.slug || '/%'
          or pv.page_path = '/artist-music/' || a.slug)
),
daily_agg as (
  select (c.played_at at time zone w.tz)::date as day, count(*) as plays, count(distinct c.who) as listeners
    from cur c cross join win w
   group by 1
),
song_plays as (
  select c.track_id,
         count(*) as plays,
         count(distinct c.who) as listeners,
         coalesce(sum(c.duration_played_ms), 0) as listen_ms,
         count(c.duration_played_ms) as timed,
         avg(least(c.duration_played_ms::numeric / t.duration_ms, 1))
           filter (where c.duration_played_ms is not null and t.duration_ms > 0) as completion
    from cur c join trk t on t.tid = c.track_id
   group by c.track_id
),
moment_buckets as (
  select h.track_id, (h.position_ms / 10000) * 10000 as start_ms, count(*) as n
    from hearts h
   where h.position_ms > 0
   group by 1, 2
),
moment_top as (
  select distinct on (track_id) track_id, start_ms, n
    from moment_buckets
   order by track_id, n desc, start_ms
),
ip_city as (
  select distinct on (pv.ip_address) pv.ip_address, pv.city, pv.country
    from jukebox.page_views pv
   where pv.ip_address in (select distinct ip_address from cur where ip_address is not null)
     and nullif(pv.city, '') is not null
   order by pv.ip_address, pv.visited_at desc
),
place_agg as (
  select ic.city, ic.country, count(distinct c.who) as listeners, count(*) as plays
    from cur c join ip_city ic on ic.ip_address = c.ip_address
   group by 1, 2
)
select jsonb_build_object(
  'artist', jsonb_build_object('id', 'all', 'name', 'All Artists', 'slug', ''),
  'range', (select jsonb_build_object('days', w.days, 'since', w.since, 'tz', w.tz) from win w),
  'totals', jsonb_build_object(
    'plays', (select count(*) from cur),
    'listeners', (select count(distinct who) from cur),
    'returning_listeners', (
      select count(*) from (
        select c.who from cur c cross join win w
         group by c.who having count(distinct (c.played_at at time zone w.tz)::date) >= 2) x),
    'listen_ms', (select coalesce(sum(duration_played_ms), 0) from cur),
    'timed_plays', (select count(duration_played_ms) from cur),
    'prev_plays', (select count(*) from pe where not is_cur),
    'prev_listeners', (select count(distinct who) from pe where not is_cur),
    'hearts', (select count(*) from hearts),
    'quotes', (select count(*) from quotes),
    'playlist_adds', (select count(*) from adds),
    'page_visits', (select count(distinct session_id) from visits),
    'all_time_plays', (
      select count(*) from jukebox.play_events p
       where p.artist_id in (select id::text from art) and p.event_type = 'play'
         and coalesce(p.deleted, false) = false and p.source is distinct from 'spotify'),
    'tracks', (select count(*) from trk)
  ),
  'daily', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'day', g.day, 'plays', coalesce(d.plays, 0), 'listeners', coalesce(d.listeners, 0))
             order by g.day), '[]'::jsonb)
      from win w
      cross join lateral (
        select gs::date as day
          from generate_series((w.since at time zone w.tz)::date, (now() at time zone w.tz)::date, interval '1 day') gs
      ) g
      left join daily_agg d on d.day = g.day
  ),
  'songs', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'track_id', t.tid, 'name', t.name, 'album', t.album_name, 'art_url', t.art_url,
             'duration_ms', t.duration_ms,
             'plays', coalesce(sp.plays, 0), 'listeners', coalesce(sp.listeners, 0),
             'listen_ms', coalesce(sp.listen_ms, 0), 'timed_plays', coalesce(sp.timed, 0),
             'completion', round(sp.completion, 3),
             'hearts', (select count(*) from hearts h where h.track_id = t.id),
             'quotes', (select count(*) from quotes q where q.track_id = t.id),
             'playlist_adds', (select count(*) from adds ad where ad.track_id = t.tid))
             order by coalesce(sp.plays, 0) desc, t.release_date desc nulls last, t.disc, t.num), '[]'::jsonb)
      from trk t
      left join song_plays sp on sp.track_id = t.tid
     where sp.plays > 0
        or exists (select 1 from hearts h where h.track_id = t.id)
        or exists (select 1 from quotes q where q.track_id = t.id)
        or exists (select 1 from adds ad where ad.track_id = t.tid)
  ),
  'moments', (
    select coalesce(jsonb_agg(m order by (m ->> 'n')::int desc), '[]'::jsonb)
      from (
        select jsonb_build_object(
                 'track_id', t.tid, 'name', t.name, 'duration_ms', t.duration_ms,
                 'start_ms', mt.start_ms, 'n', mt.n,
                 'total', (select count(*) from hearts h where h.track_id = t.id),
                 'buckets', (select jsonb_agg(jsonb_build_object('s', b.start_ms, 'n', b.n) order by b.start_ms)
                               from moment_buckets b where b.track_id = t.id),
                 'lyrics_synced', t.lyrics_synced) as m
          from moment_top mt
          join trk t on t.id = mt.track_id
         order by mt.n desc
         limit 8
      ) x
  ),
  'quotes', (
    select coalesce(jsonb_agg(jsonb_build_object('track_id', x.track_id, 'name', x.name, 'quote', x.quote, 'n', x.n)
                              order by x.n desc), '[]'::jsonb)
      from (
        select t.tid as track_id, t.name, q.quote, count(*) as n
          from quotes q join trk t on t.id = q.track_id
         group by 1, 2, 3
         order by n desc
         limit 10
      ) x
  ),
  'contexts', (
    select coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
      from (select coalesce(ctx, 'unknown') as k, count(*) as n from cur group by 1) x
  ),
  'surfaces', (
    select coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
      from (select coalesce(surface_id, 'unknown') as k, count(*) as n from cur group by 1) x
  ),
  'sources', (
    select coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
      from (select coalesce(source, 'video') as k, count(*) as n from cur group by 1) x
  ),
  'places', jsonb_build_object(
    'top', (
      select coalesce(jsonb_agg(jsonb_build_object('city', city, 'country', country,
                                                   'listeners', listeners, 'plays', plays)
                                order by listeners desc, plays desc), '[]'::jsonb)
        from (select * from place_agg where listeners >= 3 order by listeners desc, plays desc limit 12) x),
    'other_listeners', (select coalesce(sum(listeners), 0) from place_agg where listeners < 3),
    'unlocated_listeners', (
      select count(distinct c.who) from cur c
       where not exists (select 1 from ip_city ic where ic.ip_address = c.ip_address))
  ),
  'referrers', (
    select coalesce(jsonb_agg(jsonb_build_object('host', host, 'visits', visits) order by visits desc), '[]'::jsonb)
      from (
        select coalesce(nullif(lower(referrer_host), ''), '(direct)') as host,
               count(distinct session_id) as visits
          from visits group by 1
      ) x
  ),
  'context_since', (select min(played_at) from jukebox.play_events where listen_context in ('web', 'web_background', 'app', 'app_background'))
)
;
$function$;

revoke all on function jukebox.all_artist_stats(uuid[], integer, text) from public, anon, authenticated;
grant execute on function jukebox.all_artist_stats(uuid[], integer, text) to service_role;
