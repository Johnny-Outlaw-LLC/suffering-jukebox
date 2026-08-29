-- Playlist sharing has three discoverability levels.  Named recipients and
-- unlisted links are deliberately separate from public Explore playlists.
alter table jukebox.playlists
  add column if not exists visibility text not null default 'private',
  add column if not exists share_token_hash text,
  add column if not exists share_token_created_at timestamptz;

update jukebox.playlists
set visibility = case when is_public then 'public' else 'private' end
where visibility = 'private';

alter table jukebox.playlists drop constraint if exists playlists_visibility_check;
alter table jukebox.playlists add constraint playlists_visibility_check
  check (visibility in ('private', 'shared', 'link', 'public'));
create unique index if not exists playlists_share_token_hash_key
  on jukebox.playlists (share_token_hash) where share_token_hash is not null;

create table if not exists jukebox.playlist_access (
  playlist_id uuid not null references jukebox.playlists(id) on delete cascade,
  recipient_email text not null,
  created_at timestamptz not null default now(),
  primary key (playlist_id, recipient_email),
  constraint playlist_access_email_normalized check (recipient_email = lower(trim(recipient_email)))
);
create index if not exists playlist_access_recipient_idx on jukebox.playlist_access (recipient_email);
alter table jukebox.playlist_access enable row level security;
revoke all on jukebox.playlist_access from anon, authenticated;
grant all on jukebox.playlist_access to service_role;

comment on column jukebox.playlists.share_token_hash is
  'SHA-256 of a random bearer token. Never expose the hash or use playlist IDs as share secrets.';
