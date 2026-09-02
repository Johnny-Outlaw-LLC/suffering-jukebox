-- What's New additions: full imports keep the artist card; everything else
-- reads as songs added by an artist.

drop function if exists jukebox.public_artist_additions(integer);

create or replace function jukebox.public_artist_additions(p_limit integer default 60)
returns table(
  kind text,
  at timestamp with time zone,
  artist_name text,
  album_name text,
  added_by text,
  slug text,
  n integer,
  full_import boolean
)
language sql
stable
security definer
set search_path to 'jukebox', 'public'
as $function$
  (
    select 'full_artist'::text,
           a.created_at,
           a.name,
           null::text,
           jukebox.whats_new_display_name(a.added_by, a.added_by_name),
           a.slug,
           (
             select count(*)::integer
             from jukebox.albums al
             where al.artist_id = a.id
               and coalesce(al.visibility, 'public') = 'public'
           ),
           true
    from jukebox.artists a
    where a.created_at is not null
      and coalesce(a.visibility, 'public') = 'public'
      and coalesce(a.discography_complete, false) = true
  )
  union all
  (
    select 'songs'::text,
           a.created_at,
           a.name,
           (
             select al.name
             from jukebox.albums al
             where al.artist_id = a.id
               and coalesce(al.visibility, 'public') = 'public'
             order by al.created_at asc
             limit 1
           ),
           jukebox.whats_new_display_name(a.added_by, a.added_by_name),
           a.slug,
           (
             select count(*)::integer
             from jukebox.tracks t
             join jukebox.albums al on al.id = t.album_id
             where al.artist_id = a.id
               and coalesce(al.visibility, 'public') = 'public'
               and coalesce(t.visibility, 'public') = 'public'
           ),
           false
    from jukebox.artists a
    where a.created_at is not null
      and coalesce(a.visibility, 'public') = 'public'
      and coalesce(a.discography_complete, false) = false
      and exists (
        select 1
        from jukebox.tracks t
        join jukebox.albums al on al.id = t.album_id
        where al.artist_id = a.id
          and coalesce(al.visibility, 'public') = 'public'
          and coalesce(t.visibility, 'public') = 'public'
      )
  )
  union all
  (
    select 'songs'::text,
           max(al.created_at),
           ar.name,
           (array_agg(al.name order by al.created_at))[1],
           jukebox.whats_new_display_name(
             (array_agg(al.added_by order by al.created_at))[1],
             (array_agg(al.added_by_name order by al.created_at))[1]
           ),
           ar.slug,
           (
             select count(*)::integer
             from jukebox.tracks t
             where t.album_id = any(array_agg(al.id))
               and coalesce(t.visibility, 'public') = 'public'
           ),
           false
    from jukebox.albums al
    join jukebox.artists ar on ar.id = al.artist_id
    where al.created_at is not null
      and nullif(btrim(al.added_by), '') is not null
      and coalesce(ar.visibility, 'public') = 'public'
      and coalesce(al.visibility, 'public') = 'public'
      and (
        ar.created_at < date_trunc('hour', al.created_at) - interval '1 hour'
        or lower(coalesce(ar.added_by, '')) <> lower(al.added_by)
      )
    group by ar.name, ar.slug, lower(al.added_by), date_trunc('hour', al.created_at)
    having (
      select count(*)::integer
      from jukebox.tracks t
      where t.album_id = any(array_agg(al.id))
        and coalesce(t.visibility, 'public') = 'public'
    ) > 0
  )
  order by 2 desc
  limit greatest(1, least(coalesce(p_limit, 60), 200));
$function$;
