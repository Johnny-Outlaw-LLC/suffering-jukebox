-- Nightly-generated share images for every artist jukebox.
-- One row per (slug, shot, format). Keys are STABLE and overwritten each night,
-- so a link posted anywhere keeps showing current data.
-- Written by capture/capture.mjs (Render cron job), read-only to clients.
create table if not exists jukebox.share_images (
  id           uuid primary key default gen_random_uuid(),
  artist_id    uuid references jukebox.artists(id) on delete cascade,
  slug         text not null,
  shot_id      text not null,
  format       text not null check (format in ('stage','reel','og')),
  b2_key       text not null,
  width        integer,
  height       integer,
  bytes        integer,
  album_count  integer,
  track_count  integer,
  content_hash text,
  captured_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (slug, shot_id, format)
);

create index if not exists share_images_slug_idx on jukebox.share_images (slug);
create index if not exists share_images_artist_idx on jukebox.share_images (artist_id);
create index if not exists share_images_captured_idx on jukebox.share_images (captured_at desc);

alter table jukebox.share_images enable row level security;

-- Public read: these are deliberately public marketing assets.
drop policy if exists share_images_public_read on jukebox.share_images;
create policy share_images_public_read
  on jukebox.share_images for select
  to anon, authenticated
  using (true);

-- Writes are service-role only (the nightly capture job). No client-side writes.
grant usage on schema jukebox to anon, authenticated;
grant select on jukebox.share_images to anon, authenticated;
grant all on jukebox.share_images to service_role;
