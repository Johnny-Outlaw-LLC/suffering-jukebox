alter table jukebox.app_users
  add column if not exists user_level text;

update jukebox.app_users
set user_level = case
  when is_admin or lower(email) = 'johnnyoutlawllc@gmail.com' then 'admin'
  else 'free'
end
where user_level is null;

alter table jukebox.app_users
  alter column user_level set default 'free',
  alter column user_level set not null;

alter table jukebox.app_users
  drop constraint if exists app_users_user_level_check;

alter table jukebox.app_users
  add constraint app_users_user_level_check
  check (user_level in ('free', 'standard', 'premium', 'admin'));

create or replace function jukebox.set_app_user_level(p_email text, p_level text)
returns void
language plpgsql
security definer
set search_path = jukebox
as $function$
declare
  normalized_email text := lower(btrim(p_email));
  normalized_level text := lower(btrim(p_level));
  quota_bytes bigint;
begin
  if normalized_level not in ('free', 'standard', 'premium', 'admin') then
    raise exception 'Invalid user level';
  end if;

  if normalized_email = 'johnnyoutlawllc@gmail.com' then
    normalized_level := 'admin';
  end if;

  quota_bytes := case normalized_level
    when 'standard' then 524288000::bigint
    when 'premium' then 2147483648::bigint
    when 'admin' then 10737418240::bigint
    else 0::bigint
  end;

  insert into jukebox.app_users (email, is_admin, user_level, last_seen_at)
  values (normalized_email, normalized_level = 'admin', normalized_level, now())
  on conflict (email) do update
  set is_admin = excluded.is_admin,
      user_level = excluded.user_level,
      last_seen_at = excluded.last_seen_at;

  update jukebox.bg_entitlements e
  set storage_bytes_limit = quota_bytes,
      updated_at = now()
  from auth.users au
  where au.id = e.user_id
    and lower(au.email) = normalized_email;
end;
$function$;

revoke all on function jukebox.set_app_user_level(text, text) from public, anon, authenticated;
grant execute on function jukebox.set_app_user_level(text, text) to service_role;

drop function if exists jukebox.admin_users_list();

