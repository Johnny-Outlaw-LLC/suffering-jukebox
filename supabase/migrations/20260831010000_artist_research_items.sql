-- Artist Deep Dive / Research Mode
-- Supplemental media (interviews, podcasts, articles, documentaries) that
-- sits beside the discography. Flagged is_supplemental so charts never mix
-- these with album tracks. Everything goes through /api/research with the
-- service role — same pattern as the Online Jukebox tables.

create table if not exists jukebox.research_items (
  id              uuid primary key default gen_random_uuid(),
  artist_id       uuid not null references jukebox.artists(id) on delete cascade,
  is_supplemental boolean not null default true,
  media_type      text not null,
  title           text not null,
  description     text,
  source_url      text,
  source_name     text,
  creator_name    text,
  creator_url     text,
  channel_id      text,
  external_id     text,
  thumbnail_url   text,
  embed_url       text,
  audio_url       text,
  storage_path    text,
  duration_ms     integer,
  view_count      bigint,
  published_at    timestamptz,
  added_at        timestamptz not null default now(),
  transcript      text,
  transcript_source text,
  added_by        text,
  added_by_name   text,
  added_via       text not null default 'manual',
  visibility      text not null default 'public',
  metadata        jsonb not null default '{}'::jsonb,
  constraint research_items_media_type_chk check (media_type in (
    'youtube_video', 'audio_podcast', 'article', 'interview',
    'documentary', 'other'
  )),
  constraint research_items_added_via_chk check (added_via in (
    'research', 'upload', 'manual', 'import'
  )),
  constraint research_items_visibility_chk check (visibility in ('public', 'private'))
);

create index if not exists research_items_artist_idx
  on jukebox.research_items (artist_id, published_at desc nulls last);

create index if not exists research_items_artist_views_idx
  on jukebox.research_items (artist_id, view_count desc nulls last);

create index if not exists research_items_media_type_idx
  on jukebox.research_items (artist_id, media_type);

create unique index if not exists research_items_artist_external_uidx
  on jukebox.research_items (artist_id, external_id)
  where external_id is not null;

create unique index if not exists research_items_artist_source_uidx
  on jukebox.research_items (artist_id, source_url)
  where source_url is not null and external_id is null;

alter table jukebox.research_items enable row level security;
revoke all on jukebox.research_items from anon, authenticated;
grant all on jukebox.research_items to service_role;

comment on table jukebox.research_items is
  'Supplemental Deep Dive content (podcasts, interviews, articles). Never mixed into album charts.';
comment on column jukebox.research_items.is_supplemental is
  'Always true for research rows; keeps these out of discography metrics.';
comment on column jukebox.research_items.added_at is
  'When the item landed in this jukebox library.';
comment on column jukebox.research_items.published_at is
  'Original publish / upload date from the source when known.';
