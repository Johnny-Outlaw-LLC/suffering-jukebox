-- A car key lets the iPhone app stream the signed-in listener's own uploads in
-- CarPlay without the web view being awake. The car cannot sign in, and a
-- presigned B2 URL handed over in advance would expire before the drive, so the
-- phone keeps this key and trades it for a fresh URL at the moment a song starts.
--
-- Only the sha256 of the key is stored (same rule as jukebox_guests). A key can
-- read its owner's locker and nothing else. Artist-licensed audio needs no key.
--
-- Service role only: RLS on, no anon or authenticated grants. Every read and
-- write goes through /api/sj-carplay-* routes.

create table if not exists jukebox.carplay_keys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  token_hash    text not null unique,
  device_id     text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

create index if not exists carplay_keys_user_idx on jukebox.carplay_keys (user_id) where revoked_at is null;

alter table jukebox.carplay_keys enable row level security;

revoke all on table jukebox.carplay_keys from anon, authenticated;
grant select, insert, update, delete on table jukebox.carplay_keys to service_role;

drop policy if exists carplay_keys_service on jukebox.carplay_keys;
create policy carplay_keys_service on jukebox.carplay_keys
  for all to service_role using (true) with check (true);
