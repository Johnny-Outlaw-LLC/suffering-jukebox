-- Background-play audio is a private per-user music locker.
-- Remove the old public/cross-user model at both the metadata and object layers.

update jukebox.track_audio
set is_public = false
where is_public;

alter table jukebox.track_audio
  alter column is_public set default false;

alter table jukebox.track_audio
  drop constraint if exists track_audio_private_only;

alter table jukebox.track_audio
  add constraint track_audio_private_only check (is_public = false);

drop index if exists jukebox.track_audio_one_public_uidx;

alter table jukebox.track_audio enable row level security;

drop policy if exists "public read track audio" on jukebox.track_audio;
drop policy if exists track_audio_select on jukebox.track_audio;
drop policy if exists track_audio_insert on jukebox.track_audio;
drop policy if exists track_audio_insert_own on jukebox.track_audio;
drop policy if exists track_audio_update on jukebox.track_audio;
drop policy if exists track_audio_update_own on jukebox.track_audio;
drop policy if exists track_audio_delete on jukebox.track_audio;
drop policy if exists track_audio_delete_own on jukebox.track_audio;

revoke all on table jukebox.track_audio from anon;
grant select, insert, update, delete on table jukebox.track_audio to authenticated;
grant select, insert, update, delete on table jukebox.track_audio to service_role;

create policy track_audio_select_own
on jukebox.track_audio
for select
to authenticated
using ((select auth.uid()) = uploaded_by);

create policy track_audio_insert_own_private
on jukebox.track_audio
for insert
to authenticated
with check (
  (select auth.uid()) = uploaded_by
  and is_public = false
);

create policy track_audio_update_own_private
on jukebox.track_audio
for update
to authenticated
using ((select auth.uid()) = uploaded_by)
with check (
  (select auth.uid()) = uploaded_by
  and is_public = false
);

create policy track_audio_delete_own
on jukebox.track_audio
for delete
to authenticated
using ((select auth.uid()) = uploaded_by);

-- A private bucket is required: public buckets bypass download RLS entirely.
update storage.buckets
set public = false,
    updated_at = now()
where id = 'jukebox-audio';

drop policy if exists "jukebox audio public read" on storage.objects;
drop policy if exists "jukebox audio auth upload" on storage.objects;
drop policy if exists "jukebox audio delete own" on storage.objects;

create policy "jukebox audio read own"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'jukebox-audio'
  and owner_id = (select auth.uid()::text)
);

create policy "jukebox audio upload own folder"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'jukebox-audio'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

create policy "jukebox audio delete own"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'jukebox-audio'
  and owner_id = (select auth.uid()::text)
);
