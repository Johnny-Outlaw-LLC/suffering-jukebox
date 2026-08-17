-- Community imports wrote youtube_video_id metrics but never seeded
-- jukebox.track_videos. Backfill primary rows so CSV exports, Versions,
-- and charts all see the same links.

with latest as (
  select distinct on (m.track_id, m.metric_name)
    m.track_id,
    m.metric_name,
    case
      when m.metric_name in ('youtube_video_id', 'youtube_thumbnail', 'youtube_title', 'youtube_channel')
        then m.metric_text_value
      else m.metric_value::text
    end as val,
    m.metric_date
  from jukebox.metrics m
  where m.metric_source = 'youtube'
    and m.metric_name in (
      'youtube_video_id', 'youtube_views', 'youtube_likes',
      'youtube_title', 'youtube_channel', 'youtube_thumbnail'
    )
  order by m.track_id, m.metric_name, m.metric_date desc
),
pivot as (
  select
    track_id,
    max(val) filter (where metric_name = 'youtube_video_id') as video_id,
    nullif(max(val) filter (where metric_name = 'youtube_views'), '')::bigint as view_count,
    nullif(max(val) filter (where metric_name = 'youtube_likes'), '')::bigint as like_count,
    max(val) filter (where metric_name = 'youtube_title') as title,
    max(val) filter (where metric_name = 'youtube_channel') as channel,
    max(val) filter (where metric_name = 'youtube_thumbnail') as thumbnail,
    max(metric_date) as stats_at
  from latest
  group by track_id
)
insert into jukebox.track_videos (
  track_id, video_id, title, channel, thumbnail,
  view_count, like_count, is_primary, source, label, stats_at, counts_for_charts
)
select
  p.track_id,
  p.video_id,
  p.title,
  p.channel,
  coalesce(p.thumbnail, 'https://i.ytimg.com/vi/' || p.video_id || '/mqdefault.jpg'),
  p.view_count,
  p.like_count,
  true,
  'sync',
  case when coalesce(p.channel, '') ilike '%- topic' then 'Original Audio' else null end,
  p.stats_at,
  true
from pivot p
where p.video_id is not null
  and not exists (
    select 1 from jukebox.track_videos tv
    where tv.track_id = p.track_id and tv.video_id = p.video_id
  );

-- Artist Details CSV: fall back to metrics when track_videos is empty.
create or replace function jukebox.my_artist_details(p_user text, p_scope text default 'mine')
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

  with unified_videos as (
    select
      tv.track_id,
      tv.video_id,
      tv.is_primary,
      tv.view_count,
      tv.created_at,
      1 as src_rank
    from jukebox.track_videos tv
    where tv.video_id is not null

    union all

    select
      m.track_id,
      m.metric_text_value as video_id,
      true as is_primary,
      null::bigint as view_count,
      m.metric_date as created_at,
      2 as src_rank
    from (
      select distinct on (track_id)
        track_id, metric_text_value, metric_date
      from jukebox.metrics
      where metric_source = 'youtube'
        and metric_name = 'youtube_video_id'
        and metric_text_value is not null
      order by track_id, metric_date desc
    ) m
    where not exists (
      select 1 from jukebox.track_videos tv2 where tv2.track_id = m.track_id
    )
  ),
  yt as (
    select
      s.track_id,
      min(s.url) filter (where s.rn = 1) as youtube_link,
      min(s.url) filter (where s.rn = 2) as secondary_youtube_link
    from (
      select
        uv.track_id,
        'https://www.youtube.com/watch?v=' || uv.video_id as url,
        row_number() over (
          partition by uv.track_id
          order by uv.src_rank asc, uv.is_primary desc nulls last,
                   uv.view_count desc nulls last, uv.created_at asc
        ) as rn
      from unified_videos uv
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
