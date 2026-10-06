-- Mod role + manual lyric syncing (2026-10-05)
--
-- Mod is NOT admin. It is a flag beside is_admin (not a user_level, which is the
-- storage tier): mods may clean up lyrics, titles and lyric timing on any
-- artist, and may not delete music, change visibility or see admin tooling.

alter table jukebox.app_users add column if not exists is_mod boolean not null default false;

-- 'manual' = timed by hand in our editor; the nightly enrich never replaces it.
alter table jukebox.tracks add column if not exists lyrics_synced_source text;
alter table jukebox.tracks add column if not exists lyrics_synced_by text;
alter table jukebox.tracks add column if not exists lyrics_synced_at timestamptz;

create or replace function jukebox.is_app_mod(p_email text)
returns boolean language sql stable security definer set search_path to 'jukebox' as $$
  select coalesce((select is_mod from jukebox.app_users where email = lower(trim(p_email))), false);
$$;

create or replace function jukebox.set_app_user_mod(p_email text, p_mod boolean)
returns void language plpgsql security definer set search_path to 'jukebox' as $$
declare e text := lower(btrim(p_email));
begin
  insert into jukebox.app_users (email, is_mod, last_seen_at) values (e, coalesce(p_mod, false), now())
  on conflict (email) do update set is_mod = excluded.is_mod;
end;
$$;

revoke all on function jukebox.is_app_mod(text) from public, anon, authenticated;
revoke all on function jukebox.set_app_user_mod(text, boolean) from public, anon, authenticated;
grant execute on function jukebox.is_app_mod(text) to service_role;
grant execute on function jukebox.set_app_user_mod(text, boolean) to service_role;

-- Mods may retime lyrics and pick versions on any track, like admins.
create or replace function jukebox.can_edit_track_videos(p_track_id uuid)
returns boolean language sql stable security definer set search_path to 'jukebox', 'public' as $$
  select case
    when jukebox.jwt_email() is null then false
    when jukebox.is_app_admin(jukebox.jwt_email()) then true
    when jukebox.is_app_mod(jukebox.jwt_email()) then true
    else exists (
      select 1
      from jukebox.tracks t
      join jukebox.albums al on al.id = t.album_id
      join jukebox.artists ar on ar.id = al.artist_id
      where t.id = p_track_id
        and lower(jukebox.jwt_email()) in (lower(nullif(al.added_by, '')), lower(nullif(ar.added_by, '')))
    )
  end;
$$;
