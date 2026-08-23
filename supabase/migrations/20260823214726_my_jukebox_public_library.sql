-- My Jukebox is a permanent owner library.  A live QR room is only a
-- temporary request queue layered on top of it.
--
-- These tables are intentionally service-role only.  The static dashboard
-- already carries a browser Supabase client for the legacy catalog; exposing
-- a person's private imported library through that client would make a
-- visibility toggle an authorization bug.  All access is therefore mediated
-- by Next routes which verify the Supabase access token first.

alter table jukebox.jukeboxes
  add column if not exists is_public boolean not null default false,
  add column if not exists public_slug text,
  add column if not exists description text;

create unique index if not exists jukeboxes_public_slug_key
  on jukebox.jukeboxes (lower(public_slug))
  where public_slug is not null;

create index if not exists jukeboxes_public_explore_idx
  on jukebox.jukeboxes (updated_at desc)
  where is_public = true and public_slug is not null;

create table if not exists jukebox.my_jukebox_items (
  id                  uuid primary key default gen_random_uuid(),
  jukebox_id          uuid not null references jukebox.jukeboxes(id) on delete cascade,
  catalog_track_id    uuid references jukebox.tracks(id) on delete set null,
  youtube_video_id    text,
  title               text not null,
  artist_name         text,
  album_name          text,
  album_art_url       text,
  duration_ms         integer,
  source              text not null check (source in ('catalog', 'youtube', 'spotify')),
  source_uri          text,
  youtube_view_count  bigint,
  youtube_stats_at    timestamptz,
  lyrics              text,
  lyrics_source       text,
  lyrics_checked_at   timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (catalog_track_id is not null or youtube_video_id is not null),
  check (youtube_video_id is null or youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'),
  check (duration_ms is null or duration_ms >= 0)
);

-- A catalog song and a manually imported YouTube video are each idempotent
-- additions.  This keeps Add Artist / Album / Song safe to retry.
create unique index if not exists my_jukebox_items_catalog_key
  on jukebox.my_jukebox_items (jukebox_id, catalog_track_id)
  where catalog_track_id is not null;
create unique index if not exists my_jukebox_items_youtube_key
  on jukebox.my_jukebox_items (jukebox_id, youtube_video_id)
  where youtube_video_id is not null;
create index if not exists my_jukebox_items_jukebox_idx
  on jukebox.my_jukebox_items (jukebox_id, created_at desc);
create index if not exists my_jukebox_items_artist_idx
  on jukebox.my_jukebox_items (jukebox_id, lower(artist_name));
create index if not exists my_jukebox_items_album_idx
  on jukebox.my_jukebox_items (jukebox_id, lower(album_name));

create table if not exists jukebox.my_jukebox_plays (
  id              uuid primary key default gen_random_uuid(),
  jukebox_id      uuid not null references jukebox.jukeboxes(id) on delete cascade,
  library_item_id uuid not null references jukebox.my_jukebox_items(id) on delete cascade,
  played_by_user  uuid,
  played_at       timestamptz not null default now(),
  duration_ms     integer not null default 0 check (duration_ms >= 0)
);
create index if not exists my_jukebox_plays_item_idx
  on jukebox.my_jukebox_plays (library_item_id, played_at desc);
create index if not exists my_jukebox_plays_jukebox_idx
  on jukebox.my_jukebox_plays (jukebox_id, played_at desc);

alter table jukebox.my_jukebox_items enable row level security;
alter table jukebox.my_jukebox_plays enable row level security;

revoke all on jukebox.my_jukebox_items from anon, authenticated;
revoke all on jukebox.my_jukebox_plays from anon, authenticated;
grant all on jukebox.my_jukebox_items to service_role;
grant all on jukebox.my_jukebox_plays to service_role;
