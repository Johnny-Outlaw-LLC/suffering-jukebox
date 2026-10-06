# Record Keeper

Record Keeper is the third surface of the shared Suffering Jukebox application.
Its canonical origin is https://recordkeeper.stream. The www hostname redirects
to the apex. The Vercel project `record-keeper` follows this repository's `main`
branch with `SURFACE_ID=rk` and `NEXT_PUBLIC_SITE_URL=https://recordkeeper.stream`.

Brand settings live in `src/lib/surface.ts`. The shared player, APIs, catalog,
accounts, playlists, uploads, and live rooms remain in this repository. Record
Keeper's artwork is under `public/brand/rk`; its help, audience, and policy pages
are under each page's `rk` directory. Generate audience guides with
`python scripts/build-audience-guides.py`.

The production project has the shared service configuration and B2 upload keys.
Keep secrets in Bitwarden and Vercel; do not add environment exports to Git.
The Supabase redirect allowlist includes both Record Keeper hosts. The existing
Google provider uses the shared Supabase callback, so there is no separate
Google OAuth application to maintain.

Migration `20261006200000_record_keeper_surface.sql` adds `rk` attribution to
page views and plays and separates Record Keeper in listening analytics. It
preserves the current server-side identity and artist-stat attribution logic.
The production migration was applied and tested inside a rolled-back transaction.

Porkbun DNS: apex ALIAS and www CNAME point to the Vercel project-specific DNS
target. Porkbun mail forwarding MX/SPF records are retained.

Native apps remain the existing Suffering Jukebox and Listening Party apps.
This launch publishes the Record Keeper website and installable web manifest;
it does not create a separate App Store application.
