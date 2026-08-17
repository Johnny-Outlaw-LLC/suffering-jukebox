-- Alternative YouTube uploads can play from the Versions menu without
-- changing the bar-chart number. Charts keep reading the most-viewed
-- version that still counts, so an auto-resolve swap does not collapse
-- the bar, and a cover does not inflate it.

alter table jukebox.track_videos
  add column if not exists counts_for_charts boolean not null default true;

comment on column jukebox.track_videos.counts_for_charts is
  'When false, this upload is an alternative version: it can play, but its YouTube views/likes are excluded from bar charts.';

-- Bright Flight / Friday Night Fever: the Silver Jews Topic upload is the
-- official audio. The George Strait Topic upload is a cover and was filling
-- the chart because it is the most-viewed row.
update jukebox.track_videos
set is_primary = false,
    label = 'George Strait',
    counts_for_charts = false,
    updated_at = now()
where track_id = 'bc0ef631-5aff-426a-877c-b3403db3364f'
  and video_id = 'J_xumPRwjxA';

update jukebox.track_videos
set is_primary = true,
    label = 'Original Audio',
    counts_for_charts = true,
    updated_at = now()
where track_id = 'bc0ef631-5aff-426a-877c-b3403db3364f'
  and video_id = 'qbxl7m9RvxU';
