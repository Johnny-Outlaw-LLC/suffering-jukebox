-- My Artist Details used to be "artists this user has played", so a newly
-- imported artist (Counting Crows) was missing while official catalogue
-- they had listened to (Silver Jews) showed up. Scope 'mine' is now the
-- artists / albums they added. Scope 'all' is the full catalogue.

drop function if exists jukebox.my_artist_details(text);

create function jukebox.my_artist_details(p_user text, p_scope text default 'mine')
returns jsonb
language plpgsql
security definer
set search_path to 'jukebox', 'public'
as $function$
declare
  v_user text := nullif(lower(trim(coalesce(p_user, ''))), '');
  v_all boolean := lower(trim(coalesce(p_scope, ''))) = 'all';
  v_result jsonb;
begin
  if v_user is null then
    return '[]'::jsonb;
  end if;

  with yt as (
    select
      s.track_id,
      min(s.url) filter (where s.rn = 1) as youtube_link,
      min(s.url) filter (where s.rn = 2) as secondary_youtube_link
    from (
      select
        tv.track_id,
        'https://www.youtube.com/watch?v=' || tv.video_id as url,
        row_number() over (
          partition by tv.track_id
          order by tv.is_primary desc nulls last, tv.view_count desc nulls last, tv.created_at asc
        ) as rn
      from jukebox.track_videos tv
      where tv.video_id is not null
    ) s
    where s.rn <= 2
    group by s.track_id
  ),
  link_agg as (
    select l.track_id, string_agg(l.url, ' | ' order by l.link_priority) as links
    from jukebox.links l
    group by l.track_id
  ),
  audio as (
    select ta.track_id, true as has_bg_audio, max(ta.file_bytes) as bg_audio_bytes
    from jukebox.track_audio ta
    group by ta.track_id
  ),
  play_tot as (
    select pe.track_id, count(*)::int as total_plays
    from jukebox.play_events pe
    where pe.event_type = 'play' and pe.track_id <> 'test-verify'
    group by pe.track_id
  ),
  my_play as (
    select pe.track_id, count(*)::int as my_plays, max(pe.played_at) as my_last_played
    from jukebox.play_events pe
    where pe.event_type = 'play' and lower(pe.user_email) = v_user
    group by pe.track_id
  ),
  base as (
    select
      ar.name as artist,
      al.name as album,
      to_char(al.release_date, 'YYYY') as album_year,
      t.id::text as track_id,
      t.name as track,
      t.duration_ms,
      t.created_at as date_added,
      la.links,
      yt.youtube_link,
      yt.secondary_youtube_link,
      coalesce(au.has_bg_audio, false) as has_bg_audio,
      au.bg_audio_bytes,
      coalesce(pt.total_plays, 0) as total_plays,
      coalesce(mp.my_plays, 0) as my_plays,
      mp.my_last_played
    from jukebox.tracks t
    join jukebox.albums al on al.id = t.album_id
    join jukebox.artists ar on ar.id = al.artist_id
    left join yt on yt.track_id = t.id
    left join link_agg la on la.track_id = t.id
    left join audio au on au.track_id = t.id::text
    left join play_tot pt on pt.track_id = t.id::text
    left join my_play mp on mp.track_id = t.id::text
    where v_all
       or lower(trim(coalesce(ar.added_by, ''))) = v_user
       or lower(trim(coalesce(al.added_by, ''))) = v_user
  )
  select coalesce(
    jsonb_agg(row_to_json(base)::jsonb order by base.artist, base.album, base.track),
    '[]'::jsonb
  )
  into v_result
  from base;

  return v_result;
end;
$function$;

revoke all on function jukebox.my_artist_details(text, text) from public, anon, authenticated;
grant execute on function jukebox.my_artist_details(text, text) to service_role;
