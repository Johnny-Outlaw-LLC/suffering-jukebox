-- Timed "take a break" skips share blocked_tracks with never-play-again.
-- until IS NULL = skip forever; until in the future = skip until that time.
alter table jukebox.blocked_tracks
  add column if not exists until timestamptz;

comment on column jukebox.blocked_tracks.until is
  'Skip this track until this time. Null means never play again.';
