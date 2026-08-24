-- One import path, one content store.  Everything the Add Music wizard
-- imports lands in jukebox.artists / albums / tracks regardless of who is
-- allowed to see it.  Visibility is data, not a second set of tables.
--
-- Defaults are deliberately 'public' and true, so this migration is a no-op
-- for everything already in the catalog.  The anon SELECT policies still read
-- `using (true)`; tightening them to `visibility = 'public'` is a separate,
-- explicit step once the private read path has been exercised in anger.

alter table jukebox.artists
  add column if not exists visibility text not null default 'public',
  add column if not exists discography_complete boolean not null default true;

alter table jukebox.albums
  add column if not exists visibility text not null default 'public';

alter table jukebox.tracks
  add column if not exists visibility text not null default 'public';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'artists_visibility_chk') then
    alter table jukebox.artists add constraint artists_visibility_chk
      check (visibility in ('public', 'private'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'albums_visibility_chk') then
    alter table jukebox.albums add constraint albums_visibility_chk
      check (visibility in ('public', 'private'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tracks_visibility_chk') then
    alter table jukebox.tracks add constraint tracks_visibility_chk
      check (visibility in ('public', 'private'));
  end if;
end $$;

create index if not exists artists_visibility_idx on jukebox.artists (visibility);
create index if not exists albums_visibility_idx on jukebox.albums (visibility);
create index if not exists tracks_visibility_idx on jukebox.tracks (visibility);
create index if not exists artists_discography_incomplete_idx
  on jukebox.artists (id) where discography_complete = false;

-- Who has rights to an artist's catalog rows.  Rights are recorded at the
-- artist level because that is the unit the wizard imports and the unit
-- Explore Artists lists; an album- or song-scoped import still creates the
-- artist, it just leaves discography_complete false.
create table if not exists jukebox.content_access (
  artist_id   uuid not null references jukebox.artists(id) on delete cascade,
  user_email  text not null,
  granted_at  timestamptz not null default now(),
  primary key (artist_id, user_email)
);

create index if not exists content_access_email_idx
  on jukebox.content_access (lower(user_email));

-- Service-role only, exactly like my_jukebox_items.  The dashboard's browser
-- client is always anon, so anything user-scoped has to come through either a
-- Next route or a SECURITY DEFINER RPC that reads the caller's JWT.
alter table jukebox.content_access enable row level security;
revoke all on jukebox.content_access from anon, authenticated;
grant all on jukebox.content_access to service_role;
