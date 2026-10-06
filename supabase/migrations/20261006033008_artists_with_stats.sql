-- Private artist picker: at least one genuine recorded play, across all sites
-- and all time. Use the same eligibility rules as artist_stats all_time_plays.
-- Record Keeper currently shares LP's playback surface; neither query filters
-- by surface_id, so SJ, LP, RK, and older unattributed plays are all included.
create or replace function jukebox.artists_with_stats(p_artist_ids uuid[] default null)
returns table(id uuid, name text, slug text)
language sql
stable
security invoker
set search_path = ''
as $function$
  select a.id, a.name::text, a.slug::text
    from jukebox.artists a
   where nullif(a.slug, '') is not null
     and (p_artist_ids is null or a.id = any(p_artist_ids))
     and exists (
       select 1 from jukebox.play_events p
        where p.artist_id = a.id::text
          and p.event_type = 'play'
          and coalesce(p.deleted, false) = false
          and p.source is distinct from 'spotify'
     )
   order by a.name, a.id;
$function$;

revoke all on function jukebox.artists_with_stats(uuid[]) from public, anon, authenticated;
grant execute on function jukebox.artists_with_stats(uuid[]) to service_role;
