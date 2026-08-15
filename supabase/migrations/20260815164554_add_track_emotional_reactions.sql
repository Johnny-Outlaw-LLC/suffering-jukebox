create table if not exists jukebox.track_reactions (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references jukebox.tracks(id) on delete cascade,
  reaction text not null,
  user_id uuid references auth.users(id) on delete set null,
  device_id text not null,
  position_ms integer,
  created_at timestamptz not null default now(),
  constraint track_reactions_reaction_check
    check (reaction in ('heart', 'sad', 'guitar', 'drums', 'mic', 'pencil')),
  constraint track_reactions_device_id_check
    check (char_length(device_id) between 8 and 100),
  constraint track_reactions_position_ms_check
    check (position_ms is null or position_ms between 0 and 86400000)
);

create index if not exists track_reactions_track_reaction_idx
  on jukebox.track_reactions (track_id, reaction);

create index if not exists track_reactions_user_id_idx
  on jukebox.track_reactions (user_id);

alter table jukebox.track_reactions enable row level security;
alter table jukebox.track_reactions force row level security;

revoke all on table jukebox.track_reactions from public, anon, authenticated;
grant select, insert, update, delete on table jukebox.track_reactions to service_role;

create or replace view jukebox.track_reaction_totals
with (security_invoker = true)
as
select track_id, reaction, count(*)::bigint as reaction_count
from jukebox.track_reactions
group by track_id, reaction;

revoke all on table jukebox.track_reaction_totals from public, anon, authenticated;
grant select on table jukebox.track_reaction_totals to service_role;

comment on table jukebox.track_reactions is
  'One-tap emotional reactions sent while a track is playing.';

comment on column jukebox.track_reactions.position_ms is
  'Playback position when the reaction was sent, in milliseconds.';
