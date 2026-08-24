-- Interactive Jukebox, act two: the room mirrors the host's player.
--
-- Two things arrive here.
--
-- 1. jukeboxes.playback — what the host's player is doing right now, as one
--    jsonb blob for the same reason settings is one: a new field (a version
--    switch, a lyric offset, a chapter) should never need a migration. Shape
--    and defaults live in normalizePlayback() in src/lib/jukebox.ts.
--    It is written by the host's 3s sync and read by every guest, which is
--    how /j/<code> shows the same video, at the same second, with the same
--    lyric line lit up as the TV.
--
-- 2. public_slug is repurposed. It used to be the vanity address of a
--    published personal library (retired in "Retire Public Jukeboxes"); it is
--    now the vanity address of the live room, so a host can print
--    sufferingjukebox.stream/outlaw on a table card instead of /j/ZPGZ4H.
--    The unique index from the old feature still does the job.

alter table jukebox.jukeboxes
  add column if not exists playback jsonb not null default '{}'::jsonb;

comment on column jukebox.jukeboxes.playback is
  'What the host player is doing: videoId, trackId, positionMs, isPlaying, updatedAt. Written by the owner sync, read by guests. Shape lives in src/lib/jukebox.ts.';

comment on column jukebox.jukeboxes.public_slug is
  'Vanity join address for the live room: sufferingjukebox.stream/<public_slug>. Resolved in src/proxy.ts and rewritten to /j/<slug>.';

-- The host sync rewrites sort for the whole queue on every push, so the
-- (jukebox_id, status) lookup wants to be cheap even with a long history.
create index if not exists jukebox_queue_room_status_idx
  on jukebox.jukebox_queue (jukebox_id, status);
