-- Spotify URI matches for Play through Spotify (Premium transport).
-- Service role writes from /api/spotify/match-track; anon has no grants.

create table if not exists jukebox.track_spotify_matches (
  track_id uuid primary key references jukebox.tracks(id) on delete cascade,
  spotify_uri text,
  spotify_id text,
  spotify_name text,
  spotify_artist text,
  miss boolean not null default false,
  matched_at timestamptz not null default now()
);

create index if not exists track_spotify_matches_spotify_id_idx
  on jukebox.track_spotify_matches (spotify_id)
  where spotify_id is not null;

alter table jukebox.track_spotify_matches enable row level security;

revoke all on table jukebox.track_spotify_matches from anon, authenticated;
grant all on table jukebox.track_spotify_matches to service_role;

comment on table jukebox.track_spotify_matches is
  'Catalogue track ↔ Spotify URI for Premium Web Playback / Connect. miss=true caches a failed search.';
