-- Guests name themselves, or they are numbered.
--
-- A guest used to be given a name lifted out of a lyric - "Abbatoir Though",
-- "Circa Abscam". It read as a bug rather than as a joke: nobody could tell
-- whether the room was full of strangers with odd names or whether the app had
-- made them up. A guest now has no name until they type one, and until then
-- the room calls them Listener 1, Listener 2, in the order they walked in.

alter table jukebox.jukebox_guests
  alter column display_name drop not null;

comment on column jukebox.jukebox_guests.display_name is
  'What this guest chose to be called, or null. Never generated - an unnamed guest displays as Listener <guest_no>. See displayNameFor() in src/lib/jukebox.ts.';

alter table jukebox.jukebox_guests
  add column if not exists guest_no integer;

-- Join order within the room, so the number is stable for the whole night.
with numbered as (
  select id, row_number() over (partition by jukebox_id order by created_at, id) as rn
    from jukebox.jukebox_guests
)
update jukebox.jukebox_guests g
   set guest_no = numbered.rn
  from numbered
 where numbered.id = g.id and g.guest_no is null;

-- Assigned in the database rather than in the route: the route would have to
-- read the room's high-water mark and write in two steps, and two phones
-- scanning the code at once would both read the same number.
create or replace function jukebox.assign_guest_no()
returns trigger
language plpgsql
as $$
begin
  if new.guest_no is null then
    select coalesce(max(guest_no), 0) + 1
      into new.guest_no
      from jukebox.jukebox_guests
     where jukebox_id = new.jukebox_id;
  end if;
  return new;
end;
$$;

drop trigger if exists jukebox_guests_assign_no on jukebox.jukebox_guests;
create trigger jukebox_guests_assign_no
  before insert on jukebox.jukebox_guests
  for each row execute function jukebox.assign_guest_no();

alter table jukebox.jukebox_guests
  alter column guest_no set not null;

comment on column jukebox.jukebox_guests.guest_no is
  'Join order within the room, assigned by trigger. Displayed as Listener <n> until the guest names themselves.';
