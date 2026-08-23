-- The Export modal offers an "All artists currently in Jukebox" scope on pages
-- that load a second artist (Purple Mountains on the Silver Jews page). That is
-- a different picture, so it needs its own row and its own key.
alter table jukebox.share_images
  add column if not exists scope text not null default 'artist';

alter table jukebox.share_images
  drop constraint if exists share_images_slug_shot_id_format_key;

alter table jukebox.share_images
  add constraint share_images_slug_shot_format_scope_key
  unique (slug, shot_id, format, scope);

alter table jukebox.share_images
  drop constraint if exists share_images_scope_check;

alter table jukebox.share_images
  add constraint share_images_scope_check check (scope in ('artist','all'));
