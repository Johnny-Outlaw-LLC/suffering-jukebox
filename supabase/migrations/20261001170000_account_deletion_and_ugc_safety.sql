-- In-app account deletion, user blocking and content reports.
--
-- App Store Review (Guidelines 5.1.1(v) and 1.2) requires an app that lets
-- people create an account to let them delete it from inside the app, and an
-- app that shows content made by other people to let them report it and block
-- whoever made it.
--
-- The sign-in (auth.users) is shared by every Outlaw Apps product on this
-- project, so deleting a Listening Party account must NOT delete the auth user:
-- that would also delete the person's ShutterField, Dumb Zone and other
-- accounts. Deleting an account here removes everything the jukebox schema
-- holds about the person instead. Signing in again later starts an empty
-- account.
--
-- Kept on purpose, because they are legal records rather than account data:
-- signed artist rights agreements and their events, and copyright notices and
-- the actions taken on them.

create table if not exists jukebox.user_blocks (
  blocker_email text not null,
  blocked_email text not null,
  created_at    timestamptz not null default now(),
  primary key (blocker_email, blocked_email),
  check (blocker_email <> blocked_email)
);
alter table jukebox.user_blocks enable row level security;
-- No policies: read and written only by the service role through /api/sj-ugc.

create table if not exists jukebox.content_reports (
  id               uuid primary key default gen_random_uuid(),
  reporter_email   text,
  reporter_user_id uuid,
  playlist_id      uuid,
  playlist_name    text,
  reported_email   text,
  reason           text not null,
  details          text,
  status           text not null default 'open' check (status in ('open', 'removed', 'dismissed')),
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz
);
create index if not exists content_reports_open_idx on jukebox.content_reports (created_at desc) where status = 'open';
alter table jukebox.content_reports enable row level security;

-- New tables in this schema get no default grants for the service role.
grant select, insert, update, delete on jukebox.user_blocks to service_role;
grant select, insert, update, delete on jukebox.content_reports to service_role;

create or replace function jukebox.delete_account_data(p_user_id uuid, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = jukebox, pg_temp
as $$
declare
  e text := lower(trim(coalesce(p_email, '')));
  audio_paths text[];
begin
  if p_user_id is null or e = '' then
    raise exception 'delete_account_data needs both a user id and an email';
  end if;

  -- Uploaded audio: the caller deletes the files from storage, so hand back
  -- their paths before the rows go.
  select coalesce(array_agg(storage_path), '{}') into audio_paths
    from track_audio where uploaded_by = p_user_id or lower(uploader_email) = e;
  delete from track_audio where uploaded_by = p_user_id or lower(uploader_email) = e;

  -- Playlists the person owns (tracks, grants and invites cascade), and their
  -- access to everyone else's.
  delete from playlists where lower(user_email) = e;
  delete from playlist_access where lower(recipient_email) = e;
  delete from playlist_grants where lower(principal) = e;
  update playlist_tracks set added_by_email = null, added_by_name = null where lower(added_by_email) = e;

  -- Online Jukeboxes they host (guests, queue and plays cascade), and their
  -- seat in other people's.
  delete from jukeboxes where lower(owner_email) = e;
  update jukebox_queue set added_by_name = 'Guest'
    where guest_id in (select id from jukebox_guests where user_id = p_user_id or lower(user_email) = e);
  delete from jukebox_guests where user_id = p_user_id or lower(user_email) = e;
  update my_jukebox_plays set played_by_user = null where played_by_user = p_user_id;

  -- Personal history, preferences and devices.
  delete from feedback where user_id = p_user_id or lower(user_email) = e;
  delete from play_events where lower(user_email) = e;
  delete from rating_events where lower(user_email) = e;
  delete from track_reactions where user_id = p_user_id;
  delete from lyric_reactions where user_id = p_user_id;
  delete from comments where user_id = p_user_id or lower(user_email) = e;
  delete from blocked_tracks where user_id = p_user_id or lower(user_email) = e;
  delete from playback_state where user_id = p_user_id or lower(user_email) = e;
  delete from carplay_keys where user_id = p_user_id;
  delete from carplay_queue where user_id = p_user_id;
  delete from spotify_history_events where user_id = p_user_id;
  delete from listening_insights_consents where user_id = p_user_id;
  delete from bg_entitlements where user_id = p_user_id or lower(email) = e;
  delete from content_access where lower(user_email) = e;
  delete from yt_search_quota where lower(user_email) = e;
  delete from shared_links where lower(shared_by_email) = e;
  delete from page_views where lower(user_email) = e;
  delete from perf_events where user_id = p_user_id or lower(email) = e;
  delete from product_events where user_id = p_user_id or lower(email) = e;
  delete from artist_upload_grants where lower(user_email) = e;
  delete from artist_upload_releases where user_id = p_user_id;
  delete from artist_upload_tracks where user_id = p_user_id;
  delete from user_blocks where blocker_email = e or blocked_email = e;

  -- Things that stay because other people use them, with the person's name
  -- taken off: catalog entries they added, lyric fixes, problem reports.
  update artists set added_by = null, added_by_name = null where lower(added_by) = e;
  update artists set artist_upload_created_by = null where artist_upload_created_by = p_user_id;
  update albums set added_by = null, added_by_name = null where lower(added_by) = e;
  update track_videos set added_by = null, added_by_name = null where lower(added_by) = e;
  update track_videos set lyric_offset_updated_by = null, lyric_offset_updated_by_name = null
    where lower(lyric_offset_updated_by) = e;
  update research_items set added_by = null, added_by_name = null where lower(added_by) = e;
  update lyrics_edits set editor_email = null, editor_name = null where lower(editor_email) = e;
  update issues set user_email = null, user_id = null, reporter_name = null
    where user_id = p_user_id or lower(user_email) = e;
  update track_volume set set_by = null where set_by = p_user_id;
  update content_reports set reporter_email = null, reporter_user_id = null
    where reporter_user_id = p_user_id or reporter_email = e;

  delete from app_users where lower(email) = e;

  return jsonb_build_object('audio_paths', to_jsonb(audio_paths));
end;
$$;

revoke all on function jukebox.delete_account_data(uuid, text) from public, anon, authenticated;
grant execute on function jukebox.delete_account_data(uuid, text) to service_role;
