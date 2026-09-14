-- The shared smoke-test account: testing@shutterfield.com.
--
-- It is Shutterfield's login on the same Supabase project, and its password is
-- Shutterfield's to set (SHUTTERFIELD_TEST_PASSWORD on the shutterfield Vercel
-- project). Suffering Jukebox and Listening Party only ever sign it in.
--
-- Same rule as je.ensure_sample_auth_user: an account that already exists is
-- returned untouched, so running this can never change how it signs in. Unlike
-- that function it does not invent a missing account either, because an account
-- with a password nobody knows is no use to a test.
--
-- What it does do is give the account a public name, Johnny D, so anything the
-- tests leave behind reads as ordinary public content rather than as a test
-- account. A name already chosen is kept, and upsert_app_user only ever rewrites
-- user_name on sign-in, so the name survives every later sign-in.

create or replace function jukebox.ensure_test_account(
  p_email text default 'testing@shutterfield.com',
  p_public_name text default 'Johnny D'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(p_email));
  v_id uuid;
begin
  select id into v_id from auth.users where email = v_email;
  if v_id is null then
    raise exception 'No account for %. It is made in Shutterfield; this never creates one or sets its sign-in.', v_email;
  end if;

  insert into jukebox.app_users (email, public_name, last_seen_at)
  values (v_email, nullif(btrim(p_public_name), ''), now())
  on conflict (email) do update
    set public_name = coalesce(nullif(btrim(jukebox.app_users.public_name), ''), excluded.public_name);

  return v_id;
end;
$$;

revoke all on function jukebox.ensure_test_account(text, text) from public, anon, authenticated;

select jukebox.ensure_test_account('testing@shutterfield.com', 'Johnny D');
