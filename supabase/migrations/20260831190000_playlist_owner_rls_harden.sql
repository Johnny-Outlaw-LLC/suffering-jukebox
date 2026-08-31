-- Creating a playlist uses Prefer: return=representation, so INSERT
-- RETURNING needs a SELECT policy that admits the new owner row. Relying
-- only on can_view_playlist() failed to return the row for some sessions
-- (empty 201 + client crash on pl.id). Owner email match is the belt.
-- Also make insert/update/delete case-insensitive like jwt_email().

drop policy if exists "playlists select" on jukebox.playlists;
create policy "playlists select" on jukebox.playlists
  for select using (
    (jukebox.jwt_email() is not null and lower(trim(user_email)) = jukebox.jwt_email())
    or jukebox.can_view_playlist(id)
  );

drop policy if exists "playlists insert" on jukebox.playlists;
create policy "playlists insert" on jukebox.playlists
  for insert with check (
    jukebox.jwt_email() is not null
    and lower(trim(user_email)) = jukebox.jwt_email()
  );

drop policy if exists "playlists update" on jukebox.playlists;
create policy "playlists update" on jukebox.playlists
  for update using (
    jukebox.jwt_email() is not null
    and lower(trim(user_email)) = jukebox.jwt_email()
  );

drop policy if exists "playlists delete" on jukebox.playlists;
create policy "playlists delete" on jukebox.playlists
  for delete using (
    jukebox.jwt_email() is not null
    and lower(trim(user_email)) = jukebox.jwt_email()
  );
