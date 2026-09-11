-- Stamp which brand recorded a play, sync shuffle across sister sites, and
-- split Listening Party / Suffering Jukebox in listening_analytics the way
-- Spotify already is.

-- ── play_events.surface_id ────────────────────────────────────────────────
alter table jukebox.play_events
  add column if not exists surface_id text;

alter table jukebox.play_events
  drop constraint if exists play_events_surface_id_check;

alter table jukebox.play_events
  add constraint play_events_surface_id_check
  check (surface_id is null or surface_id in ('sj', 'lp'));

comment on column jukebox.play_events.surface_id is
  'Brand that recorded the play: sj = Suffering Jukebox, lp = Listening Party. Null = legacy (counted as sj).';

create index if not exists play_events_surface_id_idx
  on jukebox.play_events (surface_id)
  where surface_id is not null;

-- ── app_users link + synced shuffle ───────────────────────────────────────
alter table jukebox.app_users
  add column if not exists link_sister_site boolean not null default false;

alter table jukebox.app_users
  add column if not exists shuffle_preference text;

alter table jukebox.app_users
  drop constraint if exists app_users_shuffle_preference_check;

alter table jukebox.app_users
  add constraint app_users_shuffle_preference_check
  check (shuffle_preference is null
     or shuffle_preference in ('discovery', 'favorites', 'less_repeats', 'none'));

comment on column jukebox.app_users.link_sister_site is
  'When true, shuffle preference (and future playback prefs) sync between Suffering Jukebox and Listening Party.';

-- ── log_play_event: accept surface ─────────────────────────────────────────
-- Drop the live 7-arg form first so the new trailing param is not an
-- ambiguous overload. Named-arg callers that omit p_surface_id still work.
drop function if exists jukebox.log_play_event(text, text, text, text, text, text, integer);

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

  insert into jukebox.play_events (
    track_id, artist_id, album_id, event_type, source, device_id,
    rating_at_play, surface_id, ip_address, user_email, user_name)
  values (
    left(p_track_id, 64), left(p_artist_id, 64), left(p_album_id, 64),
    coalesce(p_event_type, 'card_open'), p_source, left(p_device_id, 128),
    p_rating_at_play, v_surface,
    jukebox.request_ip(), jukebox.jwt_email(), jukebox.jwt_name())
  returning id into v_id;

  return v_id;
end;
$function$;

revoke all on function jukebox.log_play_event(text, text, text, text, text, text, integer, text) from public;
grant execute on function jukebox.log_play_event(text, text, text, text, text, text, integer, text) to anon, authenticated, service_role;

-- ── my_settings / set_my_settings ─────────────────────────────────────────
drop function if exists jukebox.set_my_settings(text, text, text);

create or replace function jukebox.my_settings()
returns jsonb
language plpgsql
security definer
set search_path to 'jukebox'
as $function$
declare
  v_email text := lower(jukebox.jwt_email());
  r jukebox.app_users%rowtype;
begin
  if v_email is null then
    raise exception 'Sign in to read your settings.';
  end if;
  select * into r from jukebox.app_users where email = v_email;
  if not found then
    return jsonb_build_object(
      'email', v_email, 'publicName', null, 'googleName', null,
      'displayName', null, 'avatarUrl', null, 'defaultImportVisibility', 'public',
      'linkSisterSite', false, 'shufflePreference', null);
  end if;
  return jsonb_build_object(
    'email', r.email,
    'publicName', r.public_name,
    'googleName', r.user_name,
    'displayName', coalesce(nullif(btrim(r.public_name), ''), r.user_name),
    'avatarUrl', r.avatar_url,
    'defaultImportVisibility', coalesce(r.default_import_visibility, 'public'),
    'linkSisterSite', coalesce(r.link_sister_site, false),
    'shufflePreference', r.shuffle_preference);
end;
$function$;

