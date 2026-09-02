-- What's New: public catalogue only, and the name you chose in Settings.

create or replace function jukebox.whats_new_display_name(p_email text, p_fallback text default null)
returns text
language sql
stable
set search_path to 'jukebox', 'public'
as $function$
  select coalesce(
    nullif(btrim(u.public_name), ''),
    nullif(btrim(u.user_name), ''),
    nullif(btrim(p_fallback), ''),
    nullif(split_part(coalesce(p_email, ''), '@', 1), '')
  )
  from (select 1) x
  left join jukebox.app_users u on lower(u.email) = lower(nullif(btrim(p_email), ''));
$function$;

create or replace function jukebox.public_artist_additions(p_limit integer default 60)
returns table(
  kind text,
  at timestamp with time zone,
  artist_name text,
  album_name text,
  added_by text,
  slug text,
  n integer
)
language sql
stable
security definer
set search_path to 'jukebox', 'public'
as $function$
  (
    select 'artist'::text, a.created_at, a.name, null::text,
           jukebox.whats_new_display_name(a.added_by, a.added_by_name),
           a.slug, 1
    from jukebox.artists a
    where a.created_at is not null
      and coalesce(a.visibility, 'public') = 'public'
  )
  union all
  (
    select 'album'::text, max(al.created_at), ar.name,
           (array_agg(al.name order by al.created_at))[1],
           jukebox.whats_new_display_name(
             (array_agg(al.added_by order by al.created_at))[1],
             (array_agg(al.added_by_name order by al.created_at))[1]
           ),
           ar.slug, count(*)::integer
    from jukebox.albums al
    join jukebox.artists ar on ar.id = al.artist_id
    where al.created_at is not null
      and nullif(btrim(al.added_by), '') is not null
      and coalesce(ar.visibility, 'public') = 'public'
      and coalesce(al.visibility, 'public') = 'public'
    group by ar.name, ar.slug, lower(al.added_by), date_trunc('hour', al.created_at)
  )
  order by 2 desc
  limit greatest(1, least(coalesce(p_limit, 60), 200));
$function$;

create or replace function jukebox.public_comment_feed(p_limit integer default 60)
returns table(
  id uuid,
  at timestamp with time zone,
  target_type text,
  artist_id uuid,
  album_id uuid,
  track_id uuid,
  artist_name text,
  album_name text,
  track_name text,
  body text,
  author_name text,
  ref_position_ms integer,
  lyric_quote text
)
language sql
stable
security definer
set search_path to 'jukebox', 'public'
as $function$
  select c.id, c.created_at, c.target_type,
         c.artist_id, c.album_id, c.track_id,
         c.artist_name, c.album_name, c.track_name,
         c.body,
         case when c.is_anonymous then 'Anonymous'
              else jukebox.whats_new_display_name(c.user_email, c.user_name) end,
         c.ref_position_ms, c.lyric_quote
  from jukebox.comments c
  left join jukebox.artists ar on ar.id = c.artist_id
  left join jukebox.albums al on al.id = c.album_id
  left join jukebox.tracks t on t.id = c.track_id
  left join jukebox.albums tal on tal.id = t.album_id
  left join jukebox.artists tar on tar.id = coalesce(ar.id, al.artist_id, tal.artist_id)
  where c.is_public
    and not c.hidden
    and (tar.id is null or coalesce(tar.visibility, 'public') = 'public')
    and (al.id is null or coalesce(al.visibility, 'public') = 'public')
    and (t.id is null or coalesce(t.visibility, 'public') = 'public')
  order by c.created_at desc
  limit greatest(1, least(coalesce(p_limit, 60), 200));
$function$;

create or replace function jukebox.public_issue_updates(p_limit integer default 40)
returns table(
  at timestamp with time zone,
  kind text,
  category text,
  track_name text,
  artist_name text,
  album_name text,
  detail text,
  resolved boolean
)
language sql
stable
security definer
set search_path to 'jukebox', 'public'
as $function$
  select e.at, e.kind, e.category, e.track_name, e.artist_name, e.album_name, e.detail,
         (e.kind in ('auto_fixed', 'auto_verified', 'admin_resolved')) as resolved
  from jukebox.issue_events e
  join jukebox.issues i on i.id = e.issue_id
  left join jukebox.tracks t on t.id = i.track_id
  left join jukebox.albums al on al.id = t.album_id
  left join jukebox.artists ar on ar.id = al.artist_id
  where jukebox.jwt_email() is not null
    and (ar.id is null or coalesce(ar.visibility, 'public') = 'public')
    and (al.id is null or coalesce(al.visibility, 'public') = 'public')
    and (t.id is null or coalesce(t.visibility, 'public') = 'public')
  order by e.at desc
  limit greatest(1, least(coalesce(p_limit, 40), 200));
$function$;
