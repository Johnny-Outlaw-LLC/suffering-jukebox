-- Jukebox Score: weighted ratings + heart/heartbreak reactions.
-- thumbs up +5, double thumbs up +12, thumbs down -3, each heart/heartbreak +1.

CREATE OR REPLACE FUNCTION jukebox.get_track_vote_scores()
 RETURNS TABLE(track_id text, net_score bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'jukebox'
AS $function$
  with latest_votes as (
    select distinct on (track_id, coalesce(user_email, ip_address))
      track_id,
      new_rating as latest_rating
    from jukebox.rating_events
    order by track_id, coalesce(user_email, ip_address), rated_at desc
  ),
  vote_points as (
    select
      track_id,
      sum(
        case latest_rating
          when 2 then 12
          when 1 then 5
          when -1 then -3
          else 0
        end
      )::bigint as pts
    from latest_votes
    where latest_rating != 0
    group by track_id
  ),
  reaction_points as (
    select
      track_id::text as track_id,
      count(*)::bigint as pts
    from jukebox.track_reactions
    where reaction in ('heart', 'sad')
    group by track_id
  )
  select
    coalesce(v.track_id, r.track_id) as track_id,
    (coalesce(v.pts, 0) + coalesce(r.pts, 0)) as net_score
  from vote_points v
  full outer join reaction_points r on r.track_id = v.track_id
  where (coalesce(v.pts, 0) + coalesce(r.pts, 0)) != 0;
$function$;

GRANT EXECUTE ON FUNCTION jukebox.get_track_vote_scores() TO anon, authenticated, service_role;

-- landing_stats.jukebox_score uses the same weighting (applied live in the
-- same migration via apply_migration). Keep vote/reaction points in sync with
-- get_track_vote_scores whenever this formula changes.