create or replace function jukebox.set_my_settings(
  p_public_name text default null,
  p_avatar_url text default null,
  p_default_visibility text default null,
  p_link_sister_site boolean default null,
  p_shuffle_preference text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'jukebox'
as $function$
declare
  v_email text := lower(jukebox.jwt_email());
  v_name  text;
  v_av    text;
  v_vis   text;
  v_shuf  text := lower(nullif(btrim(coalesce(p_shuffle_preference, '')), ''));
  v_eff   text;
  v_link  boolean;
  v_old_link boolean;
  v_old_shuf text;
  v_old_name text;
  v_old_av text;
  v_old_vis text;
  v_touch_name boolean := (p_public_name is not null);
  v_touch_av boolean := (p_avatar_url is not null);
  v_touch_vis boolean := (p_default_visibility is not null);
begin
  if v_email is null then
    raise exception 'Sign in to change your settings.';
  end if;

  select coalesce(link_sister_site, false), shuffle_preference,
         public_name, avatar_url, coalesce(default_import_visibility, 'public')
    into v_old_link, v_old_shuf, v_old_name, v_old_av, v_old_vis
  from jukebox.app_users where email = v_email;
  if not found then
    v_old_link := false;
    v_old_shuf := null;
    v_old_name := null;
    v_old_av := null;
    v_old_vis := 'public';
  end if;

  -- null arg = leave alone (Integrations can save without rewriting Profile).
  -- empty string for name/avatar still clears, which is what Settings Save sends.
  v_name := case when v_touch_name then nullif(btrim(p_public_name), '') else v_old_name end;
  v_av := case when v_touch_av then nullif(btrim(p_avatar_url), '') else v_old_av end;
  v_vis := case
    when v_touch_vis then lower(btrim(coalesce(p_default_visibility, 'public')))
    else v_old_vis
  end;

  if v_name is not null and (char_length(v_name) < 2 or char_length(v_name) > 40) then
    raise exception 'A public name is between 2 and 40 characters.';
  end if;
  if v_av is not null then
    if v_av !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' then
      raise exception 'That picture is not in a format we can store.';
    end if;
    if char_length(v_av) > 80000 then
      raise exception 'That picture is too large. Pick a smaller one.';
    end if;
  end if;
  if v_vis not in ('public', 'private') then v_vis := 'public'; end if;
  if v_shuf is not null and v_shuf not in ('discovery', 'favorites', 'less_repeats', 'none') then
    raise exception 'Unknown shuffle preference.';
  end if;

  v_link := coalesce(p_link_sister_site, v_old_link, false);

  insert into jukebox.app_users (
    email, public_name, avatar_url, default_import_visibility,
    link_sister_site, shuffle_preference, last_seen_at)
  values (
    v_email, v_name, v_av, v_vis,
    v_link,
    coalesce(v_shuf, v_old_shuf),
    now())
  on conflict (email) do update
    set public_name = excluded.public_name,
        avatar_url = excluded.avatar_url,
        default_import_visibility = excluded.default_import_visibility,
        link_sister_site = coalesce(p_link_sister_site, jukebox.app_users.link_sister_site),
        shuffle_preference = case
          when p_shuffle_preference is not null then v_shuf
          else jukebox.app_users.shuffle_preference
        end,
        last_seen_at = now();

  select coalesce(nullif(btrim(public_name), ''), user_name) into v_eff
  from jukebox.app_users where email = v_email;

  if v_eff is not null then
    update jukebox.artists        set added_by_name  = v_eff where lower(added_by) = v_email       and added_by_name  is distinct from v_eff;
    update jukebox.albums         set added_by_name  = v_eff where lower(added_by) = v_email       and added_by_name  is distinct from v_eff;
    update jukebox.track_videos   set added_by_name  = v_eff where lower(added_by) = v_email       and added_by_name  is distinct from v_eff;
    update jukebox.playlists      set user_name      = v_eff where lower(user_email) = v_email     and user_name      is distinct from v_eff;
    update jukebox.playlist_tracks set added_by_name = v_eff where lower(added_by_email) = v_email and added_by_name  is distinct from v_eff;
    update jukebox.comments       set user_name      = v_eff where lower(user_email) = v_email     and user_name      is distinct from v_eff;
    update jukebox.play_events    set user_name      = v_eff where lower(user_email) = v_email     and user_name      is distinct from v_eff;
    update jukebox.rating_events  set user_name      = v_eff where lower(user_email) = v_email     and user_name      is distinct from v_eff;
    update jukebox.jukebox_queue q set added_by_name = v_eff
      from jukebox.jukeboxes j
      where q.jukebox_id = j.id and q.added_by_owner
        and lower(j.owner_email) = v_email
        and q.added_by_name is distinct from v_eff;
  end if;

  return jukebox.my_settings();
end;
$function$;

revoke all on function jukebox.my_settings() from public;
grant execute on function jukebox.my_settings() to authenticated;

revoke all on function jukebox.set_my_settings(text, text, text, boolean, text) from public;
grant execute on function jukebox.set_my_settings(text, text, text, boolean, text) to authenticated;

-- ── listening_analytics: sj / lp / spotify split ───────────────────────────
drop function if exists jukebox.listening_analytics(uuid, text, text, timestamptz, timestamptz, text[], text[], text);
drop function if exists jukebox.listening_analytics(uuid, text, text, timestamptz, timestamptz, text[], text, text[], text, text);

create or replace function jukebox.listening_analytics(
  p_user_id uuid,
  p_tz text default 'America/Chicago',
  p_source text default 'all',
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_artists text[] default null,
  p_artists_mode text default 'include',
  p_tracks text[] default null,
  p_tracks_mode text default 'include',
  p_bucket text default 'auto'
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'jukebox', 'auth', 'pg_catalog'
as $function$
declare
  v_tz text := coalesce(nullif(trim(p_tz), ''), 'America/Chicago');
  v_source text := lower(coalesce(nullif(trim(p_source), ''), 'all'));
  v_bucket text := lower(coalesce(nullif(trim(p_bucket), ''), 'auto'));
  v_artists text[] := p_artists;
  v_tracks text[] := p_tracks;
  v_artists_mode text := case when lower(coalesce(p_artists_mode, '')) = 'exclude' then 'exclude' else 'include' end;
  v_tracks_mode text := case when lower(coalesce(p_tracks_mode, '')) = 'exclude' then 'exclude' else 'include' end;
  v_email text;
  v_result jsonb;
begin
  if p_user_id is null then
    raise exception 'user required';
  end if;
  if v_source not in ('all', 'jukebox', 'sj', 'lp', 'spotify') then
    v_source := 'all';
  end if;
  if v_bucket not in ('auto', 'day', 'week', 'month', 'year') then
    v_bucket := 'auto';
  end if;
  begin
    perform now() at time zone v_tz;
  exception when others then
    v_tz := 'America/Chicago';
  end;

  select lower(nullif(trim(u.email), '')) into v_email
  from auth.users u
  where u.id = p_user_id;

  with base as (
    select
      e.played_at,
      greatest(coalesce(e.duration_played_ms, 0), 0)::bigint as ms,
      coalesce(nullif(trim(e.artist), ''), 'Unknown artist') as artist,
      coalesce(nullif(trim(e.title), ''), 'Unknown track') as title,
      nullif(trim(e.album), '') as album,
      coalesce(e.skipped, false) as skipped,
      'spotify'::text as listen_source
    from jukebox.spotify_history_events e
    where e.user_id = p_user_id
      and v_source in ('all', 'spotify')

    union all

    -- Native plays. surface_id null = pre-stamp history, counted as Suffering
    -- Jukebox (the site that existed when those rows were written).
    select
      pe.played_at,
      greatest(coalesce(nullif(pe.duration_played_ms, 0), t.duration_ms, 0), 0)::bigint as ms,
      coalesce(nullif(trim(ar.name), ''), 'Unknown artist') as artist,
      coalesce(nullif(trim(t.name), ''), 'Unknown track') as title,
      nullif(trim(al.name), '') as album,
      false as skipped,
      case when coalesce(pe.surface_id, 'sj') = 'lp' then 'lp' else 'sj' end as listen_source
    from jukebox.play_events pe
    left join jukebox.tracks t on t.id::text = pe.track_id
    left join jukebox.albums al on al.id::text = coalesce(nullif(pe.album_id, ''), t.album_id::text)
    left join jukebox.artists ar on ar.id::text = coalesce(nullif(pe.artist_id, ''), al.artist_id::text)
    where v_source in ('all', 'jukebox', 'sj', 'lp')
      and v_email is not null
      and lower(pe.user_email) = v_email
      and pe.event_type = 'play'
      and pe.source is distinct from 'spotify'
      and (
        v_source in ('all', 'jukebox')
        or (v_source = 'sj' and coalesce(pe.surface_id, 'sj') = 'sj')
        or (v_source = 'lp' and coalesce(pe.surface_id, 'sj') = 'lp')
      )
  ),
  tagged as (
    select
      b.*,
      (b.played_at at time zone v_tz) as local_ts,
      b.artist || chr(31) || b.title as track_key,
      case when b.listen_source = 'spotify' then b.ms else 0 end as spotify_ms,
      case when b.listen_source = 'sj' then b.ms else 0 end as sj_ms,
      case when b.listen_source = 'lp' then b.ms else 0 end as lp_ms,
      case when b.listen_source in ('sj', 'lp') then b.ms else 0 end as jukebox_ms
    from base b
  ),
  bounds as (
    select min(played_at) as first_played_at, max(played_at) as last_played_at, count(*)::bigint as events
    from tagged
  ),
  dated as (
    select * from tagged
    where (p_from is null or played_at >= p_from)
      and (p_to is null or played_at < p_to)
  ),
  artist_scope as (
    select * from dated
    where v_tracks is null
      or (v_tracks_mode = 'include' and track_key = any(v_tracks))
      or (v_tracks_mode = 'exclude' and track_key <> all(v_tracks))
  ),
  track_scope as (
    select * from dated
    where v_artists is null
      or (v_artists_mode = 'include' and artist = any(v_artists))
      or (v_artists_mode = 'exclude' and artist <> all(v_artists))
  ),
  mine as (
    select * from track_scope
    where v_tracks is null
      or (v_tracks_mode = 'include' and track_key = any(v_tracks))
      or (v_tracks_mode = 'exclude' and track_key <> all(v_tracks))
  ),
  span as (select min(local_ts) as mn, max(local_ts) as mx from mine),
  buck as (
    select case
      when v_bucket <> 'auto' then v_bucket
      when mn is null then 'month'
      when (mx::date - mn::date) <= 62 then 'day'
      when (mx::date - mn::date) <= 400 then 'week'
      when (mx::date - mn::date) <= 3700 then 'month'
      else 'year'
    end as b
    from span
  ),
  totals as (
    select
      count(*)::bigint as events,
      coalesce(sum(ms), 0)::bigint as duration_ms,
      coalesce(sum(spotify_ms), 0)::bigint as spotify_ms,
      coalesce(sum(sj_ms), 0)::bigint as sj_ms,
      coalesce(sum(lp_ms), 0)::bigint as lp_ms,
      coalesce(sum(jukebox_ms), 0)::bigint as jukebox_ms,
      count(distinct artist)::bigint as artists,
      count(distinct track_key)::bigint as tracks,
      count(distinct case when album is not null then artist || chr(31) || album end)::bigint as albums,
      min(played_at) as first_played_at,
      max(played_at) as last_played_at,
      count(*) filter (where skipped)::bigint as skipped,
      count(*) filter (where listen_source = 'spotify')::bigint as spotify_events,
      count(*) filter (where listen_source = 'sj')::bigint as sj_events,
      count(*) filter (where listen_source = 'lp')::bigint as lp_events,
      count(*) filter (where listen_source in ('sj', 'lp'))::bigint as jukebox_events,
      count(distinct local_ts::date)::bigint as active_days
    from mine
  ),
  series as (
    select
      to_char(date_trunc((select b from buck), local_ts), 'YYYY-MM-DD') as bucket_start,
      count(*)::bigint as events,
      coalesce(sum(ms), 0)::bigint as duration_ms,
      coalesce(sum(spotify_ms), 0)::bigint as spotify_ms,
      coalesce(sum(sj_ms), 0)::bigint as sj_ms,
      coalesce(sum(lp_ms), 0)::bigint as lp_ms,
      coalesce(sum(jukebox_ms), 0)::bigint as jukebox_ms,
      count(*) filter (where listen_source = 'spotify')::bigint as spotify_events,
      count(*) filter (where listen_source = 'sj')::bigint as sj_events,
      count(*) filter (where listen_source = 'lp')::bigint as lp_events,
      count(*) filter (where listen_source in ('sj', 'lp'))::bigint as jukebox_events
    from mine
    group by 1
    order by 1
  ),
  calendar as (
    select
      to_char(local_ts::date, 'YYYY-MM-DD') as day,
      count(*)::bigint as events,
      coalesce(sum(ms), 0)::bigint as duration_ms,
      coalesce(sum(spotify_ms), 0)::bigint as spotify_ms,
      coalesce(sum(sj_ms), 0)::bigint as sj_ms,
      coalesce(sum(lp_ms), 0)::bigint as lp_ms,
      coalesce(sum(jukebox_ms), 0)::bigint as jukebox_ms,
      count(*) filter (where listen_source = 'spotify')::bigint as spotify_events,
      count(*) filter (where listen_source = 'sj')::bigint as sj_events,
      count(*) filter (where listen_source = 'lp')::bigint as lp_events,
      count(*) filter (where listen_source in ('sj', 'lp'))::bigint as jukebox_events
    from mine
    group by 1
    order by 1
  ),
  top_artists as (
    select
      artist,
      count(*)::bigint as events,
      coalesce(sum(ms), 0)::bigint as duration_ms,
      coalesce(sum(spotify_ms), 0)::bigint as spotify_ms,
      coalesce(sum(sj_ms), 0)::bigint as sj_ms,
      coalesce(sum(lp_ms), 0)::bigint as lp_ms,
      coalesce(sum(jukebox_ms), 0)::bigint as jukebox_ms,
      count(distinct track_key)::bigint as tracks,
      count(*) filter (where listen_source = 'spotify')::bigint as spotify_events,
      count(*) filter (where listen_source = 'sj')::bigint as sj_events,
      count(*) filter (where listen_source = 'lp')::bigint as lp_events,
      count(*) filter (where listen_source in ('sj', 'lp'))::bigint as jukebox_events
    from artist_scope
    group by 1
    order by 3 desc, 2 desc, 1 asc
    limit 40
  ),
  top_tracks as (
    select
      track_key as key,
      title,
      artist,
      count(*)::bigint as events,
      coalesce(sum(ms), 0)::bigint as duration_ms,
      coalesce(sum(spotify_ms), 0)::bigint as spotify_ms,
      coalesce(sum(sj_ms), 0)::bigint as sj_ms,
      coalesce(sum(lp_ms), 0)::bigint as lp_ms,
      coalesce(sum(jukebox_ms), 0)::bigint as jukebox_ms,
      count(*) filter (where listen_source = 'spotify')::bigint as spotify_events,
      count(*) filter (where listen_source = 'sj')::bigint as sj_events,
      count(*) filter (where listen_source = 'lp')::bigint as lp_events,
      count(*) filter (where listen_source in ('sj', 'lp'))::bigint as jukebox_events
    from track_scope
    group by 1, 2, 3
    order by 5 desc, 4 desc, 2 asc
    limit 40
  ),
  by_hour_dow as (
    select
      extract(dow from local_ts)::int as dow,
      extract(hour from local_ts)::int as hour,
      count(*)::bigint as events,
      coalesce(sum(ms), 0)::bigint as duration_ms,
      coalesce(sum(spotify_ms), 0)::bigint as spotify_ms,
      coalesce(sum(sj_ms), 0)::bigint as sj_ms,
      coalesce(sum(lp_ms), 0)::bigint as lp_ms,
      coalesce(sum(jukebox_ms), 0)::bigint as jukebox_ms,
      count(*) filter (where listen_source = 'spotify')::bigint as spotify_events,
      count(*) filter (where listen_source = 'sj')::bigint as sj_events,
      count(*) filter (where listen_source = 'lp')::bigint as lp_events,
      count(*) filter (where listen_source in ('sj', 'lp'))::bigint as jukebox_events
    from mine
    group by 1, 2
    order by 1, 2
  ),
  artist_options as (
    select artist, count(*)::bigint as events, coalesce(sum(ms), 0)::bigint as duration_ms
    from artist_scope group by 1 order by 3 desc, 2 desc, 1 asc limit 3000
  ),
  track_options as (
    select track_key as key, title, artist, count(*)::bigint as events, coalesce(sum(ms), 0)::bigint as duration_ms
    from track_scope group by 1, 2, 3 order by 5 desc, 4 desc, 2 asc limit 1500
  )
  select jsonb_build_object(
    'tz', v_tz,
    'source', v_source,
    'bucket', (select b from buck),
    'bucketMode', v_bucket,
    'from', p_from,
    'to', p_to,
    'bounds', (select to_jsonb(b) from bounds b),
    'available', jsonb_build_object(
      'spotify', exists (select 1 from jukebox.spotify_history_events e where e.user_id = p_user_id),
      'sj', v_email is not null and exists (
        select 1 from jukebox.play_events pe
        where lower(pe.user_email) = v_email and pe.event_type = 'play'
          and pe.source is distinct from 'spotify'
          and coalesce(pe.surface_id, 'sj') = 'sj'
      ),
      'lp', v_email is not null and exists (
        select 1 from jukebox.play_events pe
        where lower(pe.user_email) = v_email and pe.event_type = 'play'
          and pe.source is distinct from 'spotify'
          and pe.surface_id = 'lp'
      ),
      'jukebox', v_email is not null and exists (
        select 1 from jukebox.play_events pe
        where lower(pe.user_email) = v_email and pe.event_type = 'play' and pe.source is distinct from 'spotify'
      )
    ),
    'totals', (select to_jsonb(t) from totals t),
    'series', coalesce((select jsonb_agg(to_jsonb(x) order by x.bucket_start) from series x), '[]'::jsonb),
    'calendar', coalesce((select jsonb_agg(to_jsonb(x) order by x.day) from calendar x), '[]'::jsonb),
    'topArtists', coalesce((
      select jsonb_agg(to_jsonb(x) || jsonb_build_object('in_jukebox', exists (
        select 1 from jukebox.artists a where lower(a.name) = lower(x.artist)
      )))
      from top_artists x
    ), '[]'::jsonb),
    'topTracks', coalesce((
      select jsonb_agg(to_jsonb(x) || jsonb_build_object('in_jukebox', exists (
        select 1
        from jukebox.tracks t
        join jukebox.albums al on al.id = t.album_id
        join jukebox.artists a on a.id = al.artist_id
        where lower(a.name) = lower(x.artist)
          and position(lower(x.title) in lower(t.name)) > 0
          and length(x.title) * 100 >= length(t.name) * 40
      )))
      from top_tracks x
    ), '[]'::jsonb),
    'byHourDow', coalesce((select jsonb_agg(to_jsonb(x) order by x.dow, x.hour) from by_hour_dow x), '[]'::jsonb),
    'artistOptions', coalesce((select jsonb_agg(to_jsonb(x)) from artist_options x), '[]'::jsonb),
    'trackOptions', coalesce((select jsonb_agg(to_jsonb(x)) from track_options x), '[]'::jsonb)
  ) into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$function$;

revoke all on function jukebox.listening_analytics(uuid, text, text, timestamptz, timestamptz, text[], text, text[], text, text) from public;
grant execute on function jukebox.listening_analytics(uuid, text, text, timestamptz, timestamptz, text[], text, text[], text, text) to service_role;
