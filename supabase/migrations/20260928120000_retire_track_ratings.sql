-- Track ratings are retired from the product. Keep their tables and history so
-- old data remains recoverable, but every live score now counts hearts only.

create or replace function jukebox.get_track_vote_scores()
returns table(track_id text, net_score bigint)
language sql
stable
security definer
set search_path to 'jukebox'
as $function$
  select tr.track_id::text, count(*)::bigint as net_score
  from jukebox.track_reactions tr
  where tr.reaction = 'heart'
  group by tr.track_id;
$function$;

grant execute on function jukebox.get_track_vote_scores() to anon, authenticated, service_role;

-- Preserve the mature visibility/library implementation and wrap it only to
-- replace its legacy rating-weighted score. This deliberately does not merge
-- old thumbs into hearts.
alter function jukebox.landing_stats(text) rename to landing_stats_with_legacy_ratings;

create function jukebox.landing_stats(p_user_email text default null)
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
  with heart_totals as (
    select al.artist_id, count(*)::bigint as hearts
    from jukebox.track_reactions tr
    join jukebox.tracks t on t.id = tr.track_id
    join jukebox.albums al on al.id = t.album_id
    where tr.reaction = 'heart'
    group by al.artist_id
  )
  select
    s.artist_id, s.name, s.slug, s.color, s.is_community,
    s.added_by_name, s.created_at,
    s.album_count, s.track_count, s.total_views, s.total_plays,
    s.my_plays, coalesce(h.hearts, 0)::bigint, s.my_rating, s.hidden,
    s.member_ids, s.top_album_name, s.top_album_art_url, s.top_album_thumb,
    s.visibility, s.discography_complete, s.can_manage, s.in_my_library
  from jukebox.landing_stats_with_legacy_ratings(p_user_email) s
  left join heart_totals h on h.artist_id = s.artist_id
  order by s.name;
$function$;

grant execute on function jukebox.landing_stats(text) to anon, authenticated;
