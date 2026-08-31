-- Who last saved a lyric/sync offset on a YouTube version.
alter table jukebox.track_videos
  add column if not exists lyric_offset_updated_by text,
  add column if not exists lyric_offset_updated_by_name text,
  add column if not exists lyric_offset_updated_at timestamptz;

create or replace function jukebox.set_video_lyric_offset(
  p_track_id uuid,
  p_video_id text,
  p_offset numeric
) returns numeric
language plpgsql
security definer
set search_path to 'jukebox', 'public'
as $function$
declare
  v_offset numeric;
begin
  if not jukebox.can_edit_track_videos(p_track_id) then
    raise exception 'Not allowed to retime lyrics for this track.';
  end if;
  -- Keep it sane: a lyric offset is a nudge, not a seek.
  v_offset := greatest(-600, least(600, round(coalesce(p_offset, 0)::numeric, 2)));
  update jukebox.track_videos
     set lyric_offset_seconds = v_offset,
         lyric_offset_updated_by = jukebox.jwt_email(),
         lyric_offset_updated_by_name = coalesce(
           nullif(btrim((select public_name from jukebox.app_users where email = jukebox.jwt_email() limit 1)), ''),
           jukebox.jwt_name()
         ),
         lyric_offset_updated_at = now()
   where track_id = p_track_id and video_id = p_video_id;
  if not found then
    raise exception 'That video is not on this track.';
  end if;
  return v_offset;
end;
$function$;

revoke all on function jukebox.set_video_lyric_offset(uuid, text, numeric) from public, anon;
grant execute on function jukebox.set_video_lyric_offset(uuid, text, numeric) to authenticated, service_role;
