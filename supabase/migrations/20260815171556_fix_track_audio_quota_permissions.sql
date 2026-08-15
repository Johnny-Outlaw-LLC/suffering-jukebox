-- Quota recalculation runs with the service role and only needs to read the
-- caller's upload metadata. Row-level user policies remain unchanged.
grant select on table jukebox.track_audio to service_role;
