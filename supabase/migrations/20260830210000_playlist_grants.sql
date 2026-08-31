-- Playlist capability grants: Public (Explore) and named people share one
-- matrix — can_view / can_add / can_reorder. Owner always has full rights and
-- is never a row. Existing public playlists keep today's collaborative
-- behaviour (view+add+reorder). Shared invites become view-only named grants.

create table if not exists jukebox.playlist_grants (
  playlist_id uuid not null references jukebox.playlists(id) on delete cascade,
  principal text not null,
  can_view boolean not null default true,
  can_add boolean not null default false,
  can_reorder boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (playlist_id, principal),
  constraint playlist_grants_principal_ok check (
    principal = 'public' or principal = lower(trim(principal))
  ),
  constraint playlist_grants_email_shape check (
    principal = 'public' or principal ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  ),
  constraint playlist_grants_cascade check (
    (not can_add or can_view)
    and (not can_reorder or can_add)
  )
);

create index if not exists playlist_grants_principal_idx
  on jukebox.playlist_grants (principal);

alter table jukebox.playlist_grants enable row level security;
revoke all on jukebox.playlist_grants from anon, authenticated;
grant all on jukebox.playlist_grants to service_role;

comment on table jukebox.playlist_grants is
  'Per-principal playlist caps. principal = public | lowercased email. Owner is never stored.';

-- Seed from current visibility / invites. Public lists keep full write so
-- nothing collaborative silently locks down overnight.
insert into jukebox.playlist_grants (playlist_id, principal, can_view, can_add, can_reorder)
select p.id, 'public', true, true, true
from jukebox.playlists p
where p.is_public = true or p.visibility = 'public'
on conflict (playlist_id, principal) do nothing;

insert into jukebox.playlist_grants (playlist_id, principal, can_view, can_add, can_reorder)
select a.playlist_id, lower(trim(a.recipient_email)), true, false, false
from jukebox.playlist_access a
where a.recipient_email is not null and trim(a.recipient_email) <> ''
on conflict (playlist_id, principal) do nothing;

-- Repair the one row that drifted (private visibility but is_public true).
update jukebox.playlists
set visibility = 'public'
where is_public = true and visibility is distinct from 'public';

update jukebox.playlists p
set visibility = 'shared', is_public = false
where visibility = 'shared'
   or (
     visibility = 'private'
     and exists (
       select 1 from jukebox.playlist_grants g
       where g.playlist_id = p.id and g.principal <> 'public'
     )
     and not exists (
       select 1 from jukebox.playlist_grants g
       where g.playlist_id = p.id and g.principal = 'public'
     )
   );

-- Backfill Added To Playlist By: attribute orphan rows to the playlist owner.
update jukebox.playlist_tracks t
set
  added_by_email = lower(trim(p.user_email)),
  added_by_name = coalesce(nullif(btrim(p.user_name), ''), split_part(p.user_email, '@', 1))
from jukebox.playlists p
where t.playlist_id = p.id
  and (t.added_by_email is null or btrim(t.added_by_email) = '');

create or replace function jukebox.normalize_playlist_grant(
  p_can_view boolean,
  p_can_add boolean,
  p_can_reorder boolean
) returns table(can_view boolean, can_add boolean, can_reorder boolean)
language sql immutable as $$
  select
    coalesce(p_can_view, false) or coalesce(p_can_add, false) or coalesce(p_can_reorder, false),
    coalesce(p_can_add, false) or coalesce(p_can_reorder, false),
    coalesce(p_can_reorder, false);
$$;

