# Suffering Jukebox

Silver Jews and Purple Mountains online jukebox — plays, ratings, playlists, and lyrics.

**Live:** https://www.sufferingjukebox.stream

## SEO

- Canonical URL uses `www` (apex redirects in Vercel).
- `src/app/robots.ts` and `src/app/sitemap.ts` serve crawler files.
- `/about` is a keyword-focused landing page for search discovery.
- Optional env `GOOGLE_SITE_VERIFICATION` injects Search Console meta on all HTML pages.

After deploy, add the property in [Google Search Console](https://search.google.com/search-console) and submit `https://www.sufferingjukebox.stream/sitemap.xml`.

## Stack

- Single-file HTML dashboard (`public/index.html`) served by Next.js route handlers
- API routes for page analytics and admin tools
- Supabase backend (`jukebox` schema)
- Hosted on Vercel

## Local development

Edit `public/index.html` (or sync from `../silver-jews-dashboard.html` in the parent project folder), then:

```bash
npm install
npm run dev
```

Open http://localhost:3000

## Deploy

Push to `main` on `Johnny-Outlaw-LLC/suffering-jukebox`. Vercel auto-deploys.

Required environment variables:

- `SUPABASE_SERVICE_ROLE_KEY` — server-side Supabase access for admin APIs and page tracking
- `YOUTUBE_API_KEY` — optional; required for admin song YouTube stat refresh
- `GOOGLE_SITE_VERIFICATION` — optional; Google Search Console HTML tag content value

## Repo layout

| Path | Purpose |
|------|---------|
| `public/index.html` | Main jukebox app |
| `public/about/index.html` | SEO landing page |
| `public/privacy/index.html` | Privacy policy |
| `src/app/api/*` | Serverless API routes |
| `src/proxy.ts` | Referrer cookie for analytics |
