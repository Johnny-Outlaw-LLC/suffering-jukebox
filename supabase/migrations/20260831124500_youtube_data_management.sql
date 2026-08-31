create or replace function jukebox.listening_data_batches(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = jukebox, auth, pg_catalog
as $$
  with mine as (
    select lower(nullif(trim(email), '')) as email from auth.users where id = p_user_id
  ), batches as (
    select coalesce(e.history_source, 'spotify')::text as source,
      extract(year from e.played_at at time zone 'America/Chicago')::int as year,
      count(*) filter (where e.deleted = false)::bigint as active_records,
      count(*) filter (where e.deleted = true)::bigint as pending_deletion_records
    from jukebox.spotify_history_events e where e.user_id = p_user_id group by 1, 2
    union all
    select 'jukebox'::text,
      extract(year from pe.played_at at time zone 'America/Chicago')::int,
      count(*) filter (where pe.deleted = false)::bigint,
      count(*) filter (where pe.deleted = true)::bigint
    from jukebox.play_events pe join mine on mine.email is not null and lower(pe.user_email) = mine.email
    where pe.event_type = 'play' and pe.source is distinct from 'spotify' group by 1, 2
  )
  select jsonb_build_object('batches', coalesce((select jsonb_agg(jsonb_build_object(
    'source', source, 'year', year, 'activeRecords', active_records,
    'pendingDeletionRecords', pending_deletion_records) order by year desc, source) from batches), '[]'::jsonb));
$$;

create or replace function jukebox.set_listening_data_archive(p_user_id uuid, p_batches jsonb, p_archive boolean)
returns jsonb
language plpgsql
security definer
set search_path = jukebox, auth, pg_catalog
as $function$
declare
  v_email text; v_spotify_years int[]; v_youtube_years int[]; v_jukebox_years int[];
  v_spotify_count bigint := 0; v_youtube_count bigint := 0; v_jukebox_count bigint := 0;
begin
  if p_user_id is null then raise exception 'user required'; end if;
  if jsonb_typeof(p_batches) <> 'array' or jsonb_array_length(p_batches) = 0 then raise exception 'at least one data batch is required'; end if;
  if jsonb_array_length(p_batches) > 100 then raise exception 'too many data batches'; end if;
  select lower(nullif(trim(email), '')) into v_email from auth.users where id = p_user_id;
  with parsed as (
    select distinct lower(nullif(trim(value ->> 'source'), '')) as source, (value ->> 'year')::int as year
    from jsonb_array_elements(p_batches)
    where lower(coalesce(value ->> 'source', '')) in ('spotify', 'youtube', 'jukebox')
      and coalesce(value ->> 'year', '') ~ '^[0-9]{4}$'
  )
  select array_agg(year) filter (where source = 'spotify'),
    array_agg(year) filter (where source = 'youtube'),
    array_agg(year) filter (where source = 'jukebox')
  into v_spotify_years, v_youtube_years, v_jukebox_years from parsed;
  if coalesce(array_length(v_spotify_years, 1), 0) = 0 and coalesce(array_length(v_youtube_years, 1), 0) = 0 and coalesce(array_length(v_jukebox_years, 1), 0) = 0 then raise exception 'valid source and year batches are required'; end if;

  if coalesce(array_length(v_spotify_years, 1), 0) > 0 then
    update jukebox.spotify_history_events set deleted = p_archive, deleted_at = case when p_archive then now() else null end
    where user_id = p_user_id and coalesce(history_source, 'spotify') = 'spotify'
      and extract(year from played_at at time zone 'America/Chicago')::int = any(v_spotify_years) and deleted is distinct from p_archive;
    get diagnostics v_spotify_count = row_count;
  end if;
  if coalesce(array_length(v_youtube_years, 1), 0) > 0 then
    update jukebox.spotify_history_events set deleted = p_archive, deleted_at = case when p_archive then now() else null end
    where user_id = p_user_id and history_source = 'youtube'
      and extract(year from played_at at time zone 'America/Chicago')::int = any(v_youtube_years) and deleted is distinct from p_archive;
    get diagnostics v_youtube_count = row_count;
  end if;
  if coalesce(array_length(v_jukebox_years, 1), 0) > 0 and v_email is not null then
    update jukebox.play_events set deleted = p_archive, deleted_at = case when p_archive then now() else null end
    where lower(user_email) = v_email and event_type = 'play' and source is distinct from 'spotify'
      and extract(year from played_at at time zone 'America/Chicago')::int = any(v_jukebox_years) and deleted is distinct from p_archive;
    get diagnostics v_jukebox_count = row_count;
  end if;
  return jsonb_build_object('spotifyRecords', v_spotify_count, 'youtubeRecords', v_youtube_count,
    'jukeboxRecords', v_jukebox_count, 'records', v_spotify_count + v_youtube_count + v_jukebox_count, 'archived', p_archive);
end;
$function$;

revoke all on function jukebox.listening_data_batches(uuid) from public, anon, authenticated;
grant execute on function jukebox.listening_data_batches(uuid) to service_role;
revoke all on function jukebox.set_listening_data_archive(uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function jukebox.set_listening_data_archive(uuid, jsonb, boolean) to service_role;
