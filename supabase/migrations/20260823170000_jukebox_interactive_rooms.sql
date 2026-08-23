-- Interactive Jukebox: a host plays on a TV, guests scan a code and queue songs.
--
-- Deliberately NO anon/authenticated grants and no SECURITY DEFINER RPCs.
-- Every read and write for this feature goes through the Next API routes with
-- the service role, so the rules (per-guest cap, bans, duplicates, offline
-- adds) are enforced in exactly one place and cannot be bypassed by a client
-- holding the anon key. This is the difference from the rest of the app, where
-- the browser talks to PostgREST directly.

create table if not exists jukebox.jukeboxes (
  id           uuid primary key default gen_random_uuid(),
  owner_email  text        not null,
  code         text        not null,
  name         text        not null default 'Jukebox',
  is_live      boolean     not null default false,
  -- One jsonb blob on purpose: new owner settings should never need a
  -- migration. Shape and defaults live in src/lib/jukebox.ts.
  settings     jsonb       not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  last_live_at timestamptz
);

-- Codes are compared case-insensitively: the guest is typing it off a printed
-- card, or a QR reader may upper-case it.
create unique index if not exists jukeboxes_code_key
  on jukebox.jukeboxes (lower(code));
create index if not exists jukeboxes_owner_idx
  on jukebox.jukeboxes (lower(owner_email));

-- A guest is a browser, not a person. The raw token lives only in an httpOnly
-- cookie; we store its sha256 so a database leak cannot be replayed as
-- somebody else's guest session.
create table if not exists jukebox.jukebox_guests (
  id           uuid primary key default gen_random_uuid(),
  jukebox_id   uuid        not null references jukebox.jukeboxes(id) on delete cascade,
  token_hash   text        not null,
  display_name text        not null,
  user_id      uuid,
  user_email   text,
  is_banned    boolean     not null default false,
  banned_at    timestamptz,
  ip_address   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create unique index if not exists jukebox_guests_token_key
  on jukebox.jukebox_guests (token_hash);
create index if not exists jukebox_guests_room_idx
  on jukebox.jukebox_guests (jukebox_id, is_banned);

create table if not exists jukebox.jukebox_queue (
  id            uuid        primary key default gen_random_uuid(),
  jukebox_id    uuid        not null references jukebox.jukeboxes(id) on delete cascade,
  track_id      uuid        not null references jukebox.tracks(id) on delete cascade,
  -- A hint of what the guest was looking at. The host still resolves the
  -- primary version at play time, so a re-pointed track plays the good upload.
  video_id      text,
  guest_id      uuid        references jukebox.jukebox_guests(id) on delete set null,
  added_by_name text        not null,
  added_by_owner boolean    not null default false,
  -- Fractional so a drag-reorder is a single UPDATE of the moved row rather
  -- than renumbering the whole queue.
  sort          numeric     not null,
  status        text        not null default 'pending'
                check (status in ('pending','playing','played','removed')),
  created_at    timestamptz not null default now(),
  played_at     timestamptz,
  removed_at    timestamptz,
  removed_by    text
);

create index if not exists jukebox_queue_play_idx
  on jukebox.jukebox_queue (jukebox_id, status, sort);
-- Powers the 5s "what's new" poll that fires the added-by toast.
create index if not exists jukebox_queue_recent_idx
  on jukebox.jukebox_queue (jukebox_id, created_at desc);
create index if not exists jukebox_queue_guest_idx
  on jukebox.jukebox_queue (guest_id, status);

alter table jukebox.jukeboxes      enable row level security;
alter table jukebox.jukebox_guests enable row level security;
alter table jukebox.jukebox_queue  enable row level security;

-- No policies are created, so anon and authenticated can read and write
-- nothing. The service role bypasses RLS and is the only way in.
revoke all on jukebox.jukeboxes      from anon, authenticated;
revoke all on jukebox.jukebox_guests from anon, authenticated;
revoke all on jukebox.jukebox_queue  from anon, authenticated;

grant all on jukebox.jukeboxes      to service_role;
grant all on jukebox.jukebox_guests to service_role;
grant all on jukebox.jukebox_queue  to service_role;
