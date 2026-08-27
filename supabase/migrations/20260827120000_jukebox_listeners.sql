-- Online Jukebox: who is listening, and for how long.
--
-- last_seen_at already told us a guest is still there. It could not tell us
-- when they arrived, because created_at is the night they first scanned the
-- code and a bar regular's is weeks old. session_started_at is the top of the
-- CURRENT stretch of listening: it restarts whenever a guest has been away
-- longer than the gap the toucher passes in.

alter table jukebox.jukebox_guests
  add column if not exists session_started_at timestamptz not null default now();

comment on column jukebox.jukebox_guests.session_started_at is
  'Top of the current listening stretch, restarted by jukebox.touch_guest() after a gap. Not the first-ever join, which is created_at.';

-- The listeners panel orders by who is still here, so the poll wants an index
-- rather than a sort over every guest the room has ever had.
create index if not exists jukebox_guests_seen_idx
  on jukebox.jukebox_guests (jukebox_id, last_seen_at desc);

-- One statement, so the 4s guest poll costs one round trip instead of a read
-- followed by a write. Doing it in SQL is also the only way the "have they
-- been away long enough to restart the clock" test can be atomic.
create or replace function jukebox.touch_guest(p_guest_id uuid, p_gap_seconds int default 300)
returns void
language sql
as $$
  update jukebox.jukebox_guests
     set last_seen_at = now(),
         session_started_at = case
           when last_seen_at < now() - make_interval(secs => p_gap_seconds)
             then now()
           else session_started_at
         end
   where id = p_guest_id;
$$;

revoke all on function jukebox.touch_guest(uuid, int) from anon, authenticated;
grant execute on function jukebox.touch_guest(uuid, int) to service_role;

-- The last playlist the host actually broadcast, in play order, so a visitor
-- who arrives after the station goes quiet can still load it and listen on
-- their own machine.
--
-- It is deliberately NOT derived from jukebox_queue at read time: rows played
-- on earlier nights keep a 'played' status and a stale sort value, so
-- reconstructing the order from the table would splice last week's set into
-- tonight's. This column is written by the host sync whenever the running
-- order changes, which makes it exactly what was on air when the music
-- stopped.
alter table jukebox.jukeboxes
  add column if not exists last_queue jsonb not null default '[]'::jsonb;

comment on column jukebox.jukeboxes.last_queue is
  'Last broadcast running order: [{t:trackId, v:videoId, by:addedByName}]. Written by the owner sync, read by /api/jukebox/offline.';
