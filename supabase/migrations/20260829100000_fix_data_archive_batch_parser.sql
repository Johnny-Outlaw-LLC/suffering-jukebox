-- The original validator over-escaped its regular expression, causing valid
-- numeric years submitted by the browser to be rejected before any rows moved.
create or replace function jukebox.set_listening_data_archive(
  p_user_id uuid,
  p_batches jsonb,
  p_archive boolean
)
returns jsonb
language plpgsql
security definer
set search_path = jukebox, auth, pg_catalog
as $function$
declare
  v_email text;
  v_spotify_years int[];
  v_jukebox_years int[];
  v_spotify_count bigint := 0;
  v_jukebox_count bigint := 0;
begin
  if p_user_id is null then raise exception 'user required'; end if;
  if jsonb_typeof(p_batches) <> 'array' or jsonb_array_length(p_batches) = 0 then
    raise exception 'at least one data batch is required';
  end if;
  if jsonb_array_length(p_batches) > 100 then raise exception 'too many data batches'; end if;

  select lower(nullif(trim(email), '')) into v_email from auth.users where id = p_user_id;

  with parsed as (
    select distinct
      lower(nullif(trim(value ->> 'source'), '')) as source,
      (value ->> 'year')::int as year
    from jsonb_array_elements(p_batches)
    where lower(coalesce(value ->> 'source', '')) in ('spotify', 'jukebox')
      and coalesce(value ->> 'year', '') ~ '^[0-9]{4}$'
  )
  select
    array_agg(year) filter (where source = 'spotify'),
    array_agg(year) filter (where source = 'jukebox')
  into v_spotify_years, v_jukebox_years
  from parsed;

  if coalesce(array_length(v_spotify_years, 1), 0) = 0
     and coalesce(array_length(v_jukebox_years, 1), 0) = 0 then
    raise exception 'valid source and year batches are required';
  end if;

  if coalesce(array_length(v_spotify_years, 1), 0) > 0 then
    update jukebox.spotify_history_events
    set deleted = p_archive, deleted_at = case when p_archive then now() else null end
    where user_id = p_user_id
      and extract(year from played_at at time zone 'America/Chicago')::int = any(v_spotify_years)
      and deleted is distinct from p_archive;
    get diagnostics v_spotify_count = row_count;
  end if;

  if coalesce(array_length(v_jukebox_years, 1), 0) > 0 and v_email is not null then
    update jukebox.play_events
    set deleted = p_archive, deleted_at = case when p_archive then now() else null end
    where lower(user_email) = v_email
      and event_type = 'play'
      and source is distinct from 'spotify'
      and extract(year from played_at at time zone 'America/Chicago')::int = any(v_jukebox_years)
      and deleted is distinct from p_archive;
    get diagnostics v_jukebox_count = row_count;
  end if;

  return jsonb_build_object('spotifyRecords', v_spotify_count, 'jukeboxRecords', v_jukebox_count, 'records', v_spotify_count + v_jukebox_count, 'archived', p_archive);
end;
$function$;

revoke all on function jukebox.set_listening_data_archive(uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function jukebox.set_listening_data_archive(uuid, jsonb, boolean) to service_role;
