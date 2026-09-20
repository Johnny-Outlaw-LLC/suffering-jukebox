-- Artist-supplied releases stay outside the public catalog until rights review.
create table jukebox.artist_upload_releases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  artist_id uuid not null references jukebox.artists(id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 200),
  release_date date,
  is_unreleased boolean not null default false,
  art_url text,
  art_storage_path text,
  submitted_at timestamptz,
  published_album_id uuid references jukebox.albums(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);

create index artist_upload_releases_owner_idx
  on jukebox.artist_upload_releases (user_id, artist_id, created_at);

create table jukebox.artist_upload_tracks (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references jukebox.artist_upload_releases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 200),
  disc_number integer not null default 1 check (disc_number between 1 and 99),
  track_number integer not null check (track_number between 1 and 999),
  duration_ms integer check (duration_ms > 0),
  explicit boolean not null default false,
  created_at timestamptz not null default now(),
  unique (release_id, disc_number, track_number)
);

create index artist_upload_tracks_owner_idx
  on jukebox.artist_upload_tracks (user_id, release_id);

alter table jukebox.artist_upload_releases enable row level security;
alter table jukebox.artist_upload_tracks enable row level security;
revoke all on jukebox.artist_upload_releases, jukebox.artist_upload_tracks from public, anon, authenticated;
grant select, insert, update, delete on jukebox.artist_upload_releases, jukebox.artist_upload_tracks to service_role;

-- Staff can raise the staging allowance for a verified artist account so an
-- entire lossless discography fits without raising every listener's locker.
create table jukebox.artist_upload_grants (
  artist_id uuid not null references jukebox.artists(id) on delete cascade,
  user_email text not null,
  limit_bytes bigint not null default 10737418240 check (limit_bytes between 524288000 and 53687091200),
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (artist_id, user_email)
);
create index artist_upload_grants_email_idx on jukebox.artist_upload_grants (lower(user_email));
alter table jukebox.artist_upload_grants enable row level security;
revoke all on jukebox.artist_upload_grants from public, anon, authenticated;
grant select, insert, update, delete on jukebox.artist_upload_grants to service_role;

-- Existing rows keep their current read behavior. New direct-audio rows can be
-- hidden immediately on withdrawal without changing other artists' catalogs.
alter table jukebox.artists add column artist_audio_visible boolean not null default true;
alter table jukebox.artists add column artist_upload_created_by uuid references auth.users(id) on delete set null;
alter table jukebox.albums add column artist_audio_visible boolean not null default true;
alter table jukebox.albums add column artist_unreleased boolean not null default false;
alter table jukebox.tracks add column artist_audio_visible boolean not null default true;
alter table jukebox.tracks add column artist_audio_only boolean not null default false;
drop policy if exists "catalog read artists" on jukebox.artists;
create policy "catalog read artists" on jukebox.artists for select to anon, authenticated
  using (artist_audio_visible);
drop policy if exists "catalog read albums" on jukebox.albums;
create policy "catalog read albums" on jukebox.albums for select to anon, authenticated
  using (artist_audio_visible);
drop policy if exists "catalog read tracks" on jukebox.tracks;
create policy "catalog read tracks" on jukebox.tracks for select to anon, authenticated
  using (artist_audio_visible);

-- A verified artist can submit a later batch while an older license remains
-- active. A second pending or suspended application is still blocked.
drop index if exists jukebox.artist_rights_one_open_application_uidx;
create unique index artist_rights_one_open_application_uidx
  on jukebox.artist_rights_agreements (user_id, artist_id)
  where status in ('pending', 'suspended');