create or replace function jukebox.playlist_is_owner(p_playlist_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'jukebox', 'public'
as $$
  select exists (
    select 1 from jukebox.playlists p
    where p.id = p_playlist_id
      and lower(trim(p.user_email)) = jukebox.jwt_email()
  );
$$;

create or replace function jukebox.playlist_cap(
  p_playlist_id uuid,
  p_cap text
) returns boolean
language plpgsql
stable
security definer
set search_path to 'jukebox', 'public'
as $$
declare
  email text := jukebox.jwt_email();
  flag boolean := false;
begin
  if p_cap not in ('view', 'add', 'reorder') then
    return false;
  end if;

  if jukebox.playlist_is_owner(p_playlist_id) then
    return true;
  end if;

  -- Named grant beats the Public row when either is set.
  select case p_cap
           when 'view' then bool_or(g.can_view)
           when 'add' then bool_or(g.can_add)
           when 'reorder' then bool_or(g.can_reorder)
         end
    into flag
  from jukebox.playlist_grants g
  where g.playlist_id = p_playlist_id
    and (
      g.principal = 'public'
      or (email is not null and g.principal = email)
    );

  if coalesce(flag, false) then
    return true;
  end if;

  -- Legacy fallback while any client still keys only off is_public.
  if p_cap = 'view' then
    return exists (
      select 1 from jukebox.playlists p
      where p.id = p_playlist_id and p.is_public = true
    );
  end if;

  if email is null then
    return false;
  end if;

  if p_cap in ('add', 'reorder') then
    return exists (
      select 1 from jukebox.playlists p
      where p.id = p_playlist_id and p.is_public = true
        and not exists (
          select 1 from jukebox.playlist_grants g
          where g.playlist_id = p.id and g.principal = 'public'
        )
    );
  end if;

  return false;
end;
$$;

create or replace function jukebox.can_view_playlist(p_playlist_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'jukebox', 'public'
as $$
  select jukebox.playlist_cap(p_playlist_id, 'view');
$$;

create or replace function jukebox.can_add_to_playlist(p_playlist_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'jukebox', 'public'
as $$
  select jukebox.jwt_email() is not null
     and jukebox.playlist_cap(p_playlist_id, 'add');
$$;

create or replace function jukebox.can_arrange_playlist(p_playlist_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'jukebox', 'public'
as $$
  select jukebox.jwt_email() is not null
     and jukebox.playlist_cap(p_playlist_id, 'reorder');
$$;

create or replace function jukebox.my_playlist_caps(p_playlist_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'jukebox', 'public'
as $$
declare
  email text := jukebox.jwt_email();
  owner_email text;
  is_owner boolean;
begin
  select lower(trim(p.user_email)) into owner_email
  from jukebox.playlists p where p.id = p_playlist_id;
  if owner_email is null then
    return jsonb_build_object(
      'ok', false,
      'canView', false,
      'canAdd', false,
      'canReorder', false,
      'isOwner', false
    );
  end if;

  is_owner := email is not null and email = owner_email;
  return jsonb_build_object(
    'ok', true,
    'canView', is_owner or jukebox.playlist_cap(p_playlist_id, 'view'),
    'canAdd', is_owner or (email is not null and jukebox.playlist_cap(p_playlist_id, 'add')),
    'canReorder', is_owner or (email is not null and jukebox.playlist_cap(p_playlist_id, 'reorder')),
    'isOwner', is_owner,
    'email', email
  );
end;
$$;

revoke all on function jukebox.normalize_playlist_grant(boolean, boolean, boolean) from public;
revoke all on function jukebox.playlist_is_owner(uuid) from public;
revoke all on function jukebox.playlist_cap(uuid, text) from public;
revoke all on function jukebox.can_view_playlist(uuid) from public;
revoke all on function jukebox.can_add_to_playlist(uuid) from public;
revoke all on function jukebox.can_arrange_playlist(uuid) from public;
revoke all on function jukebox.my_playlist_caps(uuid) from public;

grant execute on function jukebox.can_view_playlist(uuid) to anon, authenticated, service_role;
grant execute on function jukebox.can_add_to_playlist(uuid) to authenticated, service_role;
grant execute on function jukebox.can_arrange_playlist(uuid) to authenticated, service_role;
grant execute on function jukebox.my_playlist_caps(uuid) to anon, authenticated, service_role;
grant execute on function jukebox.playlist_is_owner(uuid) to authenticated, service_role;
grant execute on function jukebox.playlist_cap(uuid, text) to service_role;
grant execute on function jukebox.normalize_playlist_grant(boolean, boolean, boolean) to service_role;

-- Playlists / tracks: anyone with can_view (including anon via Public) may read.
drop policy if exists "playlists select" on jukebox.playlists;
create policy "playlists select" on jukebox.playlists
  for select using (jukebox.can_view_playlist(id));

drop policy if exists "pl tracks select" on jukebox.playlist_tracks;
create policy "pl tracks select" on jukebox.playlist_tracks
  for select using (jukebox.can_view_playlist(playlist_id));

drop policy if exists "pl tracks insert" on jukebox.playlist_tracks;
create policy "pl tracks insert" on jukebox.playlist_tracks
  for insert with check (jukebox.can_add_to_playlist(playlist_id));

drop policy if exists "pl tracks update" on jukebox.playlist_tracks;
create policy "pl tracks update" on jukebox.playlist_tracks
  for update
  using (jukebox.can_arrange_playlist(playlist_id))
  with check (jukebox.can_arrange_playlist(playlist_id));

-- Delete: owner, or the person who added the song (and can still see the list).
drop policy if exists "pl tracks delete" on jukebox.playlist_tracks;
create policy "pl tracks delete" on jukebox.playlist_tracks
  for delete using (
    jukebox.playlist_is_owner(playlist_id)
    or (
      added_by_email is not null
      and lower(trim(added_by_email)) = jukebox.jwt_email()
      and jukebox.can_view_playlist(playlist_id)
    )
  );
