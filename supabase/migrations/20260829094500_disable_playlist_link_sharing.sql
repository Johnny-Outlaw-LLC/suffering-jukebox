-- Unlisted playlist links are no longer a sharing mode. Revoke any existing
-- token before narrowing the constraint so an old URL can never reopen a list.
update jukebox.playlists
set visibility = 'private', is_public = false, share_token_hash = null, share_token_created_at = null
where visibility = 'link' or share_token_hash is not null;

alter table jukebox.playlists drop constraint if exists playlists_visibility_check;
alter table jukebox.playlists add constraint playlists_visibility_check
  check (visibility in ('private', 'shared', 'public'));
