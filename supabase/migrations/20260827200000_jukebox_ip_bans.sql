-- IP bans are represented by the guest rows already kept for each room. This
-- index makes both enforcing a ban on every add and applying it to every seat
-- sharing the address inexpensive without introducing a second source of truth.
create index if not exists jukebox_guests_room_ip_idx
  on jukebox.jukebox_guests (jukebox_id, ip_address)
  where ip_address is not null;
