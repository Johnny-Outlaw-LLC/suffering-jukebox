-- The CarPlay queue: songs picked on one device, downloaded on another.
--
-- Choosing a drive's worth of music on a phone is miserable, and CarPlay can
-- only play what is already on the device. So the picking happens wherever the
-- listener is comfortable - usually a desktop - and this table is the note it
-- leaves for the phone. The phone reads it, the listener accepts, and only then
-- does anything download.
--
-- Rows are requests, not state: `accepted_at` records that a device took the
-- song, but the file itself lives on that device and nowhere else. Deleting a
-- row does not delete a download, and removing a download does not delete a
-- row.
--
-- Written ONLY by the service role via /api/sj-carplay-queue, which checks that
-- the caller owns an uploaded file for the track. RLS is on with no anon or
-- authenticated grants, matching jukebox.perf_events: the browser never reaches
-- this table through PostgREST.

create table if not exists jukebox.carplay_queue (
  user_id     uuid        not null,
  track_id    uuid        not null references jukebox.tracks (id) on delete cascade,
  queued_at   timestamptz not null default now(),
  -- When a device downloaded it. Kept rather than deleted so the desktop that
  -- queued the song can say "on your iPhone" instead of going quiet.
  accepted_at timestamptz,
  primary key (user_id, track_id)
);

create index if not exists carplay_queue_user_idx
  on jukebox.carplay_queue (user_id, queued_at desc);

alter table jukebox.carplay_queue enable row level security;

drop policy if exists carplay_queue_service on jukebox.carplay_queue;
create policy carplay_queue_service on jukebox.carplay_queue
  for all to service_role using (true) with check (true);

revoke all on jukebox.carplay_queue from anon, authenticated;
grant select, insert, update, delete on jukebox.carplay_queue to service_role;

notify pgrst, 'reload schema';
