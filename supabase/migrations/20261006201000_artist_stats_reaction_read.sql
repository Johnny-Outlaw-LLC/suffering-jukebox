-- The authorized server statistics route reads reactions in all_artist_stats.
-- service_role bypasses RLS but still needs the table's SELECT privilege.
-- Browser-role privileges and ownership policies are unchanged.
grant select on jukebox.lyric_reactions to service_role;
