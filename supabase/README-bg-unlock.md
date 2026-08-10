# Background Play Forever

Applied remotely via Supabase MCP on 2026-08-09:

- `jukebox.bg_entitlements` — $5 unlock = 10 years + 5 GiB
- `jukebox.product_events` — Phase 2 learning funnel
- `jukebox.track_audio.file_bytes` — quota accounting
- Existing uploaders grandfathered

## Audio CDN

Public files are served via `/api/sj-audio/*` (same-origin edge cache with
long `Cache-Control` / `CDN-Cache-Control`). Playback URLs no longer hit
`supabase.co` storage on every listen. If Cloudflare is later put in front
of the domain, those cache headers are honored automatically.
