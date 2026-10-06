-- Attribute native plays to their brand and Android Auto device without changing the existing RPC contract.
CREATE OR REPLACE FUNCTION jukebox.log_carplay_plays(p_plays jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'jukebox'
AS $function$
declare
  v_email text := jukebox.jwt_email();
  v_ins   int := 0;
  r       record;
  v_at    timestamptz;
  v_ms    bigint;
  v_dev   text;
begin
  if v_email is null then raise exception 'sign in required'; end if;
  if p_plays is null or jsonb_typeof(p_plays) <> 'array' then return 0; end if;

  for r in select * from jsonb_array_elements(p_plays) as e(v) limit 500 loop
    continue when coalesce(r.v ->> 'trackId', '') !~ '^[0-9a-fA-F-]{36}$';
    v_at := to_timestamp(coalesce((r.v ->> 'at')::double precision, 0));
    if v_at is null or v_at > now() + interval '1 hour' or v_at < now() - interval '90 days' then
      v_at := now();
    end if;
    v_ms  := greatest(0, least(coalesce((r.v ->> 'ms')::bigint, 0), 3600000));
    v_dev := (case when r.v ->> 'platform' = 'android' then 'androidauto:' else 'carplay:' end) || left(coalesce(r.v ->> 'deviceId', 'unknown'), 100);

    if exists (
      select 1 from jukebox.play_events pe
      where lower(pe.user_email) = v_email
        and pe.track_id = (r.v ->> 'trackId')
        and pe.event_type = 'play'
        and (pe.device_id like 'carplay:%' or pe.device_id like 'androidauto:%')
        and pe.played_at between v_at - interval '60 seconds' and v_at + interval '60 seconds'
    ) then
      continue;
    end if;

    insert into jukebox.play_events (
      track_id, artist_id, album_id, event_type, source, device_id,
      played_at, play_ended_at, duration_played_ms, listen_context, surface_id,
      user_email, user_name)
    select
      t.id::text, al.artist_id::text, t.album_id::text, 'play', 'audio', v_dev,
      v_at,
      case when v_ms > 0 then v_at + (v_ms || ' milliseconds')::interval end,
      nullif(v_ms, 0), 'native',
      case when lower(r.v ->> 'surfaceId') in ('sj','lp','rk') then lower(r.v ->> 'surfaceId') else null end,
      v_email, jukebox.jwt_name()
    from jukebox.tracks t
    left join jukebox.albums al on al.id = t.album_id
    where t.id = (r.v ->> 'trackId')::uuid;

    v_ins := v_ins + 1;
  end loop;

  return v_ins;
end;
$function$;
