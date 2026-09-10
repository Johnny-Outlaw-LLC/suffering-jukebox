-- Three playlists worth putting in front of a first-time visitor.
--
-- Listening Party leads with playlists, so its landing page needs something to
-- lead with. One function rather than three queries: the picks have to be
-- distinct from each other, which cannot be decided a row at a time.
--
--   new      the most recently made public playlist
--   youtube  the most-watched, by YouTube view counts on the songs in it
--   hot      the most played ON OUR SITES in the last 30 days
--
-- "our sites" is both brands at once and needs no union: Suffering Jukebox and
-- Listening Party write to the same jukebox.play_events. Spotify rows are
-- excluded because an imported listening history is not somebody pressing play
-- here, the same rule global track_play_counts already follows.

create or replace function jukebox.featured_playlists()
returns table (
  pick          text,
  playlist_id   uuid,
  name          text,
  slug          text,
  user_name     text,
  track_count   int,
  created_at    timestamptz,
  yt_views      bigint,
  plays_30d     bigint,
  art_urls      text[]
)
language sql
stable
security definer
set search_path = jukebox, public
as $$
  with public_pl as (
    select p.id, p.name, p.slug, p.user_name, p.created_at
    from jukebox.playlists p
    where p.visibility = 'public'
  ),
  counts as (
    select pt.playlist_id, count(*)::int as track_count
    from jukebox.playlist_tracks pt
    join public_pl p on p.id = pt.playlist_id
    group by 1
  ),
  yt as (
    -- The primary version only. Summing every alternate would count one song
    -- several times, the same trap the charts avoid with tvTop().
    select pt.playlist_id, sum(tv.view_count)::bigint as yt_views
    from jukebox.playlist_tracks pt
    join jukebox.track_videos tv
      on tv.track_id = pt.track_id::uuid
     and tv.is_primary
     and coalesce(tv.is_playable, true)
    group by 1
  ),
  hot as (
    select pt.playlist_id, count(*)::bigint as plays_30d
    from jukebox.playlist_tracks pt
    join jukebox.play_events pe on pe.track_id = pt.track_id
    where coalesce(pe.source, 'jukebox') <> 'spotify'
      and pe.played_at > now() - interval '30 days'
    group by 1
  ),
  art as (
    -- Up to four covers, for the card. distinct on keeps one per album so a
    -- single-album playlist does not render the same sleeve four times.
    select pt.playlist_id, array_agg(u order by u) filter (where u is not null) as art_urls
    from (
      select distinct on (pt.playlist_id, al.id)
             pt.playlist_id, al.art_url as u, al.id
      from jukebox.playlist_tracks pt
      join jukebox.tracks t on t.id = pt.track_id::uuid
      join jukebox.albums al on al.id = t.album_id
      where al.art_url is not null
      order by pt.playlist_id, al.id, pt.position
    ) pt
    group by 1
  ),
  scored as (
    select p.id, p.name, p.slug, p.user_name, p.created_at,
           coalesce(c.track_count, 0)  as track_count,
           coalesce(y.yt_views, 0)     as yt_views,
           coalesce(h.plays_30d, 0)    as plays_30d,
           coalesce(a.art_urls[1:4], '{}') as art_urls
    from public_pl p
    left join counts c on c.playlist_id = p.id
    left join yt     y on y.playlist_id = p.id
    left join hot    h on h.playlist_id = p.id
    left join art    a on a.playlist_id = p.id
    -- A playlist with nothing in it is not worth featuring.
    where coalesce(c.track_count, 0) > 0
  ),
  ranked as (
    select s.*,
           row_number() over (order by s.created_at desc) rn_new,
           row_number() over (order by s.yt_views  desc)  rn_yt,
           row_number() over (order by s.plays_30d desc)  rn_hot
    from scored s
  ),
  -- Picked in order, each skipping anything already taken, so the page never
  -- shows the same playlist three times over.
  p_new as (select * from ranked order by rn_new limit 1),
  p_yt  as (select * from ranked where id not in (select id from p_new)
            order by rn_yt limit 1),
  p_hot as (select * from ranked
            where id not in (select id from p_new union all select id from p_yt)
            order by rn_hot limit 1)
  select 'new'::text, id, name, slug, user_name, track_count, created_at, yt_views, plays_30d, art_urls from p_new
  union all
  select 'youtube', id, name, slug, user_name, track_count, created_at, yt_views, plays_30d, art_urls from p_yt
  union all
  select 'hot', id, name, slug, user_name, track_count, created_at, yt_views, plays_30d, art_urls from p_hot;
$$;

-- security definer because play_events is not readable by anon, and a landing
-- page must work signed out. The function only ever reads public playlists.
revoke all on function jukebox.featured_playlists() from public;
grant execute on function jukebox.featured_playlists() to anon, authenticated;
