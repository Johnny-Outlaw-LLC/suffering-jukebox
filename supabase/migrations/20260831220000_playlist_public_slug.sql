-- Vanity URLs for playlists at /p/<slug>. Prefixed path so they never
-- collide with artist pages or Online Jukebox vanity addresses.
alter table jukebox.playlists
  add column if not exists slug text;

create unique index if not exists playlists_slug_key
  on jukebox.playlists (lower(slug))
  where slug is not null;

comment on column jukebox.playlists.slug is
  'Public web address segment for /p/<slug>. Allocated on share or when made public.';
