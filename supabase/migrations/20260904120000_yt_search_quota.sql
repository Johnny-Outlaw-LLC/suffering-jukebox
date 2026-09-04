-- Daily YouTube search budget for Rediscover / auto-discover.
create table if not exists jukebox.yt_search_quota (
  user_email text not null,
  day date not null,
  searches int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_email, day)
);

alter table jukebox.yt_search_quota enable row level security;

revoke all on table jukebox.yt_search_quota from anon, authenticated;
grant all on table jukebox.yt_search_quota to service_role;

comment on table jukebox.yt_search_quota is
  'Per-user daily YouTube search.list usage for Rediscover. Service-role only.';
