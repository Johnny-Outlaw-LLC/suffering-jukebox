-- Private catalogue is the importer's alone. content_access has been used to
-- decide who can see a private artist, but stale grants (e.g. an admin email
-- left on someone else's private import) leaked those artists into Explore.
-- Visibility now keys off artists.added_by. content_access stays as the
-- "artists I brought in" ledger for public imports and tooling.

delete from jukebox.content_access ca
using jukebox.artists a
where a.id = ca.artist_id
  and a.visibility = 'private'
  and lower(ca.user_email) <> lower(coalesce(a.added_by, ''));

create or replace function jukebox.landing_stats(p_user_email text default null)
returns table(
  artist_id uuid, name text, slug text, color text, is_community boolean,
  added_by_name text, created_at timestamp with time zone,
  album_count integer, track_count integer, total_views bigint, total_plays bigint,
  my_plays bigint, jukebox_score bigint, my_rating smallint, hidden boolean,
  member_ids uuid[], top_album_name text, top_album_art_url text, top_album_thumb text,
  visibility text, discography_complete boolean, can_manage boolean, in_my_library boolean
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
           jukebox.can_manage_artist(a.id) as can_manage
    from jukebox.artists a
    where a.visibility = 'public'
       or (
         jukebox.jwt_email() is not null
         and lower(nullif(a.added_by, '')) = jukebox.jwt_email()
       )
  ),
  my_library as (
    select distinct al.artist_id
    from jukebox.my_jukebox_items mi
    join jukebox.jukeboxes j on j.id = mi.jukebox_id
    join jukebox.tracks t on t.id = mi.catalog_track_id
    join jukebox.albums al on al.id = t.album_id
    where jukebox.jwt_email() is not null
      and lower(j.owner_email) = jukebox.jwt_email()
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
  vote_score_agg as (
    select ti.artist_id,
      coalesce(sum(
        case lv.latest_rating
          when 2 then 12
          when 1 then 5
          when -1 then -3
          else 0
        end
      ), 0)::bigint as vote_pts
    from track_ids ti
    left join latest_votes lv on lv.track_id = ti.track_text and lv.latest_rating != 0
    group by ti.artist_id
  ),
  reaction_score_agg as (
    select ti.artist_id, count(*)::bigint as reaction_pts
    from track_ids ti
    join jukebox.track_reactions tr on tr.track_id = ti.track_uuid
      and tr.reaction in ('heart', 'sad')
    group by ti.artist_id
  ),
  score_agg as (
    select ba.artist_id,
      (coalesce(vs.vote_pts, 0) + coalesce(rs.reaction_pts, 0))::bigint as jukebox_score
    from base_artist ba
    left join vote_score_agg vs on vs.artist_id = ba.artist_id
    left join reaction_score_agg rs on rs.artist_id = ba.artist_id
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
    ba.can_manage,
    (ml.artist_id is not null) as in_my_library
  from base_artist ba
  left join album_count_agg ac on ac.artist_id = ba.artist_id
  left join views_agg va on va.artist_id = ba.artist_id
  left join plays_agg pa on pa.artist_id = ba.artist_id
  left join my_plays_agg mpa on mpa.artist_id = ba.artist_id
  left join score_agg sa on sa.artist_id = ba.artist_id
  left join my_pref mp on mp.artist_id = ba.artist_id
  left join top_album ta on ta.artist_id = ba.artist_id
  left join top_track tt on tt.album_id = ta.album_id
  left join my_library ml on ml.artist_id = ba.artist_id
  order by ba.name;
$function$;

grant execute on function jukebox.landing_stats(text) to anon, authenticated;
