-- The consent table is private to server-side code. Keep direct browser roles
-- revoked while documenting the sole permitted database role for RLS.
drop policy if exists "service role can access listening insights consents" on jukebox.listening_insights_consents;
create policy "service role can access listening insights consents"
  on jukebox.listening_insights_consents
  to service_role
  using (true)
  with check (true);
