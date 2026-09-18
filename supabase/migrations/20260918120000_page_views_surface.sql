-- Which brand served a page view. Suffering Jukebox and Listening Party share
-- this table (one app, one schema), so without this column every LP visit was
-- counted as SJ on the datadayanalytics.com traffic dashboard.
--
-- Backfill: rows before this column existed carry no host. Any session with at
-- least one view referred from listeningparty.stream is an LP session, so every
-- view in it is LP. A single-page LP visit with no internal referrer cannot be
-- told apart and stays 'sj'.

alter table jukebox.page_views add column if not exists surface text;

update jukebox.page_views pv
set surface = 'lp'
where pv.surface is null
  and pv.session_id in (
    select session_id from jukebox.page_views
    where referrer ~* '^https?://(www\.)?listeningparty\.stream'
  );

update jukebox.page_views set surface = 'sj' where surface is null;

alter table jukebox.page_views
  alter column surface set default 'sj',
  alter column surface set not null;

alter table jukebox.page_views drop constraint if exists page_views_surface_check;
alter table jukebox.page_views
  add constraint page_views_surface_check check (surface in ('sj', 'lp'));
