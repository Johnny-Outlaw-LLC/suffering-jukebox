-- Later importers (content_access) may fine-tune / manage an artist without
-- taking over artists.added_by. Fixes the Chris Stapleton case: Susan imported
-- five public albums onto Church Street Studio's private single, got a
-- content_access row, but could not fine-tune because can_manage keyed only
-- on added_by.

create or replace function jukebox.can_manage_artist(p_artist_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'jukebox', 'public'
as $function$
  select case
    when jukebox.jwt_email() is null then false
    else exists (
      select 1 from jukebox.artists a
      where a.id = p_artist_id
        and lower(jukebox.jwt_email()) = lower(nullif(a.added_by, ''))
    )
    or exists (
      select 1 from jukebox.content_access ca
      where ca.artist_id = p_artist_id
        and lower(ca.user_email) = jukebox.jwt_email()
    )
  end;
$function$;

grant execute on function jukebox.can_manage_artist(uuid) to anon, authenticated;