create function jukebox.admin_users_list()
returns table(
  email text,
  user_id uuid,
  user_name text,
  is_admin boolean,
  user_level text,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  visit_count bigint,
  rating_count bigint,
  play_count bigint,
  upload_count bigint,
  storage_bytes_used bigint,
  storage_bytes_limit bigint,
  uploaded_artists jsonb
)
language sql
stable
security definer
set search_path = jukebox
as $function$
  with all_emails as (
    select distinct lower(user_email) as email from jukebox.page_views where user_email is not null and btrim(user_email) <> ''
    union select distinct lower(user_email) from jukebox.play_events where user_email is not null and btrim(user_email) <> ''
    union select distinct lower(user_email) from jukebox.rating_events where user_email is not null and btrim(user_email) <> ''
    union select distinct lower(user_email) from jukebox.feedback where user_email is not null and btrim(user_email) <> ''
    union select lower(email) from jukebox.app_users
    union select lower(email) from auth.users where email is not null and btrim(email) <> ''
    union select distinct lower(uploader_email) from jukebox.track_audio where uploader_email is not null and btrim(uploader_email) <> ''
  ),
  auth_map as (
    select distinct on (lower(email)) lower(email) as email, id as user_id
    from auth.users
    where email is not null
    order by lower(email), created_at desc
  ),
  visits as (
    select lower(user_email) as email, count(*)::bigint as cnt from jukebox.page_views where user_email is not null group by 1
  ),
  ratings as (
    select email, sum(cnt)::bigint as cnt from (
      select lower(user_email) as email, count(*)::bigint as cnt from jukebox.rating_events where user_email is not null group by 1
      union all
      select lower(user_email), count(*)::bigint from jukebox.feedback where user_email is not null and vote is not null group by 1
    ) x group by email
  ),
  plays as (
    select lower(user_email) as email, count(*)::bigint as cnt
    from jukebox.play_events where user_email is not null and event_type = 'play' group by 1
  ),
  usage as (
    select uploaded_by as user_id, count(*)::bigint as upload_count,
           coalesce(sum(file_bytes), 0)::bigint as storage_bytes_used
    from jukebox.track_audio
    group by uploaded_by
  ),
  artist_stats as (
    select ta.uploaded_by as user_id,
           coalesce(ar.name, 'Unknown artist') as artist_name,
           count(*)::bigint as upload_count,
           coalesce(sum(ta.file_bytes), 0)::bigint as storage_bytes
    from jukebox.track_audio ta
    left join jukebox.tracks t on t.id::text = ta.track_id
    left join jukebox.albums al on al.id = t.album_id
    left join jukebox.artists ar on ar.id = al.artist_id
    group by ta.uploaded_by, coalesce(ar.name, 'Unknown artist')
  ),
  artist_rollup as (
    select user_id,
           jsonb_agg(
             jsonb_build_object(
               'name', artist_name,
               'upload_count', upload_count,
               'storage_bytes', storage_bytes
             ) order by artist_name
           ) as uploaded_artists
    from artist_stats
    group by user_id
  ),
  base as (
    select
      ae.email,
      am.user_id,
      coalesce(u.user_name, split_part(ae.email, '@', 1)) as user_name,
      coalesce(u.is_admin, false) or ae.email = 'johnnyoutlawllc@gmail.com' as is_admin,
      case
        when coalesce(u.is_admin, false) or ae.email = 'johnnyoutlawllc@gmail.com' then 'admin'
        when u.user_level in ('standard', 'premium') then u.user_level
        when be.user_id is not null then 'standard'
        else 'free'
      end as user_level,
      coalesce(u.first_seen_at, now()) as first_seen_at,
      coalesce(u.last_seen_at, now()) as last_seen_at,
      coalesce(v.cnt, 0)::bigint as visit_count,
      coalesce(r.cnt, 0)::bigint as rating_count,
      coalesce(p.cnt, 0)::bigint as play_count,
      coalesce(us.upload_count, 0)::bigint as upload_count,
      coalesce(us.storage_bytes_used, 0)::bigint as storage_bytes_used,
      coalesce(ar.uploaded_artists, '[]'::jsonb) as uploaded_artists
    from all_emails ae
    left join jukebox.app_users u on lower(u.email) = ae.email
    left join auth_map am on am.email = ae.email
    left join jukebox.bg_entitlements be on be.user_id = am.user_id
    left join visits v on v.email = ae.email
    left join ratings r on r.email = ae.email
    left join plays p on p.email = ae.email
    left join usage us on us.user_id = am.user_id
    left join artist_rollup ar on ar.user_id = am.user_id
  )
  select
    b.email,
    b.user_id,
    b.user_name,
    b.is_admin,
    b.user_level,
    b.first_seen_at,
    b.last_seen_at,
    b.visit_count,
    b.rating_count,
    b.play_count,
    b.upload_count,
    b.storage_bytes_used,
    case b.user_level
      when 'standard' then 524288000::bigint
      when 'premium' then 2147483648::bigint
      when 'admin' then 10737418240::bigint
      else 0::bigint
    end as storage_bytes_limit,
    b.uploaded_artists
  from base b
  order by b.visit_count desc, b.email;
$function$;

revoke all on function jukebox.admin_users_list() from public, anon, authenticated;
grant execute on function jukebox.admin_users_list() to service_role;

update jukebox.bg_entitlements e
set storage_bytes_limit = case
      when lower(au.email) = 'johnnyoutlawllc@gmail.com' or coalesce(ap.is_admin, false) then 10737418240::bigint
      when ap.user_level = 'premium' then 2147483648::bigint
      else 524288000::bigint
    end,
    updated_at = now()
from auth.users au
left join jukebox.app_users ap on lower(ap.email) = lower(au.email)
where au.id = e.user_id;
