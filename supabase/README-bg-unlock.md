# Background Play Forever

Applied remotely via Supabase MCP on 2026-08-09:

- `jukebox.bg_entitlements` — $5 unlock = 10 years + 5 GiB
- `jukebox.product_events` — Phase 2 learning funnel
- `jukebox.track_audio.file_bytes` — quota accounting
- Existing uploaders grandfathered

## Private audio delivery

Audio files are stored in the private Backblaze B2 bucket
`suffering-jukebox-audio`. `jukebox.track_audio` remains the authoritative
Supabase metadata and quota ledger. The app server verifies the signed-in
Supabase user before issuing a short-lived B2 upload or playback URL; neither
the B2 key nor a public bucket URL is exposed in the browser.

`scripts/migrate-sj-audio-to-b2.mjs` copies every existing object, verifies
the B2 byte count, and deliberately retains Supabase originals for rollback.
Run it again immediately before cutover so uploads made during a prior copy
are included. `scripts/configure-sj-b2-cors.mjs` restricts browser access to
the Suffering Jukebox origins while keeping the bucket private.
