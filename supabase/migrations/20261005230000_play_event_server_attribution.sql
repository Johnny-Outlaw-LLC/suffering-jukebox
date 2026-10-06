-- play_events.artist_id was null on 98% of rows and album_id on 22%.
-- log_play_event stored whatever the client's in-memory track row carried,
-- and artist uploads and playlist tracks usually carry neither. The app's own
-- totals survived because they join through tracks -> albums, but anything
-- that reads the columns directly (artist stats, the daily sparkline, which
-- filters album_id=not.is.null) undercounted badly. Nouns Group showed 1 play
-- by artist_id against 292 by track.
--
-- The server knows the answer, so it decides. The client's values are kept
-- only as a fallback for ids that are not catalogue tracks.

create or replace function jukebox.log_play_event(
  p_track_id text,
  p_artist_id text default null,
  p_album_id text default null,
  p_event_type text default 'card_open',
  p_source text default null,
  p_device_id text default null,
  p_rating_at_play integer default null,
  p_surface_id text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'jukebox'
as $function$
declare
  v_id uuid;
  v_surface text := lower(nullif(trim(coalesce(p_surface_id, '')), ''));
  v_artist text;
  v_album text;
begin
  if coalesce(trim(p_track_id), '') = '' then
    raise exception 'track_id is required';
  end if;
  if coalesce(p_event_type, 'card_open') not in ('card_open', 'play', 'queue') then
    raise exception 'invalid event_type';
  end if;
  if p_source is not null and p_source not in ('video', 'audio', 'spotify') then
    raise exception 'invalid source';
  end if;
  if v_surface is not null and v_surface not in ('sj', 'lp') then
    raise exception 'invalid surface_id';
  end if;

  if p_track_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select al.artist_id::text, t.album_id::text
      into v_artist, v_album
      from jukebox.tracks t
      left join jukebox.albums al on al.id = t.album_id
     where t.id = p_track_id::uuid;
  end if;

  insert into jukebox.play_events (
    track_id, artist_id, album_id, event_type, source, device_id,
    rating_at_play, surface_id, ip_address, user_email, user_name)
  values (
    left(p_track_id, 64),
    coalesce(v_artist, left(nullif(p_artist_id, ''), 64)),
    coalesce(v_album, left(nullif(p_album_id, ''), 64)),
    coalesce(p_event_type, 'card_open'), p_source, left(p_device_id, 128),
    p_rating_at_play, v_surface,
    jukebox.request_ip(), jukebox.jwt_email(), jukebox.jwt_name())
  returning id into v_id;

  return v_id;
end;
$function$;

-- Backfill the history. Only nulls are filled, and the rows touched are kept
-- with their original values so this can be undone.
create table if not exists jukebox.play_events_attribution_backup_20261005 as
  select id, artist_id, album_id
    from jukebox.play_events
   where artist_id is null or album_id is null;

alter table jukebox.play_events_attribution_backup_20261005 enable row level security;
revoke all on jukebox.play_events_attribution_backup_20261005 from anon, authenticated;

update jukebox.play_events pe
   set artist_id = coalesce(pe.artist_id, al.artist_id::text),
       album_id  = coalesce(pe.album_id, t.album_id::text)
  from jukebox.tracks t
  left join jukebox.albums al on al.id = t.album_id
 where (pe.artist_id is null or pe.album_id is null)
   -- Text comparison, not pe.track_id::uuid: Postgres does not promise to
   -- evaluate a guard before the cast, and 'test-verify' rows would abort it.
   and t.id::text = pe.track_id;
