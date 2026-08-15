# Background Play Forever

Applied remotely via Supabase MCP on 2026-08-09:

- `jukebox.bg_entitlements` — $5 unlock = 10 years + 5 GiB
- `jukebox.product_events` — Phase 2 learning funnel
- `jukebox.track_audio.file_bytes` — quota accounting
- Existing uploaders grandfathered

## Private audio delivery

The `jukebox-audio` bucket is private. `jukebox.track_audio` metadata and
Storage objects are readable only by their uploader under RLS. The browser
uses the signed-in Supabase session to create time-limited signed playback
URLs; there is no anonymous same-origin audio proxy or cross-user fallback.
