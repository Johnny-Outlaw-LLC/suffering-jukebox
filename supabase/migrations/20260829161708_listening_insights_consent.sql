-- The optional contribution setting is deliberately separate from importing
-- private listening history. It records a current preference and an audit
-- trail of affirmative choices without exposing either table to the browser.
create table if not exists jukebox.listening_insights_consents (
  user_id uuid primary key references auth.users(id) on delete cascade,
  contribute_spotify_history boolean not null default false,
  policy_version text not null,
  consented_at timestamptz,
  withdrawn_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table jukebox.listening_insights_consents enable row level security;
revoke all on table jukebox.listening_insights_consents from anon, authenticated;
grant all on table jukebox.listening_insights_consents to service_role;

create or replace function jukebox.set_listening_insights_consent(
  p_user_id uuid,
  p_contribute_spotify_history boolean,
  p_policy_version text
)
returns void
language plpgsql
security definer
set search_path = jukebox, pg_catalog
as $function$
begin
  if p_user_id is null then raise exception 'user required'; end if;
  if nullif(trim(p_policy_version), '') is null then raise exception 'policy version required'; end if;

  insert into jukebox.listening_insights_consents (
    user_id, contribute_spotify_history, policy_version, consented_at, withdrawn_at, updated_at
  ) values (
    p_user_id,
    p_contribute_spotify_history,
    trim(p_policy_version),
    case when p_contribute_spotify_history then now() else null end,
    case when p_contribute_spotify_history then null else now() end,
    now()
  )
  on conflict (user_id) do update set
    contribute_spotify_history = excluded.contribute_spotify_history,
    policy_version = excluded.policy_version,
    consented_at = case
      when excluded.contribute_spotify_history then now()
      else jukebox.listening_insights_consents.consented_at
    end,
    withdrawn_at = case when excluded.contribute_spotify_history then null else now() end,
    updated_at = now();
end;
$function$;

revoke all on function jukebox.set_listening_insights_consent(uuid, boolean, text) from public, anon, authenticated;
grant execute on function jukebox.set_listening_insights_consent(uuid, boolean, text) to service_role;

-- This is the only planned source for future commercial-insights work. It
-- excludes non-music activity and unconsented/deleted rows, omits user IDs and
-- exact timestamps, and suppresses groups smaller than 20 distinct listeners.
create or replace view jukebox.contributed_music_listening_insights
with (security_invoker = true)
as
  select
    date_trunc('month', e.played_at) as listening_month,
    e.artist,
    e.title,
    e.album,
    count(*)::bigint as listening_events,
    count(distinct e.user_id)::bigint as listeners,
    coalesce(sum(e.duration_played_ms), 0)::bigint as listening_duration_ms,
    count(*) filter (where e.skipped)::bigint as skipped_events
  from jukebox.spotify_history_events e
  join jukebox.listening_insights_consents c on c.user_id = e.user_id
  where c.contribute_spotify_history = true
    and e.deleted = false
    and e.content_type = 'music'
  group by 1, 2, 3, 4
  having count(distinct e.user_id) >= 20;

revoke all on jukebox.contributed_music_listening_insights from public, anon, authenticated;
grant select on jukebox.contributed_music_listening_insights to service_role;
