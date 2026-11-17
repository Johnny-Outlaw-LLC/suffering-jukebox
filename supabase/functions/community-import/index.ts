import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// community-import — signed-in users add their own artists/albums to the Jukebox.
// Actions (all require a valid Supabase user JWT in Authorization header):
//   GET  ?action=identify&q=<artist>            — one-shot artist identification:
//        Wikipedia summary (title/extract/thumbnail), MusicBrainz studio discography
//        (title/date/rg id; wiki-parse fallback), auto-picked YouTube channel, and
//        existing-artist flags (existing_albums for community merges)
//   GET  ?action=match_album&artist=&album=&rg=&year=&channel_id= — find the BEST playlist
//        for one album: candidates from the channel + a playlist search, scored by
//        official track-title overlap, nickname/year, expected track count, junk
//        penalties, views, and channel affinity. Self-titled albums (Weezer Blue vs
//        Green, etc.) stay distinct.
//   GET  ?action=playlist_info&ids=PL1,PL2      — metadata for explicit playlist ids
//        (the manual-add fallback when identify can't find the artist)
//   GET  ?action=search&q=<artist>              — (legacy) find artist channels on YouTube
//   GET  ?action=albums&channel_id=UC...&q=name — (legacy) list channel playlists + search
//   GET  ?action=my_artists                     — the caller's community artists + albums
//   GET  ?action=finetune_data&artist_id=...    — artist (name,color,slug) + albums with art_options
//        (Wikipedia cover first when found, then YouTube track thumbnails)
//   POST { channel_id, artist_name, playlists: [{id,title,release_date?,wiki_page?}], manual? } — import
//        selected playlists; stored album name = cleaned title; optional release_date
//        override (the wizard passes the MusicBrainz date). Non-manual imports default
//        album art_url to the Wikipedia cover when one is found. New artists get a unique
//        URL slug (jukebox.artists.slug) for their /artist-name share page.
//        An entry with `id: null` has NO playlist on YouTube and is built SONG BY SONG
//        from the canonical tracklist (MusicBrainz, then iTunes): the artist's own
//        uploads are swept first (1 quota unit per 50 videos), then one album-wide
//        search, then one search per song still missing. Send those one album per
//        request — the gateway kills a request at 150s.
//   POST ?action=finetune { artist_id, artist_name?, color?, albums? } — wizard fine-tune
//   POST ?action=rename_artist { artist_id, name }
//   POST ?action=rename_album  { album_id, name }
//   POST ?action=delete_album  { album_id }
//   POST ?action=delete_artist { artist_id }
//   POST ?action=delete_track  { track_id }
//   POST ?action=add_track     { album_id, video } — add one YouTube video as a track
//   POST ?action=save_lyrics   { track_id, lyrics } — upsert lyrics + edit history
//   POST ?action=enrich { album_id } — release date (MusicBrainz → iTunes) + LRCLIB lyrics,
//        ONE album per call. Frontend loops the albums.
// Imported tracks get yt_snapshot_enabled=true + a youtube_video_id metric for the
// nightly youtube-daily-snapshot cron.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const YT_KEY = Deno.env.get('YOUTUBE_API_KEY');

// Channels that own auto-generated album playlists for MANY different artists
// (e.g. the global "YouTube" brand channel). A playlist owned by one of these
// says nothing about which artist it belongs to - never match or store them.
const GENERIC_CHANNEL_IDS = new Set([
  'UCBR8-60-B28hp2BmDPdntcQ', // "YouTube" - owns countless auto-generated OLAK5uy_ album playlists
  'UC-9-kyTW8ZkZNDHQJ6FgpwQ', // "Music" auto-generated topic channel
]);
const isIdentifyingChannel = (id?: string | null) => !!id && !GENERIC_CHANNEL_IDS.has(id);

const MAX_PLAYLISTS_PER_IMPORT = 50;
const MAX_TRACKS_PER_PLAYLIST = 60;
const MAX_TRACKS_PER_IMPORT = 300;
const MB_UA = 'SufferingJukebox/1.0 (support@outlawapps.online)';
const LOOKUP_TIMEOUT_MS = 8000;
const LYRICS_CONCURRENCY = 5;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function dbH(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'jukebox',
    'Content-Profile': 'jukebox',
    ...extra,
  };
}

async function dbGet(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { headers: dbH() });
  if (!r.ok) throw new Error(`DB GET ${path}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function dbInsert(table: string, rows: unknown, returning = false): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: dbH({ Prefer: returning ? 'return=representation' : 'return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`DB INSERT ${table}: ${(await r.text()).slice(0, 300)}`);
  return returning ? r.json() : null;
}

async function dbPatch(path: string, patch: Record<string, unknown>): Promise<void> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method: 'PATCH', headers: dbH(), body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`DB PATCH ${path}: ${(await r.text()).slice(0, 300)}`);
}

async function dbDelete(path: string): Promise<void> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { method: 'DELETE', headers: dbH() });
  if (!r.ok) throw new Error(`DB DELETE ${path}: ${(await r.text()).slice(0, 300)}`);
}

async function getUser(req: Request): Promise<{ email: string; name: string } | null> {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: auth },
  });
  if (!r.ok) return null;
  const u = await r.json();
  if (!u?.email) return null;
  return { email: u.email, name: u.user_metadata?.full_name || u.email.split('@')[0] };
}

async function isAdmin(email: string): Promise<boolean> {
  try {
    const [u] = await dbGet(`/app_users?email=eq.${encodeURIComponent(email)}&select=is_admin`);
    return !!u?.is_admin;
  } catch (_) { return false; }
}

// Official catalogue artists Johnny Outlaw can manage as if he added them.
// Kept is_community=false so they still show as Suffering Jukebox (official).
const OFFICIAL_OWNER_EMAIL = 'johnnyoutlawllc@gmail.com';
const OFFICIAL_MANAGE_SLUGS = new Set(['silver-jews', 'purple-mountains']);

function isOfficialOwner(email: string): boolean {
  return (email || '').toLowerCase() === OFFICIAL_OWNER_EMAIL;
}

// Ownership gate for manage actions:
// - community artist the caller added (admins pass for any community artist)
// - Silver Jews / Purple Mountains for Johnny Outlaw (official catalogue)
async function canManageArtist(artistId: string, email: string, admin: boolean): Promise<any | null> {
  const [a] = await dbGet(`/artists?id=eq.${artistId}&select=id,name,slug,is_community,added_by`);
  if (!a) return null;
  const emailLc = (email || '').toLowerCase();
  if (a.is_community) {
    if (admin || (a.added_by || '').toLowerCase() === emailLc) return a;
    // Later importers get a content_access row; that is enough to fine-tune
    // covers/names without taking over artists.added_by credit.
    try {
      const access = await dbGet(
        `/content_access?artist_id=eq.${artistId}&user_email=eq.${encodeURIComponent(emailLc)}&select=artist_id&limit=1`,
      );
      if (access.length) return a;
    } catch (_) { /* fall through */ }
    return null;
  }
  if (OFFICIAL_MANAGE_SLUGS.has(a.slug || '') && isOfficialOwner(email)) return a;
  return null;
}

// Public imports must not land on someone else's private artist — the albums
// become invisible in Explore and the importer cannot fine-tune. Match only
// public artists, or a private one the caller already owns.
function canMergeIntoArtist(a: any, email: string): boolean {
  if (!a) return false;
  const owned = (a.added_by || '').toLowerCase() === (email || '').toLowerCase();
  const vis = (a.visibility || 'public') === 'private' ? 'private' : 'public';
  if (vis === 'private' && !owned) return false;
  return true;
}

// Remove an album and every row that references its tracks
async function deleteAlbumCascade(albumId: string): Promise<number> {
  const trs = await dbGet(`/tracks?album_id=eq.${albumId}&select=id`);
  const ids = trs.map((t: any) => t.id);
  // track_videos must be cleared by hand — it is not ON DELETE CASCADE, and
  // leaving rows behind blocked album deletes after the versions table shipped.
  const trackTables = ['metrics', 'lyrics', 'lyrics_edits', 'playlist_tracks', 'yt_daily_snapshots',
    'track_play_counts', 'play_events', 'rating_events', 'feedback', 'links', 'track_videos'];
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40).join(',');
    for (const tbl of trackTables) {
      try { await dbDelete(`/${tbl}?track_id=in.(${chunk})`); } catch (_) { /* table may have no such rows */ }
    }
  }
  for (const tbl of ['metrics', 'feedback', 'links']) {
    try { await dbDelete(`/${tbl}?album_id=eq.${albumId}`); } catch (_) {}
  }
  await dbDelete(`/tracks?album_id=eq.${albumId}`);
  await dbDelete(`/albums?id=eq.${albumId}`);
  return ids.length;
}

// Same-artist album already on file: by playlist id, or by normalized title so
// a second YouTube playlist for "Cardinal" cannot mint a second Cardinal row.
async function findExistingAlbum(artistId: string, wantName: string, playlistId?: string | null): Promise<any | null> {
  if (playlistId) {
    const byPl = await dbGet(`/albums?yt_playlist_id=eq.${playlistId}&select=id,name,yt_playlist_id`);
    if (byPl.length) return byPl[0];
  }
  const want = norm(wantName);
  if (!want) return null;
  const albs = await dbGet(`/albums?artist_id=eq.${artistId}&select=id,name,yt_playlist_id`);
  return albs.find((a: any) => norm(a.name) === want) || null;
}

function tfetch(url: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function yt(path: string, params: Record<string, string>, tries = 3): Promise<any> {
  for (let i = 0; ; i++) {
    const qs = new URLSearchParams({ ...params, key: YT_KEY! });
    const r = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${qs}`);
    const d = await r.json();
    if (!d.error) return d;
    const msg = `YouTube ${path}: ${d.error.message} (${d.error.code})`;
    if (i >= tries - 1 || ![429, 500, 503].includes(d.error.code)) throw new Error(msg);
    await sleep(2500 * (i + 1));
  }
}

function iso8601ToMs(dur: string | undefined): number | null {
  if (!dur) return null;
  const m = dur.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  return ((+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0))) * 1000;
}

function cleanTrackName(title: string, artistName: string): string {
  let t = title;
  const pfx = new RegExp('^' + artistName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[-–—:/]\\s*', 'i');
  t = t.replace(pfx, '');
  // Fan uploads number the songs: "Roger Waters - 01 - 4.30 AM (...)". The
  // separator must be followed by a space so "4.30 AM" itself is left alone.
  t = t.replace(/^\d{1,2}\s*[-–—.)]\s+/, '');
  t = t.replace(/\s*\((official\s+)?(music\s+)?(video|audio|visualizer|lyric\s*video)\)\s*$/i, '');
  t = t.replace(/\s*\[(official\s+)?(music\s+)?(video|audio|visualizer|lyric\s*video)\]\s*$/i, '');
  return t.trim() || title;
}

// "&" folds to "and" BEFORE the strip. Without it "Bubble & Scrape" normalizes
// to "bubblescrape" and can never match MusicBrainz's "Bubble and Scrape", which
// is exactly how that album got dropped from the first Sebadoh import.
const norm = (s: string) => (s || '').toLowerCase().replace(/[&\uff06]/g, ' and ').replace(/[^a-z0-9]+/g, '');

// Artist discovery must be an identity match, never just the first fuzzy
// search hit.  "The Blink 182 Show" was a high-scoring MusicBrainz result for
// Blink-182, but is a different act with a completely unrelated catalogue.
// Allow harmless display variations while refusing a look-alike artist.
function artistIdentityKey(name: string): string {
  return (name || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*\((band|musician|singer|group)\)\s*$/i, '')
    .replace(/^\s*the\s+/i, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function isExactArtistIdentity(query: string, candidate: string): boolean {
  const want = artistIdentityKey(query), found = artistIdentityKey(candidate);
  return !!want && want === found;
}

// Strip playlist-title junk ("Artist - Album (Full Album HQ)") down to the album name.
// Fuzzy artist prefix: the longest leading chunk before a separator whose normalized
// form contains / is contained by the artist name is stripped.
function cleanAlbumName(title: string, artistName: string): string {
  let t = title;
  const pfx = new RegExp('^' + artistName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[-–—:/]\\s*', 'i');
  if (pfx.test(t)) {
    t = t.replace(pfx, '');
  } else {
    const na = norm(artistName);
    const seps = [...t.matchAll(/\s*[-–—:/]\s*/g)];
    for (let i = seps.length - 1; i >= 0; i--) {
      const np = norm(t.slice(0, seps[i].index));
      if (np && np.length >= 3 && (na.includes(np) || np.includes(na))) {
        t = t.slice((seps[i].index as number) + seps[i][0].length);
        break;
      }
    }
  }
  t = t.replace(/\s*[\(\[][^\)\]]*(full\s+album|official|complete|hq|hd|remaster)[^\)\]]*[\)\]]\s*/gi, ' ');
  t = t.replace(/\s*(full\s+album|whole\s+album|album\s+completo)\s*$/i, '');
  t = t.replace(/\s*[\(\[]\s*(19|20)\d{2}\s*[\)\]]\s*/g, ' ');
  t = t.replace(/\s+/g, ' ').replace(/[\s\-–—/|]+$/g, '').trim();
  return t || title;
}

// URL slug for artist share pages (/pavement). Reserved names avoid app routes.
const RESERVED_SLUGS = ['community', 'privacy', 'about', 's', 'api', 'admin', 'index', 'sitemap', 'robots'];
function slugify(name: string): string {
  return (name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
async function uniqueSlug(name: string): Promise<string | null> {
  let base = slugify(name);
  if (!base) return null;
  if (RESERVED_SLUGS.includes(base)) base += '-music';
  for (let i = 1; i <= 20; i++) {
    const cand = i === 1 ? base : `${base}-${i}`;
    try {
      const rows = await dbGet(`/artists?slug=eq.${encodeURIComponent(cand)}&select=id`);
      if (!rows.length) return cand;
    } catch (_) { return null; }
  }
  return null;
}

function similar(a: string, b: string): boolean {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// Album membership is stricter than general searching.  A substring test lets
// "Anthem" match "Anthem Part Two", which is enough to make a live-record
// playlist look like a different studio album.  Normalize harmless packaging
// variants, but otherwise require the actual song title to agree.
function trackIdentity(title: string): string {
  let value = (title || '');
  // Packaging suffixes YouTube (especially Topic channels) appends — "Love Me
  // Do (Remastered 2009)" must still match the official "Love Me Do". The old
  // pattern only stripped a bare "Remastered" / "Remastered Version", so any
  // year or "2021 Mix" left the song unmatched and whole albums were skipped.
  value = value.replace(
    /\s*[\[(][^)\]]*\b(remaster(?:ed)?|deluxe|expanded|super\s*deluxe|anniversary|mono|stereo|remix|mix|edition|version|edit)\b[^)\]]*[)\]]\s*$/ig,
    '',
  );
  value = value.replace(
    /\s*[\[(](album|single|radio|explicit|clean|original)[\])]?\s*$/i,
    '',
  );
  const words: Record<string, string> = {
    one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  };
  value = value.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi, w => words[w.toLowerCase()]);
  // "Pt. 10" on YouTube is MusicBrainz's "Part 10" (Pros and Cons of Hitch
  // Hiking was dropped over exactly this).
  value = value.replace(/\bpt\.?\s*(?=\d)/gi, 'part ');
  return norm(value);
}
function isSameTrack(a: string, b: string): boolean {
  const na = trackIdentity(a), nb = trackIdentity(b);
  return !!na && na === nb;
}

// Self-titled albums (Weezer's Blue/Green/White, Metallica's Black Album, …)
// share a core title and only differ by a parenthetical nickname and/or year.
function coreTitle(title: string): string {
  return (title || '').replace(/\s*\([^)]+\)\s*$/, '').trim() || title;
}
function nickTitle(title: string): string {
  const m = (title || '').match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim() : '';
}
function yearOf(d: string | undefined | null): string {
  const m = String(d || '').match(/(19|20)\d{2}/);
  return m ? m[0] : '';
}
function mbAlbumLabel(g: { title?: string; disambiguation?: string }): string {
  const title = (g.title || '').trim();
  const d = (g.disambiguation || '').trim();
  if (!d) return title;
  if (/^(album|studio album|single|ep|compilation)$/i.test(d)) return title;
  if (norm(title).includes(norm(d))) return title;
  return `${title} (${d})`;
}
function albumIdentityScore(
  want: { title: string; date?: string },
  got: { title: string; date?: string },
): number {
  const wCore = coreTitle(want.title), gCore = coreTitle(got.title);
  const wNick = nickTitle(want.title), gNick = nickTitle(got.title);
  const wY = yearOf(want.date), gY = yearOf(got.date);
  if (!wCore || !gCore) return -1;
  if (norm(wCore) !== norm(gCore) && !similar(wCore, gCore)) return -1;
  let s = 0;
  if (norm(want.title) === norm(got.title)) s += 60;
  else if (norm(wCore) === norm(gCore)) s += 15;
  if (wNick && gNick && (norm(wNick) === norm(gNick) || norm(wNick).includes(norm(gNick)) || norm(gNick).includes(norm(wNick)))) s += 50;
  if (wY && gY && wY === gY) s += 40;
  return s;
}
function stripWikiAlbumJunk(t: string, artist: string): string {
  t = (t || '').replace(/<[^>]+>/g, '').replace(/''/g, '').trim();
  t = t.replace(/\s*\(\s*album\s*\)$/i, '');
  if (artist) {
    const a = artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`\\s*\\(\\s*${a}\\s+album\\s*\\)$`, 'i'), '');
  }
  t = t.replace(/\s*\(\s*\d{4}\s+album\s*\)$/i, '');
  return t.trim();
}

function normDate(d: string | undefined): string | null {
  if (!d) return null;
  const m = d.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  if (y < 1900 || y > 2100) return null;
  return `${m[1]}-${m[2] || '01'}-${m[3] || '01'}`;
}

// ── MusicBrainz: studio discography + canonical track counts ───────────────
// MusicBrainz's shared server routinely answers a burst of calls with a 503
// "currently busy" — one import makes a couple dozen of these in quick
// succession (discography + per-album tracklist + per-album date lookups),
// so a single failed request used to silently fall through to a worse data
// source (a YouTube upload date, an untyped iTunes hit) instead of just
// trying again a beat later.
async function mbFetchJson(url: string, tries = 3): Promise<any | null> {
  for (let i = 0; ; i++) {
    let r: Response;
    try {
      r = await tfetch(url, { headers: { 'User-Agent': MB_UA } });
    } catch (_) {
      if (i >= tries - 1) return null;
      await sleep(1200 * (i + 1));
      continue;
    }
    if (r.ok) return r.json();
    if (i >= tries - 1 || ![429, 503, 500].includes(r.status)) return null;
    await sleep(1200 * (i + 1));
  }
}

async function mbJson(path: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({ ...params, fmt: 'json' });
  const d = await mbFetchJson(`https://musicbrainz.org/ws/2/${path}?${qs}`);
  if (d === null) throw new Error(`MusicBrainz request failed`);
  return d;
}

// Studio albums: MusicBrainz primary type Album with no secondary type.  Demos,
// compilations, live records, remixes, soundtracks, and promotional releases
// are separate secondary types and do not belong in a studio-album import.
type Discography = {
  name: string | null;
  albums: Array<{ title: string; date: string; rg: string | null }>;
  source: 'musicbrainz' | 'itunes' | 'none';
};

// MusicBrainz is the authority, but a temporary 429/503 must not strand the
// import wizard at step 1. Apple/iTunes supplies a conservative fallback list
// only in that outage case; each selected album still gets its canonical track
// list before a YouTube playlist may contribute a song.
async function itunesDiscography(artist: string): Promise<Discography> {
  try {
    const search = await tfetch(`https://itunes.apple.com/search?term=${encodeURIComponent(artist)}&entity=musicArtist&limit=10`);
    if (!search.ok) return { name: null, albums: [], source: 'none' };
    const artistHit = ((await search.json().catch(() => null))?.results || []).find((row: any) =>
      isExactArtistIdentity(artist, row.artistName || ''),
    );
    if (!artistHit?.artistId) return { name: null, albums: [], source: 'none' };

    const lookup = await tfetch(`https://itunes.apple.com/lookup?id=${encodeURIComponent(String(artistHit.artistId))}&entity=album&limit=200`);
    if (!lookup.ok) return { name: null, albums: [], source: 'none' };
    const ignored = /\b(live|greatest|best of|compilation|soundtrack|remix|demo|mixtape)\b|\s[-–—]\s*ep\b|\[live\]|\//i;
    const seen = new Set<string>();
    const albums: Array<{ title: string; date: string; rg: null }> = [];
    for (const row of ((await lookup.json().catch(() => null))?.results || [])) {
      const title = String(row.collectionName || '').trim();
      if (row.wrapperType !== 'collection' || row.collectionType !== 'Album' || !title) continue;
      if (!isExactArtistIdentity(artist, row.artistName || '') || ignored.test(title)) continue;
      // Avoid showing a Deluxe/Bonus duplicate when the standard record is
      // also present. The canonical track lookup handles editions later.
      const key = norm(title.replace(/\s*[\[(](deluxe|bonus[^\])]*|expanded)[\])]?\s*$/i, ''));
      if (!key || seen.has(key)) continue;
      seen.add(key);
      albums.push({ title, date: normDate(row.releaseDate) || '', rg: null });
    }
    albums.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
    return { name: artistHit.artistName || artist, albums, source: albums.length ? 'itunes' : 'none' };
  } catch (_) { return { name: null, albums: [], source: 'none' }; }
}

async function mbDiscography(artist: string): Promise<Discography> {
  try {
    // MusicBrainz's artist search does not always fold a typed space into a
    // hyphen. "Blink 182", for example, returns "The Blink 182 Show" but
    // not the real "blink‐182" entity. Retry a hyphenated spelling only after
    // the original query has no exact identity result.
    const terms = [...new Set([artist, artist.replace(/\s+/g, '-')].filter(Boolean))];
    let top: any = null;
    for (let i = 0; i < terms.length && !top; i++) {
      if (i) await sleep(1100);
      const ar = await mbJson('artist/', { query: `artist:"${terms[i]}"`, limit: '10' });
      top = (ar.artists || []).find((candidate: any) =>
        (candidate.score ?? 0) >= 90 && isExactArtistIdentity(artist, candidate.name || ''),
      ) || null;
    }
    if (!top) return await itunesDiscography(artist);
    await sleep(1100);
    const rgs = await mbJson('release-group', {
      artist: top.id, type: 'album', limit: '100',
    });
    const out: Array<{ title: string; date: string; rg: string }> = [];
    for (const g of (rgs['release-groups'] || [])) {
      const secs: string[] = g['secondary-types'] || [];
      if (g['primary-type'] === 'Album' && secs.length === 0) {
        out.push({ title: mbAlbumLabel(g), date: g['first-release-date'] || '', rg: g.id });
      }
    }
    out.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
    return { name: top.name, albums: out, source: 'musicbrainz' };
  } catch (_) { return await itunesDiscography(artist); }
}

// Most common total track count across the release-group's releases
async function mbTrackCount(rg: string): Promise<number | null> {
  try {
    const d = await mbJson('release', { 'release-group': rg, inc: 'media', limit: '25' });
    const counts: Record<number, number> = {};
    for (const r of (d.releases || [])) {
      const n = (r.media || []).reduce((s: number, m: any) => s + (m['track-count'] || 0), 0);
      if (n) counts[n] = (counts[n] || 0) + 1;
    }
    let best = 0, bc = 0;
    for (const k in counts) if (counts[k] > bc) { bc = counts[k]; best = +k; }
    return best || null;
  } catch (_) { return null; }
}

// ── Wikipedia: artist summary + discography-list fallback ───────────────────
async function wikiSummary(q: string): Promise<any | null> {
  try {
    const W = 'https://en.wikipedia.org/w/api.php';
    const s = await (await tfetch(`${W}?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=5&format=json&origin=*`)).json();
    const hits = s.query?.search || [];
    if (!hits.length) return null;
    const page = (hits.find((p: any) => /band|singer|musician|rapper|composer|discograph|album/i.test(p.snippet || '')) || hits[0]).title;
    const d = await (await tfetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page)}`)).json();
    if (!d?.title) return null;
    return {
      title: d.title,
      extract: (d.extract || '').slice(0, 600),
      thumbnail: d.thumbnail?.source || null,
      url: d.content_urls?.desktop?.page || null,
    };
  } catch (_) { return null; }
}

function upgradeWikiThumb(src: string): string {
  return /\/\d+px-/.test(src) ? src.replace(/\/\d+px-/, '/500px-') : src;
}

async function wikiPageSummaryThumb(page: string, albumOnly = false): Promise<string | null> {
  try {
    const d = await (await tfetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page.replace(/ /g, '_'))}`)).json();
    // A title track has its own page ("1984 single by Roger Waters") whose
    // picture is the single's sleeve, not the album cover.
    const desc = String(d?.description || '');
    if (albumOnly && /\b(single|song)\b/i.test(desc) && !/\b(album|ep|soundtrack)\b/i.test(desc)) return null;
    const src = d?.thumbnail?.source;
    if (!src || /\/static\/images\/icons\//i.test(src)) return null;
    return upgradeWikiThumb(src);
  } catch (_) { return null; }
}

// Album cover from the Wikipedia page linked in the artist discography, or a search fallback.
async function wikiAlbumThumbnail(
  wikiPage: string | null | undefined,
  artist: string,
  album: string,
): Promise<string | null> {
  if (wikiPage) {
    const hit = await wikiPageSummaryThumb(wikiPage);
    if (hit) return hit;
  }
  try {
    const W = 'https://en.wikipedia.org/w/api.php';
    const want = norm(coreTitle(album) || album);
    const searches = [`intitle:"${album}" ${artist}`, `${album} ${artist} album`];
    for (const q of searches) {
      const s = await (await tfetch(`${W}?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=6&format=json&origin=*`)).json();
      for (const hit of (s.query?.search || [])) {
        const title = hit.title || '';
        // "The Pros and Cons of Hitch Hiking (song)" outranked the album page
        // and gave the album the single's sleeve.
        if (/\((?:[^)]*\s)?(song|single)\)\s*$/i.test(title)) continue;
        const cleaned = stripWikiAlbumJunk(title, artist);
        if (!similar(norm(cleaned), want) && !similar(norm(coreTitle(cleaned)), want)) continue;
        const thumb = await wikiPageSummaryThumb(title, true);
        if (thumb) return thumb;
      }
    }
  } catch (_) {}
  return null;
}

async function wikiDiscographyList(artist: string): Promise<Array<{ title: string; date: string; wiki_page: string }>> {
  const W = 'https://en.wikipedia.org/w/api.php';
  const wget = async (params: Record<string, string>) =>
    (await tfetch(W + '?' + new URLSearchParams({ format: 'json', origin: '*', ...params }))).json();
  const albums: Array<{ title: string; date: string; wiki_page: string }> = [];
  const seen = new Set<string>();
  const add = (raw: string, date: string) => {
    const t = stripWikiAlbumJunk(raw, artist);
    if (!t || t.length >= 80) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    albums.push({ title: t, date: date || '', wiki_page: raw.trim() });
  };
  try {
    const s = await wget({ action: 'query', list: 'search', srsearch: `intitle:"${artist} discography"`, srlimit: '3' });
    const page = (s.query?.search || []).find((p: any) => /discography/i.test(p.title) && p.title.toLowerCase().includes(artist.toLowerCase()))?.title;
    let wikitext = '';
    if (page) {
      const d = await wget({ action: 'parse', page, prop: 'wikitext' });
      wikitext = d.parse?.wikitext?.['*'] || '';
      const m = wikitext.match(/==+\s*Studio albums\s*==+([\s\S]*?)(?:\n==|$)/i);
      if (m) wikitext = m[1];
    } else {
      const s2 = await wget({ action: 'query', list: 'search', srsearch: artist, srlimit: '1' });
      const t2 = s2.query?.search?.[0]?.title;
      if (t2) {
        const d2 = await wget({ action: 'parse', page: t2, prop: 'wikitext' });
        const full = d2.parse?.wikitext?.['*'] || '';
        const m2 = full.match(/==+\s*Discography\s*==+([\s\S]*?)(?:\n==|$)/i);
        wikitext = m2 ? m2[1] : '';
      }
    }
    // Prefer table rows (`! scope="row"| [[Weezer (Blue Album)|…]]`). The older
    // italic-link scrape also hit chart-footnote album names in the header and
    // then collapsed every self-titled record to one "Weezer" by stripping the
    // parenthetical nickname.
    const rows = wikitext.split(/\n\s*\|-\s*/);
    for (const row of rows) {
      if (/scope\s*=\s*"col"/i.test(row) && !/scope\s*=\s*"row"/i.test(row)) continue;
      const cell = row.match(/scope\s*=\s*"row"[^|\n]*\|\s*(.+)/i);
      if (!cell) continue;
      const link = cell[1].match(/\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/);
      if (!link) continue;
      let date = '';
      const rel = row.match(/Released:\s*([^\n<|{]+)/i);
      if (rel) {
        const y = rel[1].match(/(19|20)\d{2}/);
        if (y) date = y[0];
      }
      add(link[1], date);
    }
    if (!albums.length) {
      const re = /''\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]''|^\s*\*+\s*''([^'\[][^']*)''/gm;
      let mt;
      while ((mt = re.exec(wikitext)) !== null) {
        add(mt[1] || mt[2] || '', '');
      }
    }
  } catch (_) {}
  return albums;
}

// Release date for one already-confirmed studio album. Ranks candidates instead
// of taking MusicBrainz's first hit — a same-titled deluxe reissue, a live
// recording, or a "... Demos" compilation can outrank (or simply sort ahead
// of) the real studio release-group in a plain text search, and picking one of
// those "corrects" an already-right date to a wrong one.
async function mbReleaseDate(artist: string, album: string, year?: string): Promise<{ date: string; title: string } | null> {
  const esc = (s: string) => s.replace(/([+\-!(){}\[\]^"~*?:\\/])/g, '\\$1');
  const q = `releasegroup:"${esc(coreTitle(album) || album)}" AND artist:"${esc(artist)}"`;
  const d = await mbFetchJson(`https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(q)}&limit=8&fmt=json`);
  if (!d) return null;
  const want = { title: album, date: year || '' };
  const ranked = (d['release-groups'] || [])
    .filter((rg: any) => {
      if ((rg.score ?? 0) < 70) return false;
      const artistOk = (rg['artist-credit'] || []).some((ac: any) => similar(ac.name || ac.artist?.name || '', artist));
      return artistOk && albumIdentityScore(want, { title: mbAlbumLabel(rg), date: rg['first-release-date'] || '' }) >= 15;
    })
    .sort((a: any, b: any) => {
      const rank = (rg: any) => {
        const secs: string[] = rg['secondary-types'] || [];
        const studio = rg['primary-type'] === 'Album' && secs.every((s: string) => s === 'Soundtrack');
        return albumIdentityScore(want, { title: mbAlbumLabel(rg), date: rg['first-release-date'] || '' }) + (studio ? 5 : 0);
      };
      return rank(b) - rank(a);
    });
  for (const rg of ranked) {
    const date = normDate(rg['first-release-date']);
    if (date) return { date, title: mbAlbumLabel(rg) };
  }
  return null;
}

// Canonical studio tracklist for one album, in official track order. Used to
// keep playlist imports to real album tracks — a YouTube "full album" playlist
// often also holds bonus/live/promo videos that aren't part of the release.
// Prefers a primary-type "Album" release-group (mirrors mbDiscography's
// studio-album filter, so live/compilation release-groups with a similar name
// don't get picked), then the release-group's most common release (the
// standard edition, not a deluxe/expanded reissue with extra tracks).
async function mbTracklistForRg(rgId: string): Promise<Array<{ title: string; lengthMs: number | null }> | null> {
  const rd = await mbJson('release', { 'release-group': rgId, inc: 'recordings', limit: '25' });
  const releases: any[] = rd.releases || [];
  if (!releases.length) return null;

  const countOf = (rel: any) => (rel.media || []).reduce((s: number, m: any) => s + (m['track-count'] || 0), 0);
  const counts: Record<number, number> = {};
  for (const rel of releases) { const n = countOf(rel); if (n) counts[n] = (counts[n] || 0) + 1; }
  let target = 0, bc = 0;
  for (const k in counts) if (counts[+k] > bc) { bc = counts[+k]; target = +k; }
  if (!target) return null;

  const pick = releases.find(rel => countOf(rel) === target);
  if (!pick) return null;

  const out: Array<{ title: string; lengthMs: number | null }> = [];
  for (const m of (pick.media || [])) {
    for (const t of (m.tracks || [])) {
      const title = t.title || t.recording?.title || '';
      if (!title) continue;
      out.push({ title, lengthMs: t.length ?? t.recording?.length ?? null });
    }
  }
  return out.length ? out : null;
}

// Canonical studio tracklist for one album, in official track order. Used to
// keep playlist imports to real album tracks — a YouTube "full album" playlist
// often also holds bonus/live/promo videos that aren't part of the release.
// Prefers a known release-group id (from identify). Name search ranks by
// nickname + year so Weezer's Blue Album is not swapped for the Green one.
async function mbOfficialTracklist(artist: string, album: string, rgId?: string | null, year?: string): Promise<Array<{ title: string; lengthMs: number | null }> | null> {
  try {
    if (rgId) {
      await sleep(1100);
      try {
        const fromRg = await mbTracklistForRg(rgId);
        if (fromRg && fromRg.length) return fromRg;
      } catch (_) { /* fall through to name search / iTunes */ }
    }
    const esc = (s: string) => s.replace(/([+\-!(){}\[\]^"~*?:\\/])/g, '\\$1');
    const q = `releasegroup:"${esc(coreTitle(album) || album)}" AND artist:"${esc(artist)}"`;
    const d = await mbFetchJson(`https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(q)}&limit=8&fmt=json`);
    if (d) {
      const want = { title: album, date: year || '' };
      let bestId: string | null = null, bestS = -1;
      for (const rg of (d['release-groups'] || [])) {
        if ((rg.score ?? 0) < 70) continue;
        const artistOk = (rg['artist-credit'] || []).some((ac: any) => similar(ac.name || ac.artist?.name || '', artist));
        if (!artistOk) continue;
        const secs: string[] = rg['secondary-types'] || [];
        if (rg['primary-type'] !== 'Album' || !secs.every((s: string) => s === 'Soundtrack')) continue;
        const s = albumIdentityScore(want, { title: mbAlbumLabel(rg), date: rg['first-release-date'] || '' });
        if (s > bestS) { bestS = s; bestId = rg.id; }
      }
      if (bestId && bestS >= 15) {
        await sleep(1100); // MusicBrainz rate limit: ~1 req/sec
        try {
          const list = await mbTracklistForRg(bestId);
          if (list && list.length) return list;
        } catch (_) { /* iTunes below */ }
      }
    }
  } catch (_) { /* iTunes below */ }
  try { return await itunesTracklist(artist, album, year || undefined); } catch (_) { return null; }
}

async function itunesAlbumInfo(artist: string, album: string, year?: string): Promise<{ date: string | null; title: string; count: number | null; id: number | null } | null> {
  const r = await tfetch(`https://itunes.apple.com/search?term=${encodeURIComponent(artist + ' ' + album)}&entity=album&limit=8`);
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  const want = { title: album, date: year || '' };
  let best: any = null, bestS = -1;
  for (const it of (d?.results || [])) {
    if (!similar(it.artistName || '', artist)) continue;
    const s = albumIdentityScore(want, { title: it.collectionName || '', date: it.releaseDate || '' });
    if (s > bestS) { bestS = s; best = it; }
  }
  if (!best || bestS < 15) return null;
  return { date: normDate(best.releaseDate), title: best.collectionName, count: best.trackCount || null, id: best.collectionId || null };
}

// Song list for one album from iTunes, in track order. Only used when
// MusicBrainz has no tracklist — without a list of song names there is nothing
// to search YouTube for, so this is the difference between building an album
// song by song and skipping it.
async function itunesTracklist(artist: string, album: string, year?: string): Promise<Array<{ title: string; lengthMs: number | null }> | null> {
  try {
    const info = await itunesAlbumInfo(artist, album, year);
    if (!info?.id) return null;
    const r = await tfetch(`https://itunes.apple.com/lookup?id=${info.id}&entity=song&limit=200`);
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    const rows = (d?.results || []).filter((x: any) => x.wrapperType === 'track' && x.trackName);
    rows.sort((a: any, b: any) => (a.discNumber || 1) - (b.discNumber || 1) || (a.trackNumber || 0) - (b.trackNumber || 0));
    const out = rows.map((x: any) => ({ title: String(x.trackName), lengthMs: x.trackTimeMillis || null }));
    return out.length ? out : null;
  } catch (_) { return null; }
}

async function itunesReleaseDate(artist: string, album: string, year?: string): Promise<{ date: string; title: string } | null> {
  const hit = await itunesAlbumInfo(artist, album, year);
  return hit && hit.date ? { date: hit.date, title: hit.title } : null;
}

async function lrclibLookup(artist: string, track: string, durationSec: number | null):
  Promise<{ plain: string | null; synced: string | null } | null> {
  const H = { 'User-Agent': MB_UA };
  if (durationSec) {
    try {
      const r = await tfetch(`https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(track)}&duration=${Math.round(durationSec)}`, { headers: H });
      if (r.ok) {
        const d = await r.json().catch(() => null);
        if (d && (d.plainLyrics || d.syncedLyrics)) return { plain: d.plainLyrics || null, synced: d.syncedLyrics || null };
      }
    } catch (_) { /* timeout → try search */ }
  }
  try {
    const r2 = await tfetch(`https://lrclib.net/api/search?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(track)}`, { headers: H });
    if (!r2.ok) return null;
    const list = await r2.json().catch(() => []);
    if (!Array.isArray(list)) return null;
    const candidates = list.filter((d: any) =>
      similar(d.artistName || '', artist) && similar(d.trackName || '', track) &&
      (!durationSec || !d.duration || Math.abs(d.duration - durationSec) <= 10));
    const best = candidates.find((d: any) => d.syncedLyrics) || candidates.find((d: any) => d.plainLyrics);
    if (!best) return null;
    return { plain: best.plainLyrics || null, synced: best.syncedLyrics || null };
  } catch (_) { return null; }
}

// ── Playlist scoring ─────────────────────────────────────────────────────
async function playlistStats(plId: string): Promise<{ vids: string[]; titles: string[]; views: number }> {
  const vids: string[] = [];
  const titles: string[] = [];
  let pageToken = '';
  do {
    const d = await yt('playlistItems', { part: 'snippet,contentDetails', playlistId: plId, maxResults: '50', ...(pageToken ? { pageToken } : {}) });
    for (const it of (d.items || [])) {
      const vid = it.contentDetails?.videoId;
      const title = it.snippet?.title || '';
      if (vid && title !== 'Private video' && title !== 'Deleted video') {
        vids.push(vid);
        titles.push(title);
      }
    }
    pageToken = d.nextPageToken || '';
  } while (pageToken && vids.length < MAX_TRACKS_PER_PLAYLIST);
  let views = 0;
  for (let i = 0; i < vids.length; i += 50) {
    try {
      const d = await yt('videos', { part: 'statistics', id: vids.slice(i, i + 50).join(','), maxResults: '50' });
      for (const it of (d.items || [])) views += parseInt(it.statistics?.viewCount || '0', 10);
    } catch (_) {}
  }
  return { vids, titles, views };
}

function officialTrackHits(official: string[], videoTitles: string[], artist: string): number {
  const used = new Set<number>();
  let hits = 0;
  for (const ot of official) {
    for (let i = 0; i < videoTitles.length; i++) {
      if (used.has(i)) continue;
      if (!isSameTrack(cleanTrackName(videoTitles[i], artist), ot)) continue;
      used.add(i);
      hits++;
      break;
    }
  }
  return hits;
}

const JUNK_WORDS = ['live', 'cover', 'tribute', 'karaoke', '8d', '360', 'remix', 'ai art', 'a.i.', ' ai '];

// Reject a video as a match for an official studio track when its raw YouTube
// title contains one of these, even if the base song title lines up (e.g. a
// "Dashboard (Pepsi Smash on Yahoo! Music 2007)" video is not the album cut).
const NONALBUM_TITLE_MARKERS = [
  'live at', 'live on', 'live from', 'live in', 'live @', '(live)', '[live]',
  'session', 'unplugged', 'acoustic', 'rehearsal', 'soundcheck', 'demo',
  'instrumental', 'a cappella', 'commentary', 'interview', 'q&a', 'webisode',
  'trailer', 'unreleased', 'bootleg', 'radio edit', 'promo',
  'pepsi', 'yahoo music', 'vevo presents', 'kexp', 'tiny desk', 'npr music',
  'daytrotter', 'audiotree', 'colbert', 'fallon', 'kimmel', 'conan',
  'letterman', 'snl', 'jools holland', 'kcrw', 'wfuv', 'making of',
  'behind the scenes',
];

// Max YouTube searches per import used to fill official tracks that are missing
// from the playlist. Each search costs 100 quota units, so keep this small.
const MAX_TRACK_SEARCHES = 12;
// How far a video's length may sit from the official track length and still be
// accepted as the same recording.
const TRACK_DUR_TOL_MS = 20000;

// Find a video for one official track by searching YouTube and keeping the
// candidate whose length is closest to the official length (within tolerance),
// skipping live/session/etc. uploads. Returns the full video resource so the
// caller can read its stats/duration exactly like a playlist video.
async function ytFindTrackByLength(
  artist: string, title: string, lengthMs: number, exclude: Set<string>,
): Promise<{ videoId: string; detail: any } | null> {
  let s: any;
  try {
    s = await yt('search', { part: 'snippet', q: `${artist} ${title}`, type: 'video', maxResults: '6' });
  } catch (_) { return null; }
  const ids = ([...new Set((s.items || []).map((it: any) => it.id?.videoId).filter(Boolean))] as string[])
    .filter((id: string) => !exclude.has(id));
  if (!ids.length) return null;
  let vd: any;
  try {
    vd = await yt('videos', { part: 'snippet,statistics,contentDetails', id: ids.slice(0, 6).join(','), maxResults: '6' });
  } catch (_) { return null; }
  let best: any = null, bestScore = Infinity;
  for (const it of (vd.items || [])) {
    const raw = (it.snippet?.title || '').toLowerCase();
    if (NONALBUM_TITLE_MARKERS.some(w => raw.includes(w))) continue;
    const dur = iso8601ToMs(it.contentDetails?.duration);
    if (!dur) continue;
    const diff = Math.abs(dur - lengthMs);
    if (diff > TRACK_DUR_TOL_MS) continue;
    // Prefer a title that also reads like the track; the length is the real
    // gate, but a title bonus keeps a same-length live cut from winning when
    // both slip through the marker filter.
    const titleMatch = isSameTrack(cleanTrackName(it.snippet?.title || '', artist), title);
    if (!titleMatch) continue;
    // YouTube returns the search list in relevance order.  Within an exact
    // track/title and duration match, favour a meaningful, well-watched upload
    // rather than a tiny re-upload.
    const views = parseInt(it.statistics?.viewCount || '0', 10);
    const score = diff - Math.min(12000, Math.log10(views + 1) * 1500);
    if (score < bestScore) { bestScore = score; best = it; }
  }
  return best ? { videoId: best.id, detail: best } : null;
}

// ── Building an album song by song ────────────────────────────────────────
// Some albums have no playlist on YouTube at all: the songs are up there one
// video at a time and nobody ever gathered them. Rather than skip the album,
// take its canonical tracklist and go looking for each song.
//
// Order matters because of quota. A page of a channel's uploads costs 1 unit
// and hands back 50 videos; a search costs 100 and hands back one album's
// worth. So sweep the artist's own channel first, then spend a single search
// on the whole album, and only then buy a search per song still missing.
const MAX_CHANNEL_INDEX_VIDEOS = 2000;
const MAX_SONG_SEARCHES_PER_ALBUM = 12;
// An album built from a handful of its songs is worse than no album, because
// the listener has no way to tell it is incomplete.
const MIN_SONG_BUILD_TRACKS = 3;
const MIN_SONG_BUILD_RATIO = 0.5;

type YtVideo = { videoId: string; detail: any };

function ytVideosFromList(items: any[]): YtVideo[] {
  return (items || []).filter((it: any) => it?.id).map((it: any) => ({ videoId: it.id, detail: it }));
}

async function ytVideoDetails(ids: string[]): Promise<YtVideo[]> {
  const out: YtVideo[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const d = await yt('videos', { part: 'snippet,statistics,contentDetails', id: ids.slice(i, i + 50).join(','), maxResults: '50' });
      out.push(...ytVideosFromList(d.items || []));
    } catch (_) { /* one bad page shouldn't lose the rest */ }
  }
  return out;
}

// Every video on the artist's channel, cheaply. A "- Topic" channel carries the
// whole studio catalogue one song per video, which is exactly what an album
// with no playlist needs.
async function ytChannelVideoIndex(channelId: string): Promise<YtVideo[]> {
  if (!channelId) return [];
  let uploads = '';
  try {
    const cd = await yt('channels', { part: 'contentDetails', id: channelId, maxResults: '1' });
    uploads = cd.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || '';
  } catch (_) { return []; }
  if (!uploads) return [];
  const ids: string[] = [];
  let pageToken = '';
  do {
    let d: any;
    try {
      d = await yt('playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: '50', ...(pageToken ? { pageToken } : {}) });
    } catch (_) { break; }
    for (const it of (d.items || [])) {
      const v = it.contentDetails?.videoId;
      if (v) ids.push(v);
    }
    pageToken = d.nextPageToken || '';
  } while (pageToken && ids.length < MAX_CHANNEL_INDEX_VIDEOS);
  return await ytVideoDetails(ids.slice(0, MAX_CHANNEL_INDEX_VIDEOS));
}

// A "- Topic" channel only carries what the label has licensed to YouTube
// Music, so whole albums can be missing from it (Roger Waters' Topic channel
// has no Pros and Cons of Hitch Hiking) while the artist's own official
// channel has every song. Find that channel: exact artist name, not a Topic
// channel, most subscribers. One channel search, 100 units, once per import.
async function ytOfficialChannelId(artist: string, excludeId: string): Promise<string | null> {
  try {
    const d = await yt('search', { part: 'snippet', q: artist, type: 'channel', maxResults: '8' });
    const ids = ((d.items || []).map((i: any) => i.snippet?.channelId).filter(Boolean) as string[])
      .filter(id => id !== excludeId);
    if (!ids.length) return null;
    const cd = await yt('channels', { part: 'statistics,snippet', id: ids.join(','), maxResults: '50' });
    const na = norm(artist);
    const best = (cd.items || [])
      .filter((c: any) => !/-\s*topic$/i.test(c.snippet?.title || '') && norm(c.snippet?.title || '') === na)
      .sort((a: any, b: any) =>
        parseInt(b.statistics?.subscriberCount || '0', 10) - parseInt(a.statistics?.subscriberCount || '0', 10))[0];
    return best?.id || null;
  } catch (_) { return null; }
}

// Every video the song-by-song builder may match against: the import's channel,
// plus the artist's official channel when the import's channel is a Topic one.
async function ytArtistVideoIndex(channelId: string, artist: string): Promise<YtVideo[]> {
  const out = await ytChannelVideoIndex(channelId);
  let isTopic = false;
  try {
    const cd = await yt('channels', { part: 'snippet', id: channelId, maxResults: '1' });
    isTopic = /-\s*topic$/i.test(cd.items?.[0]?.snippet?.title || '');
  } catch (_) {}
  if (!isTopic) return out;
  const official = await ytOfficialChannelId(artist, channelId);
  if (!official) return out;
  const seen = new Set(out.map(v => v.videoId));
  for (const v of await ytChannelVideoIndex(official)) if (!seen.has(v.videoId)) out.push(v);
  return out;
}

// One search for the whole album (100 units) — for a Topic-channel release this
// usually returns most of the tracklist in a single call.
async function ytAlbumSearchPool(artist: string, album: string): Promise<YtVideo[]> {
  let s: any;
  try {
    s = await yt('search', { part: 'snippet', q: `${artist} ${album}`, type: 'video', maxResults: '50' });
  } catch (_) { return []; }
  const ids = [...new Set((s.items || []).map((it: any) => it.id?.videoId).filter(Boolean))] as string[];
  if (!ids.length) return [];
  return await ytVideoDetails(ids);
}

// Best video in a pool for one official track. The song's length is the real
// gate; an exact title and the artist's own channel break ties.
function pickVideoForTrack(
  pool: YtVideo[], used: Set<string>, artist: string, ct: { title: string; lengthMs: number | null },
): YtVideo | null {
  const want = ct.title.toLowerCase();
  let best: YtVideo | null = null, bestScore = Infinity;
  for (const v of pool) {
    if (used.has(v.videoId)) continue;
    const raw = v.detail?.snippet?.title || '';
    const low = raw.toLowerCase();
    // A live take is not the album cut — unless the song itself is called that.
    if (NONALBUM_TITLE_MARKERS.some(w => low.includes(w) && !want.includes(w))) continue;
    const clean = cleanTrackName(raw, artist);
    if (!isSameTrack(clean, ct.title)) continue;
    const dur = iso8601ToMs(v.detail?.contentDetails?.duration);
    let score = 0;
    if (ct.lengthMs) {
      if (!dur) continue;
      const diff = Math.abs(dur - ct.lengthMs);
      if (diff > TRACK_DUR_TOL_MS) continue;
      score += diff;
    }
    if (norm(clean) !== norm(ct.title)) score += 5000;
    const ch = v.detail?.snippet?.channelTitle || '';
    if (/-\s*topic$/i.test(ch) || norm(ch).includes(norm(artist))) score -= 3000;
    if (score < bestScore) { bestScore = score; best = v; }
  }
  return best;
}

// Wikipedia often puts the band's name in front of an album title ("Sebadoh
// III") where MusicBrainz files it under the bare one ("III"). Worth one retry
// before giving up on ever finding a song list.
function withoutArtistPrefix(album: string, artist: string): string {
  const a = (album || '').trim();
  if (!artist || a.length <= artist.length) return '';
  if (a.slice(0, artist.length).toLowerCase() !== artist.toLowerCase()) return '';
  const rest = a.slice(artist.length).replace(/^[\s:\u2014\u2013-]+/, '').trim();
  return (rest && norm(rest) !== norm(a)) ? rest : '';
}

type SongBuild = {
  tracks: Array<{ videoId: string; position: number; title: string }>;
  detail: Record<string, any>;
  canonical: number; missing: number; searches: number;
  fromChannel: number; fromSearch: number; reason: string;
};

async function buildAlbumFromSongs(
  artist: string,
  album: { title: string; rg?: string; release_date?: string },
  channelIndex: YtVideo[],
  room: number,
): Promise<SongBuild> {
  const nothing = (reason: string, canonical = 0, searches = 0): SongBuild =>
    ({ tracks: [], detail: {}, canonical, missing: 0, searches, fromChannel: 0, fromSearch: 0, reason });

  const year = yearOf(album.release_date);
  let canonical = await mbOfficialTracklist(artist, album.title, album.rg || null, year);
  if (!canonical || !canonical.length) canonical = await itunesTracklist(artist, album.title, year);
  const bare = withoutArtistPrefix(album.title, artist);
  if ((!canonical || !canonical.length) && bare) {
    canonical = await mbOfficialTracklist(artist, bare, null, year);
    if (!canonical || !canonical.length) canonical = await itunesTracklist(artist, bare, year);
  }
  if (!canonical || !canonical.length) return nothing('no song list found for this album');
  canonical = canonical.slice(0, MAX_TRACKS_PER_PLAYLIST);

  const detail: Record<string, any> = {};
  const used = new Set<string>();
  const slots: Array<{ videoId: string; position: number; title: string } | null> = canonical.map(() => null);
  let fromChannel = 0, fromSearch = 0, searches = 0;
  let budget = MAX_SONG_SEARCHES_PER_ALBUM;

  const take = (ci: number, v: YtVideo, ct: { title: string }) => {
    detail[v.videoId] = v.detail;
    used.add(v.videoId);
    slots[ci] = { videoId: v.videoId, position: ci, title: ct.title };
  };

  // Pass 1 — the artist's own uploads, already paid for.
  canonical.forEach((ct, ci) => {
    const hit = pickVideoForTrack(channelIndex, used, artist, ct);
    if (hit) { take(ci, hit, ct); fromChannel++; }
  });

  // Pass 2 — one search for the album covers the rest in bulk.
  if (slots.some(x => !x) && budget > 0) {
    budget--; searches++;
    const pool = await ytAlbumSearchPool(artist, album.title);
    canonical.forEach((ct, ci) => {
      if (slots[ci]) return;
      const hit = pickVideoForTrack(pool, used, artist, ct);
      if (hit) { take(ci, hit, ct); fromSearch++; }
    });
  }

  // Pass 3 — one search per song still missing, while the budget lasts. Skipped
  // when the cheap passes came back nearly empty: an album that far off is not
  // going to be rescued one search at a time, and searches are where the daily
  // quota goes (100 units each against 10,000 for the day).
  if (slots.filter(Boolean).length >= Math.ceil(canonical.length * MIN_SONG_BUILD_RATIO)) {
    for (let ci = 0; ci < canonical.length; ci++) {
      const ct = canonical[ci];
      if (slots[ci] || !ct.lengthMs || budget <= 0) continue;
      budget--; searches++;
      const found = await ytFindTrackByLength(artist, ct.title, ct.lengthMs as number, used);
      if (found) { take(ci, { videoId: found.videoId, detail: found.detail }, ct); fromSearch++; }
    }
  }

  let tracks = slots.filter(Boolean) as Array<{ videoId: string; position: number; title: string }>;
  const floor = Math.max(1, Math.min(canonical.length, MIN_SONG_BUILD_TRACKS));
  if (tracks.length < floor || tracks.length < Math.ceil(canonical.length * MIN_SONG_BUILD_RATIO)) {
    return nothing(`only ${tracks.length} of ${canonical.length} songs could be found on YouTube`, canonical.length, searches);
  }
  if (tracks.length > room) tracks = tracks.slice(0, room);
  tracks = tracks.map((t, i) => ({ ...t, position: i }));
  return {
    tracks, detail, canonical: canonical.length,
    missing: canonical.length - tracks.length, searches, fromChannel, fromSearch, reason: '',
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const user = await getUser(req);
  if (!user) return json({ error: 'Sign in required.' }, 401);

  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  try {
    // ── my artists: caller's community artists + albums (admins see all) ─────
    // Johnny Outlaw also gets Silver Jews / Purple Mountains (official catalogue).
    // content_access covers later importers who added albums to someone else's
    // artist (they can fine-tune; artists.added_by stays with the original).
    if (req.method === 'GET' && action === 'my_artists') {
      const admin = await isAdmin(user.email);
      const emailLc = user.email.toLowerCase();
      let artists = admin
        ? await dbGet(`/artists?is_community=eq.true&select=id,name,slug,added_by,added_by_name,created_at&order=created_at.desc`)
        : await dbGet(`/artists?is_community=eq.true&added_by=eq.${encodeURIComponent(user.email)}&select=id,name,slug,added_by,added_by_name,created_at&order=created_at.desc`);
      if (!admin) {
        try {
          const access = await dbGet(
            `/content_access?user_email=eq.${encodeURIComponent(emailLc)}&select=artist_id`,
          );
          const extraIds = access.map((r: any) => r.artist_id).filter(Boolean)
            .filter((id: string) => !artists.some((a: any) => a.id === id));
          for (let i = 0; i < extraIds.length; i += 50) {
            const chunk = extraIds.slice(i, i + 50);
            const more = await dbGet(
              `/artists?id=in.(${chunk.join(',')})&is_community=eq.true&or=(visibility.eq.public,added_by.eq.${encodeURIComponent(user.email)})&select=id,name,slug,added_by,added_by_name,created_at`,
            );
            artists = artists.concat(more);
          }
        } catch (_) { /* content_access is additive */ }
      }
      if (isOfficialOwner(user.email)) {
        const official = await dbGet(`/artists?slug=in.(${[...OFFICIAL_MANAGE_SLUGS].join(',')})&select=id,name,slug,added_by,added_by_name,created_at`);
        for (const a of official) {
          if (!artists.some((x: any) => x.id === a.id)) artists.unshift(a);
        }
      }
      const out: any[] = [];
      for (const a of artists) {
        const albs = await dbGet(`/albums?artist_id=eq.${a.id}&select=id,name,release_date,art_url&order=release_date.asc`);
        let trackN = 0;
        const albIds = albs.map((x: any) => x.id);
        for (let i = 0; i < albIds.length; i += 50) {
          const rows = await dbGet(`/tracks?album_id=in.(${albIds.slice(i, i + 50).join(',')})&select=id`);
          trackN += rows.length;
        }
        const mine = (a.added_by || '').toLowerCase() === emailLc
          || (OFFICIAL_MANAGE_SLUGS.has(a.slug || '') && isOfficialOwner(user.email));
        out.push({ id: a.id, name: a.name, added_by_name: a.added_by_name, mine, albums: albs, track_count: trackN });
      }
      return json({ artists: out, is_admin: admin });
    }

    // ── mark discography complete only after the client finishes every batch ─
    if (req.method === 'GET' && action === 'set_discography_complete') {
      const artistId = url.searchParams.get('artist_id');
      const complete = url.searchParams.get('complete') === '1';
      if (!artistId) return json({ error: 'artist_id required' }, 400);
      const admin = await isAdmin(user.email);
      const owned = await canManageArtist(artistId, user.email, admin);
      if (!owned) return json({ error: 'You can only update artists you added.' }, 403);
      await dbPatch(`/artists?id=eq.${artistId}`, { discography_complete: complete });
      return json({ success: true, discography_complete: complete });
    }

    // ── fine-tune data: artist + albums + candidate covers from track thumbs ─
    if (req.method === 'GET' && action === 'finetune_data') {
      const artistId = url.searchParams.get('artist_id');
      if (!artistId) return json({ error: 'artist_id required' }, 400);
      const admin = await isAdmin(user.email);
      const owned = await canManageArtist(artistId, user.email, admin);
      if (!owned) return json({ error: 'You can only fine-tune artists you added.' }, 403);
      const [full] = await dbGet(`/artists?id=eq.${artistId}&select=id,name,color,slug`);
      const albs = await dbGet(`/albums?artist_id=eq.${artistId}&select=id,name,release_date,art_url,color&order=release_date.asc`);
      for (const al of albs) {
        const trs = await dbGet(`/tracks?album_id=eq.${al.id}&select=id&order=track_number&limit=50`);
        const ids = trs.map((t: any) => t.id);
        const ytOpts: string[] = [];
        if (al.art_url && /ytimg\.com/i.test(al.art_url)) ytOpts.push(al.art_url);
        for (let i = 0; i < ids.length && ytOpts.length < 8; i += 50) {
          const rows = await dbGet(`/metrics?track_id=in.(${ids.slice(i, i + 50).join(',')})&metric_name=eq.youtube_thumbnail&select=metric_text_value`);
          for (const r of rows) {
            const u = r.metric_text_value;
            if (u && !ytOpts.includes(u)) ytOpts.push(u);
            if (ytOpts.length >= 8) break;
          }
        }
        const wikiThumb = await wikiAlbumThumbnail(null, full.name, al.name);
        const opts: string[] = [];
        if (wikiThumb) opts.push(wikiThumb);
        if (al.art_url && !opts.includes(al.art_url)) opts.push(al.art_url);
        for (const u of ytOpts) { if (!opts.includes(u)) opts.push(u); }
        (al as any).art_wiki = wikiThumb;
        (al as any).art_options = opts.slice(0, 9);
      }
      return json({ artist: full, albums: albs });
    }

    // ── fine-tune save: artist name/color + album names/years/covers/colors ──
    if (req.method === 'POST' && action === 'finetune') {
      const body = await req.json().catch(() => ({}));
      if (!body.artist_id) return json({ error: 'artist_id required' }, 400);
      const admin = await isAdmin(user.email);
      const owned = await canManageArtist(body.artist_id, user.email, admin);
      if (!owned) return json({ error: 'You can only fine-tune artists you added.' }, 403);
      const patch: Record<string, unknown> = {};
      if (typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color)) patch.color = body.color;
      if (body.color === null) patch.color = null;
      if (typeof body.artist_name === 'string' && body.artist_name.trim()) patch.name = body.artist_name.trim().slice(0, 80);
      if (Object.keys(patch).length) await dbPatch(`/artists?id=eq.${body.artist_id}`, patch);
      let updated = 0;
      for (const al of (Array.isArray(body.albums) ? body.albums : []).slice(0, 40)) {
        if (!al?.id) continue;
        const [row] = await dbGet(`/albums?id=eq.${al.id}&select=id,artist_id`);
        if (!row || row.artist_id !== body.artist_id) continue;
        const ap: Record<string, unknown> = {};
        if (typeof al.name === 'string' && al.name.trim()) ap.name = al.name.trim().slice(0, 120);
        if (typeof al.release_date === 'string' && /^\d{4}(-\d{2}){0,2}$/.test(al.release_date)) {
          const p = al.release_date.split('-');
          const y = parseInt(p[0], 10);
          if (y >= 1900 && y <= 2100) ap.release_date = `${p[0]}-${p[1] || '01'}-${p[2] || '01'}`;
        }
        if (typeof al.art_url === 'string' && /^https?:\/\//.test(al.art_url)) ap.art_url = al.art_url.slice(0, 500);
        if (typeof al.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(al.color)) ap.color = al.color;
        if (al.color === null) ap.color = null;
        if (Object.keys(ap).length) { await dbPatch(`/albums?id=eq.${al.id}`, ap); updated++; }
      }
      return json({ success: true, albums_updated: updated });
    }

    // ── rename own community artist ──────────────────────────────────────────
    if (req.method === 'POST' && action === 'rename_artist') {
      const body = await req.json().catch(() => ({}));
      const newName = (body.name || '').trim().slice(0, 80);
      if (!body.artist_id || !newName) return json({ error: 'artist_id and name required' }, 400);
      const admin = await isAdmin(user.email);
      const a = await canManageArtist(body.artist_id, user.email, admin);
      if (!a) return json({ error: 'You can only rename artists you added.' }, 403);
      await dbPatch(`/artists?id=eq.${body.artist_id}`, { name: newName });
      return json({ success: true, name: newName });
    }

    // ── rename own community album ─────────────────────────────────────────
    if (req.method === 'POST' && action === 'rename_album') {
      const body = await req.json().catch(() => ({}));
      const newName = (body.name || '').trim().slice(0, 120);
      if (!body.album_id || !newName) return json({ error: 'album_id and name required' }, 400);
      const [alb] = await dbGet(`/albums?id=eq.${body.album_id}&select=id,artist_id`);
      if (!alb) return json({ error: 'Album not found' }, 404);
      const admin = await isAdmin(user.email);
      const artist = await canManageArtist(alb.artist_id, user.email, admin);
      if (!artist) return json({ error: 'You can only rename albums on artists you added.' }, 403);
      await dbPatch(`/albums?id=eq.${body.album_id}`, { name: newName });
      return json({ success: true, name: newName });
    }

    // ── rename own community track ─────────────────────────────────────────
    if (req.method === 'POST' && action === 'rename_track') {
      const body = await req.json().catch(() => ({}));
      const newName = (body.name || '').trim().slice(0, 200);
      if (!body.track_id || !newName) return json({ error: 'track_id and name required' }, 400);
      const [t] = await dbGet(`/tracks?id=eq.${body.track_id}&select=id,album_id`);
      if (!t) return json({ error: 'Track not found' }, 404);
      const [alb] = await dbGet(`/albums?id=eq.${t.album_id}&select=id,artist_id`);
      const admin = await isAdmin(user.email);
      const artist = alb && await canManageArtist(alb.artist_id, user.email, admin);
      if (!artist) return json({ error: 'You can only rename tracks on artists you added.' }, 403);
      await dbPatch(`/tracks?id=eq.${body.track_id}`, { name: newName });
      return json({ success: true, name: newName });
    }

    // ── delete one own album ─────────────────────────────────────────────────
    if (req.method === 'POST' && action === 'delete_album') {
      const body = await req.json().catch(() => ({}));
      if (!body.album_id) return json({ error: 'album_id required' }, 400);
      const [alb] = await dbGet(`/albums?id=eq.${body.album_id}&select=id,name,artist_id`);
      if (!alb) return json({ error: 'Album not found' }, 404);
      const admin = await isAdmin(user.email);
      const artist = await canManageArtist(alb.artist_id, user.email, admin);
      if (!artist) return json({ error: 'You can only remove albums from artists you added.' }, 403);
      const n = await deleteAlbumCascade(alb.id);
      return json({ success: true, removed_tracks: n });
    }

    // ── delete own artist + everything under it ──────────────────────────────
    if (req.method === 'POST' && action === 'delete_artist') {
      const body = await req.json().catch(() => ({}));
      if (!body.artist_id) return json({ error: 'artist_id required' }, 400);
      const admin = await isAdmin(user.email);
      const artist = await canManageArtist(body.artist_id, user.email, admin);
      if (!artist) return json({ error: 'You can only remove artists you added.' }, 403);
      if (!artist.is_community) {
        return json({ error: 'Official jukebox artists cannot be removed.' }, 403);
      }
      const albs = await dbGet(`/albums?artist_id=eq.${artist.id}&select=id`);
      let n = 0;
      for (const al of albs) n += await deleteAlbumCascade(al.id);
      // feedback/artist_rights/catalog hold artist_id with NO ON DELETE CASCADE
      // (feedback is how "Remove from My Artists" is stored). Clear them before
      // the artist row or the delete fails with 23503 after the albums are gone.
      for (const tbl of [
        'metrics', 'links', 'play_events', 'rating_events', 'feedback',
        'artist_rights_agreements', 'artist_catalog_tracks',
      ]) {
        try { await dbDelete(`/${tbl}?artist_id=eq.${artist.id}`); } catch (_) {}
      }
      await dbDelete(`/artists?id=eq.${artist.id}`);
      return json({ success: true, removed_albums: albs.length, removed_tracks: n });
    }

    // ── delete one own track (all referencing rows cascade) ─────────────────
    if (req.method === 'POST' && action === 'delete_track') {
      const body = await req.json().catch(() => ({}));
      if (!body.track_id) return json({ error: 'track_id required' }, 400);
      const [t] = await dbGet(`/tracks?id=eq.${body.track_id}&select=id,name,album_id,track_number`);
      if (!t) return json({ error: 'Track not found' }, 404);
      const [alb] = await dbGet(`/albums?id=eq.${t.album_id}&select=id,artist_id`);
      const admin = await isAdmin(user.email);
      const artist = alb && await canManageArtist(alb.artist_id, user.email, admin);
      if (!artist) return json({ error: 'You can only remove tracks from artists you added.' }, 403);
      const trackTables = ['metrics', 'lyrics', 'lyrics_edits', 'playlist_tracks', 'yt_daily_snapshots',
        'track_play_counts', 'play_events', 'rating_events', 'feedback', 'links', 'track_videos'];
      for (const tbl of trackTables) {
        try { await dbDelete(`/${tbl}?track_id=eq.${t.id}`); } catch (_) { /* table may have no such rows */ }
      }
      await dbDelete(`/tracks?id=eq.${t.id}`);

      // Close the numbering gap so the rest of the album stays sequential
      // (1, 2, 3, ... with no hole where the removed track used to be).
      if (t.track_number != null) {
        const rest = await dbGet(`/tracks?album_id=eq.${t.album_id}&track_number=gt.${t.track_number}&select=id,track_number&order=track_number`);
        for (const r of rest) {
          await dbPatch(`/tracks?id=eq.${r.id}`, { track_number: r.track_number - 1 });
        }
      }
      return json({ success: true });
    }

    // ── save lyrics for one own track (upsert + edit history) ─────────────────
    if (req.method === 'POST' && action === 'save_lyrics') {
      const body = await req.json().catch(() => ({}));
      const newLyrics = typeof body.lyrics === 'string' ? body.lyrics.trim() : '';
      if (!body.track_id || !newLyrics) return json({ error: 'track_id and lyrics required' }, 400);
      const [t] = await dbGet(`/tracks?id=eq.${body.track_id}&select=id,album_id`);
      if (!t) return json({ error: 'Track not found' }, 404);
      const [alb] = await dbGet(`/albums?id=eq.${t.album_id}&select=id,artist_id`);
      const admin = await isAdmin(user.email);
      const artist = alb && await canManageArtist(alb.artist_id, user.email, admin);
      if (!artist) return json({ error: 'You can only edit lyrics on artists you added.' }, 403);
      const [existingLyr] = await dbGet(`/lyrics?track_id=eq.${t.id}&select=id,lyrics`);
      const stamp = { lyrics: newLyrics, lyrics_source: 'user-edit', lyrics_saved_at: new Date().toISOString() };
      if (existingLyr) await dbPatch(`/lyrics?track_id=eq.${t.id}`, stamp);
      else await dbInsert('lyrics', { track_id: t.id, ...stamp });
      try {
        await dbInsert('lyrics_edits', {
          track_id: t.id, old_lyrics: existingLyr?.lyrics || null, new_lyrics: newLyrics,
          editor_email: user.email, editor_name: user.name,
        });
      } catch (_) { /* history is best-effort */ }
      return json({ success: true });
    }

    // ── enrich one album: release date + lyrics ──────────────────────────────
    if (req.method === 'POST' && action === 'enrich') {
      const body = await req.json().catch(() => ({}));
      const { album_id } = body;
      if (!album_id) return json({ error: 'album_id required' }, 400);

      const [alb] = await dbGet(`/albums?id=eq.${album_id}&select=id,name,release_date,artist_id,yt_playlist_id`);
      // No yt_playlist_id check — albums built song by song never have one.
      if (!alb) return json({ error: 'Community album not found' }, 404);
      const [artist] = await dbGet(`/artists?id=eq.${alb.artist_id}&select=id,name,is_community`);
      if (!artist?.is_community) return json({ error: 'Only community albums can be enriched' }, 400);

      const tracks = await dbGet(`/tracks?album_id=eq.${album_id}&select=id,name,duration_ms,lyrics_synced&order=track_number`);
      const cleanName = cleanAlbumName(alb.name, artist.name);
      const log: string[] = [];
      let dateUpdated = false, lyricsFound = 0, lyricsSyncedN = 0, lyricsMissing = 0;

      try {
        const year = yearOf(alb.release_date);
        let hit = await mbReleaseDate(artist.name, cleanName, year);
        let src = 'MusicBrainz';
        if (!hit) { hit = await itunesReleaseDate(artist.name, cleanName, year); src = 'iTunes'; }
        const hitYear = yearOf(hit?.date);
        // Never jump a dated album to a different year — that is how Weezer's
        // Blue Album (1994) used to get rewritten as the White Album (2016).
        const yearOk = !year || !hitYear || year === hitYear;
        if (hit && yearOk && hit.date !== alb.release_date) {
          await dbPatch(`/albums?id=eq.${alb.id}`, { release_date: hit.date });
          dateUpdated = true;
          log.push(`  ✓ "${cleanName}" — release date ${alb.release_date || 'unknown'} → ${hit.date} (${src})`);
        } else if (hit && yearOk) {
          log.push(`  ✓ "${cleanName}" — release date ${alb.release_date} confirmed (${src})`);
        } else if (hit && !yearOk) {
          log.push(`  · "${cleanName}" — kept ${alb.release_date} rather than ${hit.date} (${src}, different year)`);
        } else {
          log.push(`  · "${cleanName}" — no confident date match, kept ${alb.release_date || 'unknown'}`);
        }
      } catch (e: any) {
        log.push(`  ⚠ "${cleanName}" date lookup failed: ${e.message}`);
      }

      const ids = tracks.map((t: any) => t.id);
      const haveLyrics = new Set<string>();
      for (let i = 0; i < ids.length; i += 50) {
        const rows = await dbGet(`/lyrics?track_id=in.(${ids.slice(i, i + 50).join(',')})&select=track_id`);
        rows.forEach((r: any) => haveLyrics.add(r.track_id));
      }
      const todo = tracks.filter((t: any) => !haveLyrics.has(t.id));

      for (let i = 0; i < todo.length; i += LYRICS_CONCURRENCY) {
        const chunk = todo.slice(i, i + LYRICS_CONCURRENCY);
        await Promise.all(chunk.map(async (t: any) => {
          try {
            const hit = await lrclibLookup(artist.name, t.name, t.duration_ms ? t.duration_ms / 1000 : null);
            if (hit && (hit.plain || hit.synced)) {
              const plain = hit.plain || (hit.synced ? hit.synced.replace(/\[[^\]]*\]/g, '').split('\n').map((s: string) => s.trim()).filter(Boolean).join('\n') : null);
              if (plain) {
                await dbInsert('lyrics', { track_id: t.id, lyrics: plain, lyrics_source: 'lrclib', lyrics_saved_at: new Date().toISOString() });
                lyricsFound++;
              }
              if (hit.synced && !t.lyrics_synced) {
                await dbPatch(`/tracks?id=eq.${t.id}`, { lyrics_synced: hit.synced });
                lyricsSyncedN++;
              }
            } else {
              lyricsMissing++;
            }
          } catch (_) { lyricsMissing++; }
        }));
      }

      if (todo.length) log.push(`  ✓ lyrics: found ${lyricsFound} of ${todo.length} (${lyricsSyncedN} synced)${lyricsMissing ? ` · ${lyricsMissing} not on LRCLIB` : ''}`);
      return json({
        success: true, album_id, date_updated: dateUpdated,
        lyrics_found: lyricsFound, lyrics_synced: lyricsSyncedN, lyrics_missing: lyricsMissing, log,
      });
    }

    if (!YT_KEY) return json({ error: 'YOUTUBE_API_KEY secret not configured' }, 400);

    // ── playlist_info: metadata for explicit playlist ids (manual add) ───────
    // ── channel_playlists: one YouTube link → the channel and everything it hosts ──
    if (req.method === 'GET' && action === 'channel_playlists') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json({ error: 'Paste a YouTube channel or video link' }, 400);

      const cap = (re: RegExp) => { const r = q.match(re); return r ? r[1] : null; };
      let channelId =
        cap(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{20,})/i) ||
        (/^UC[A-Za-z0-9_-]{20,}$/.test(q) ? q : null);
      const handle =
        cap(/youtube\.com\/@([A-Za-z0-9_.\-]{2,60})/i) ||
        (/^@[A-Za-z0-9_.\-]{2,60}$/.test(q) ? q.slice(1) : null);
      const legacyUser = cap(/youtube\.com\/(?:user|c)\/([A-Za-z0-9_.\-]{2,60})/i);
      const videoId =
        cap(/[?&]v=([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/) ||
        cap(/youtu\.be\/([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/i) ||
        cap(/youtube\.com\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/i) ||
        (/^[A-Za-z0-9_-]{11}$/.test(q) ? q : null);
      const seedPlaylist = cap(/[?&]list=([A-Za-z0-9_-]{10,60})/);

      // Anything that names a channel outright wins; otherwise walk back from
      // whatever the listener happened to paste.
      try {
        if (!channelId && videoId) {
          const d = await yt('videos', { part: 'snippet', id: videoId });
          channelId = d.items?.[0]?.snippet?.channelId || null;
        }
        if (!channelId && seedPlaylist) {
          const d = await yt('playlists', { part: 'snippet', id: seedPlaylist });
          channelId = d.items?.[0]?.snippet?.channelId || null;
        }
        if (!channelId && handle) {
          const d = await yt('channels', { part: 'id', forHandle: '@' + handle });
          channelId = d.items?.[0]?.id || null;
        }
        if (!channelId && legacyUser) {
          const d = await yt('channels', { part: 'id', forUsername: legacyUser });
          channelId = d.items?.[0]?.id || null;
        }
        if (!channelId) {
          const term = (handle || legacyUser || q.replace(/https?:\/\/\S+/g, '').trim() || q).slice(0, 80);
          const d = await yt('search', { part: 'snippet', q: term, type: 'channel', maxResults: '1' });
          channelId = d.items?.[0]?.snippet?.channelId || null;
        }
      } catch (e) {
        return json({ error: `YouTube lookup failed: ${(e as Error).message}` }, 502);
      }
      if (!channelId) {
        return json({ error: 'No YouTube channel found for that. Paste the channel URL, or a link to one of their videos.' }, 404);
      }

      const cd = await yt('channels', { part: 'snippet,statistics,contentDetails', id: channelId });
      const c = cd.items?.[0];
      if (!c) return json({ error: 'That YouTube channel could not be loaded.' }, 404);
      const rawTitle: string = c.snippet?.title || '';
      const artistName = rawTitle.replace(/\s*-\s*Topic$/i, '').trim() || rawTitle;
      const uploadsId: string | null = c.contentDetails?.relatedPlaylists?.uploads || null;
      const channel = {
        channel_id: channelId,
        title: rawTitle,
        artist_name: artistName,
        thumbnail: c.snippet?.thumbnails?.medium?.url || c.snippet?.thumbnails?.default?.url || null,
        subscribers: parseInt(c.statistics?.subscriberCount || '0', 10),
        video_count: parseInt(c.statistics?.videoCount || '0', 10),
        uploads_playlist_id: uploadsId,
      };

      const playlists: any[] = [];
      const pushPl = (p: any, ownerId: string, ownerTitle: string, featured: boolean) => {
        if (playlists.some(x => x.playlist_id === p.id)) return;
        playlists.push({
          playlist_id: p.id,
          title: p.snippet?.title || '(untitled)',
          track_count: p.contentDetails?.itemCount ?? 0,
          thumbnail: p.snippet?.thumbnails?.medium?.url || p.snippet?.thumbnails?.default?.url || null,
          channel_id: p.snippet?.channelId || ownerId,
          channel_title: p.snippet?.channelTitle || ownerTitle,
          published_at: p.snippet?.publishedAt || null,
          featured,
          is_uploads: false,
          already_imported: false,
        });
      };
      // Everything the channel owns
      let pageToken: string | undefined;
      for (let i = 0; i < 4; i++) {
        const params: Record<string, string> = { part: 'snippet,contentDetails', channelId, maxResults: '50' };
        if (pageToken) params.pageToken = pageToken;
        const d = await yt('playlists', params);
        for (const p of (d.items || [])) pushPl(p, channelId, rawTitle, false);
        pageToken = d.nextPageToken;
        if (!pageToken) break;
      }

      // Plus anything shelved on the channel page. Artists routinely feature a
      // playlist owned by their label or a side project, and playlists.list
      // never returns those.
      let featured_count = 0;
      try {
        const sec = await yt('channelSections', { part: 'contentDetails', channelId });
        const ids: string[] = [];
        for (const it of (sec.items || [])) {
          for (const pid of (it.contentDetails?.playlists || [])) {
            if (!playlists.some(x => x.playlist_id === pid) && !ids.includes(pid)) ids.push(pid);
          }
        }
        for (let i = 0; i < ids.length; i += 50) {
          const d = await yt('playlists', { part: 'snippet,contentDetails', id: ids.slice(i, i + 50).join(','), maxResults: '50' });
          // Private or deleted shelf entries simply don't come back
          for (const p of (d.items || [])) { pushPl(p, channelId, rawTitle, true); featured_count++; }
        }
      } catch (_) { /* shelves are a bonus, not a requirement */ }

      // Plus the channel's Releases tab. YouTube Music owns the auto-generated
      // album playlists (OLAK5uy_...), so playlists.list?channelId= never
      // returns them and small artists rarely shelf them - the tab's HTML is
      // the only index of a channel's releases.
      try {
        const r = await fetch(`https://www.youtube.com/channel/${channelId}/releases?hl=en`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Accept-Language': 'en',
            'Cookie': 'CONSENT=YES+cb; SOCS=CAI',
          },
          signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        });
        if (r.ok) {
          const html = await r.text();
          const ids = [...new Set(html.match(/OLAK5uy_[A-Za-z0-9_-]{33}/g) || [])]
            .filter(id => !playlists.some(x => x.playlist_id === id))
            .slice(0, 100);
          for (let i = 0; i < ids.length; i += 50) {
            const d = await yt('playlists', { part: 'snippet,contentDetails', id: ids.slice(i, i + 50).join(','), maxResults: '50' });
            for (const p of (d.items || [])) pushPl(p, channelId, rawTitle, false);
          }
        }
      } catch (_) { /* releases are a bonus, not a requirement */ }

      // A channel with no playlists still has videos - offer the uploads feed so
      // artists like these are importable at all.
      if (uploadsId && channel.video_count > 0) {
        playlists.push({
          playlist_id: uploadsId,
          title: 'All Videos',
          track_count: channel.video_count,
          thumbnail: channel.thumbnail,
          channel_id: channelId,
          channel_title: rawTitle,
          published_at: null,
          from_topic: false,
          is_uploads: true,
          already_imported: false,
        });
      }

      const out = playlists.filter(p => p.is_uploads || p.track_count > 0);
      // Album releases first (OLAK5uy_ is YouTube Music's release id), then the
      // channel's own playlists biggest-first, uploads last.
      out.sort((a, b) => {
        if (a.is_uploads !== b.is_uploads) return a.is_uploads ? 1 : -1;
        const ra = /^OLAK5uy_/.test(a.playlist_id) ? 0 : 1;
        const rb = /^OLAK5uy_/.test(b.playlist_id) ? 0 : 1;
        if (ra !== rb) return ra - rb;
        if (a.featured !== b.featured) return a.featured ? 1 : -1;
        return b.track_count - a.track_count;
      });

      const plIds = out.map(p => p.playlist_id);
      for (let i = 0; i < plIds.length; i += 50) {
        const rows = await dbGet(`/albums?yt_playlist_id=in.(${plIds.slice(i, i + 50).join(',')})&select=yt_playlist_id`);
        for (const r of rows) {
          const hit = out.find(p => p.playlist_id === r.yt_playlist_id);
          if (hit) hit.already_imported = true;
        }
      }

      let existing: any = null;
      let existing_albums: string[] = [];
      try {
        const known = await dbGet('/artists?select=id,name,is_community,yt_channel_id,visibility,added_by');
        existing = known.find((a: any) =>
          canMergeIntoArtist(a, user.email) && (
            (isIdentifyingChannel(channelId) && a.yt_channel_id === channelId) ||
            norm(a.name) === norm(artistName)
          )) || null;
        if (existing?.is_community) {
          const albs = await dbGet(`/albums?artist_id=eq.${existing.id}&select=name`);
          existing_albums = albs.map((x: any) => x.name);
        }
      } catch (_) {}

      return json({
        channel, featured_count, playlists: out,
        max_playlists: MAX_PLAYLISTS_PER_IMPORT,
        max_tracks_per_playlist: MAX_TRACKS_PER_PLAYLIST,
        existing: existing ? { id: existing.id, name: existing.name, is_community: existing.is_community } : null,
        existing_albums,
      });
    }

    if (req.method === 'GET' && action === 'playlist_info') {
      const raw = (url.searchParams.get('ids') || '').trim();
      if (!raw) return json({ error: 'ids required' }, 400);
      const ids = [...new Set(raw.split(',').map(s => s.trim()).filter(s => /^[A-Za-z0-9_-]{10,60}$/.test(s)))].slice(0, MAX_PLAYLISTS_PER_IMPORT);
      if (!ids.length) return json({ error: 'No valid playlist ids' }, 400);
      const results: any[] = [];
      for (let i = 0; i < ids.length; i += 50) {
        const d = await yt('playlists', { part: 'snippet,contentDetails', id: ids.slice(i, i + 50).join(','), maxResults: '50' });
        for (const p of (d.items || [])) {
          results.push({
            playlist_id: p.id,
            title: p.snippet?.title || '(untitled)',
            track_count: p.contentDetails?.itemCount ?? 0,
            thumbnail: p.snippet?.thumbnails?.medium?.url || null,
            channel_id: p.snippet?.channelId || '',
            channel_title: p.snippet?.channelTitle || '',
            already_imported: false,
          });
        }
      }
      const plIds = results.map(r => r.playlist_id);
      for (let i = 0; i < plIds.length; i += 50) {
        const rows = await dbGet(`/albums?yt_playlist_id=in.(${plIds.slice(i, i + 50).join(',')})&select=yt_playlist_id`);
        for (const r of rows) {
          const hit = results.find(p => p.playlist_id === r.yt_playlist_id);
          if (hit) hit.already_imported = true;
        }
      }
      const found = new Set(plIds);
      return json({ results, missing: ids.filter(id => !found.has(id)) });
    }

    // ── identify: wiki summary + studio discography + auto-picked channel ────
    if (req.method === 'GET' && action === 'identify') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json({ error: 'Missing q' }, 400);
      // MusicBrainz release groups are the canonical discography. Wikipedia is
      // retained below only for optional editorial text/cover art: its page
      // structure and list contents must never decide which albums we import.
      const [wiki, mbd] = await Promise.all([wikiSummary(q), mbDiscography(q)]);
      const albums = mbd.albums.map(a => ({ ...a, wiki_page: null }));
      // Do not let a Wikipedia search result turn a failed MusicBrainz identity
      // lookup into a different artist import.
      const artist_name = mbd.name || q;
      // auto-pick the best channel: Topic channel > exact-name w/ most subs > top hit
      let channel: any = null;
      try {
        const d = await yt('search', { part: 'snippet', q: artist_name, type: 'channel', maxResults: '8' });
        const ids = (d.items || []).map((i: any) => i.snippet?.channelId).filter(Boolean);
        if (ids.length) {
          const cd = await yt('channels', { part: 'statistics,snippet', id: ids.join(','), maxResults: '50' });
          const byId: Record<string, any> = {};
          for (const c of (cd.items || [])) byId[c.id] = c;
          const chans = ids.map((id: string) => byId[id]).filter(Boolean).map((c: any) => ({
            channel_id: c.id,
            title: c.snippet?.title || '',
            thumbnail: c.snippet?.thumbnails?.medium?.url || null,
            subscribers: parseInt(c.statistics?.subscriberCount || '0', 10),
          }));
          const na = norm(artist_name);
          channel = chans.find((c: any) => /- topic$/i.test(c.title) && norm(c.title.replace(/\s*-\s*Topic$/i, '')) === na)
            || chans.filter((c: any) => norm(c.title) === na).sort((a: any, b: any) => b.subscribers - a.subscribers)[0]
            || chans[0] || null;
        }
      } catch (_) {}
      // existing-artist flags (block main-jukebox artists, surface community merges)
      let existing: any = null;
      let existing_albums: string[] = [];
      try {
        const known = await dbGet('/artists?select=id,name,is_community,yt_channel_id,visibility,added_by');
        existing = known.find((a: any) =>
          canMergeIntoArtist(a, user.email) && (
            (channel && isIdentifyingChannel(channel.channel_id) && a.yt_channel_id === channel.channel_id) ||
            norm(a.name) === norm(artist_name)
          )) || null;
        if (existing?.is_community) {
          const albs = await dbGet(`/albums?artist_id=eq.${existing.id}&select=name`);
          existing_albums = albs.map((x: any) => x.name);
        }
      } catch (_) {}
      return json({
        artist_name, wiki, channel, albums, catalog_source: mbd.source,
        existing: existing ? { id: existing.id, name: existing.name, is_community: existing.is_community } : null,
        existing_albums,
      });
    }

    // ── match_album: pick the best playlist for one album ────────────────────
    if (req.method === 'GET' && action === 'match_album') {
      const artist = (url.searchParams.get('artist') || '').trim();
      const album = (url.searchParams.get('album') || '').trim();
      const rg = (url.searchParams.get('rg') || '').trim();
      const year = (url.searchParams.get('year') || '').trim().slice(0, 4);
      const channelId = (url.searchParams.get('channel_id') || '').trim();
      if (!artist || !album) return json({ error: 'artist and album required' }, 400);

      let official: Array<{ title: string; lengthMs: number | null }> | null = null;
      try { official = await mbOfficialTracklist(artist, album, rg || null, year); } catch (_) {}
      if (!official || !official.length) {
        try { official = await itunesTracklist(artist, album, year || undefined); } catch (_) {}
      }
      const officialTitles = (official || []).map(t => t.title);
      // A playlist is only a source of candidate videos, never proof of an
      // album.  If we do not have a canonical tracklist, return no playlist
      // match so the importer can use its song-by-song (MusicBrainz, then
      // iTunes) fallback instead of copying an arbitrary YouTube playlist.
      if (!officialTitles.length) {
        return json({ match: null, expected: null, reason: 'No verified tracklist for this album' });
      }
      const expected: number = officialTitles.length;
      const minHits = officialTitles.length
        ? Math.min(officialTitles.length, Math.max(3, Math.ceil(officialTitles.length * 0.4)))
        : 0;

      const cands: Array<{ id: string; title: string; count: number; channel: string; prelim: number }> = [];
      const seen = new Set<string>();
      const addCands = (items: any[]) => {
        for (const p of items) {
          if (!p?.id || seen.has(p.id)) continue;
          seen.add(p.id);
          cands.push({
            id: p.id,
            title: p.snippet?.title || '',
            count: p.contentDetails?.itemCount ?? 0,
            channel: p.snippet?.channelTitle || '',
            prelim: 0,
          });
        }
      };
      if (channelId) {
        try { addCands((await yt('playlists', { part: 'snippet,contentDetails', channelId, maxResults: '50' })).items || []); } catch (_) {}
      }
      // "full album" and the year pull in fan uploads; YouTube's own album
      // playlist (OLAK5uy_…, listed only on a channel's Releases tab, which the
      // API cannot read) answers the plain "artist album" query. Roger Waters'
      // Pros and Cons of Hitch Hiking was skipped because only the first query
      // ran. The second costs another 100 units, so it runs only on a miss.
      const queries = [
        [artist, album, year, 'full album'].filter(Boolean).join(' '),
        `${artist} ${album}`,
      ];
      const nb = norm(album);
      const nCore = norm(coreTitle(album));
      const nNick = norm(nickTitle(album));
      const checked = new Set<string>();
      let best: any = null, bestScore = -1;
      for (const q of queries) {
      try {
        const sd = await yt('search', { part: 'snippet', type: 'playlist', q, maxResults: '10' });
        const ids = (sd.items || []).map((i: any) => i.id?.playlistId).filter((x: string) => x && !seen.has(x));
        if (ids.length) addCands((await yt('playlists', { part: 'snippet,contentDetails', id: ids.join(','), maxResults: '50' })).items || []);
      } catch (_) { /* rate-limited → candidates found so far only */ }
      const scored: typeof cands = [];
      for (const c of cands) {
        if (checked.has(c.id)) continue;
        if (!c.count || c.count < 3) continue;
        const cn = norm(cleanAlbumName(c.title, artist));
        const cAll = norm(c.title);
        let ts = 0;
        if (cn === nb) ts = 3;
        else if (nNick && (cn.includes(nNick) || cAll.includes(nNick))) ts = 2.5;
        else if (nb.length >= 6 && (cn.includes(nb) || (nb.includes(cn) && cn.length >= 6))) ts = 1.5;
        else if (nCore.length >= 6 && (cn === nCore || (nCore.includes(cn) && cn.length >= 6))) ts = 1;
        else continue;
        if (nNick && (cn.includes(nNick) || cAll.includes(nNick))) ts += 1.5;
        if (!expected && c.count > 35) continue;
        if (expected && c.count > expected * 2 + 8) continue;
        const low = c.title.toLowerCase();
        let pen = 0;
        for (const w of JUNK_WORDS) if (low.includes(w) && !album.toLowerCase().includes(w)) pen += 0.5;
        c.prelim = ts - pen + (expected ? Math.max(0, 2 - Math.abs(c.count - expected) * 0.5) : 0);
        scored.push(c);
      }
      scored.sort((a, b) => b.prelim - a.prelim);

      for (const c of scored.slice(0, 8)) {
        checked.add(c.id);
        let st;
        try { st = await playlistStats(c.id); } catch (_) { continue; }
        if (st.vids.length < 3) continue;
        const hits = officialTitles.length ? officialTrackHits(officialTitles, st.titles, artist) : 0;
        if (minHits && hits < minHits) continue;
        let s = c.prelim + Math.log10(st.views + 1) * 0.4 + hits * 2;
        if (expected) s += Math.max(0, 1.5 - Math.abs(st.vids.length - expected) * 0.5);
        if (norm(c.channel).includes(norm(artist)) || /topic/i.test(c.channel)) s += 0.7;
        if (s > bestScore) {
          bestScore = s;
          best = { playlist_id: c.id, title: c.title, track_count: st.vids.length, views: st.views, channel_title: c.channel, score: Math.round(s * 100) / 100, title_hits: hits };
        }
      }
      // A clean album playlist ends the search. One padded with other videos
      // (a fan's 30-song tour set list held all 12 Pros and Cons songs) is kept
      // as a fallback while the plain query looks for the album itself.
      if (best && best.track_count <= expected + 2) break;
      }
      return json({ match: best, expected });
    }

    // ── search artist channels (legacy) ──────────────────────────────────────
    if (req.method === 'GET' && action === 'search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json({ error: 'Missing q' }, 400);
      const d = await yt('search', { part: 'snippet', q, type: 'channel', maxResults: '8' });
      const ids = (d.items || []).map((i: any) => i.snippet?.channelId).filter(Boolean);
      let statsMap: Record<string, any> = {};
      if (ids.length) {
        const cd = await yt('channels', { part: 'statistics,snippet', id: ids.join(','), maxResults: '50' });
        for (const c of (cd.items || [])) statsMap[c.id] = c;
      }
      const results = (d.items || []).map((i: any) => {
        const cid = i.snippet.channelId;
        const full = statsMap[cid];
        return {
          channel_id: cid,
          title: i.snippet.title,
          description: (i.snippet.description || '').slice(0, 120),
          thumbnail: full?.snippet?.thumbnails?.medium?.url || i.snippet?.thumbnails?.medium?.url || null,
          subscribers: full ? parseInt(full.statistics?.subscriberCount || '0', 10) : 0,
          videos: full ? parseInt(full.statistics?.videoCount || '0', 10) : 0,
        };
      });
      try {
        const known = await dbGet('/artists?select=id,name,is_community,yt_channel_id,visibility,added_by');
        for (const r of results) {
          const plain = r.title.replace(/\s*-\s*Topic$/i, '');
          const hit = known.find((a: any) =>
            canMergeIntoArtist(a, user.email) &&
            (a.yt_channel_id === r.channel_id || norm(a.name) === norm(plain)));
          if (hit) { r.existing_artist_id = hit.id; r.existing_is_community = hit.is_community; r.existing_name = hit.name; }
        }
      } catch (_) { /* annotation is best-effort */ }
      return json({ results });
    }

    // ── list albums (legacy): channel playlists + playlist-search supplement ──
    if (req.method === 'GET' && action === 'albums') {
      const channelId = url.searchParams.get('channel_id');
      const q = (url.searchParams.get('q') || '').trim();
      if (!channelId) return json({ error: 'Missing channel_id' }, 400);

      const items: any[] = [];
      let pageToken = '';
      do {
        const d = await yt('playlists', {
          part: 'snippet,contentDetails', channelId, maxResults: '50',
          ...(pageToken ? { pageToken } : {}),
        });
        items.push(...(d.items || []));
        pageToken = d.nextPageToken || '';
      } while (pageToken && items.length < 100);

      const seen = new Set(items.map(p => p.id));
      const results: any[] = items.map(p => ({
        playlist_id: p.id,
        title: p.snippet?.title || '(untitled)',
        track_count: p.contentDetails?.itemCount ?? 0,
        thumbnail: p.snippet?.thumbnails?.medium?.url || null,
        channel_title: p.snippet?.channelTitle || '',
        source: 'channel',
        already_imported: false,
      }));

      if (q) {
        try {
          const sd = await yt('search', { part: 'snippet', type: 'playlist', q: `${q} album`, maxResults: '15' });
          const found = (sd.items || []).map((i: any) => i.id?.playlistId).filter((id: string) => id && !seen.has(id));
          if (found.length) {
            const pd = await yt('playlists', { part: 'snippet,contentDetails', id: found.join(','), maxResults: '50' });
            for (const p of (pd.items || [])) {
              results.push({
                playlist_id: p.id,
                title: p.snippet?.title || '(untitled)',
                track_count: p.contentDetails?.itemCount ?? 0,
                thumbnail: p.snippet?.thumbnails?.medium?.url || null,
                channel_title: p.snippet?.channelTitle || '',
                source: 'search',
                already_imported: false,
              });
            }
          }
        } catch (_) { /* search failure shouldn't kill channel results */ }
      }

      const plIds = results.map(p => p.playlist_id);
      for (let i = 0; i < plIds.length; i += 50) {
        const rows = await dbGet(`/albums?yt_playlist_id=in.(${plIds.slice(i, i + 50).join(',')})&select=yt_playlist_id`);
        for (const r of rows) {
          const hit = results.find(p => p.playlist_id === r.yt_playlist_id);
          if (hit) hit.already_imported = true;
        }
      }

      return json({ results: results.filter(p => p.track_count > 0) });
    }

    // ── add one track to an own album from a YouTube video link ─────────────
    if (req.method === 'POST' && action === 'add_track') {
      const body = await req.json().catch(() => ({}));
      const albumId = body.album_id;
      const vm = String(body.video || '').match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})|^([A-Za-z0-9_-]{11})$/);
      const videoId = vm ? (vm[1] || vm[2]) : null;
      if (!albumId || !videoId) return json({ error: 'album_id and a YouTube video link required' }, 400);
      const [alb] = await dbGet(`/albums?id=eq.${albumId}&select=id,name,artist_id`);
      if (!alb) return json({ error: 'Album not found' }, 404);
      const admin = await isAdmin(user.email);
      const artist = await canManageArtist(alb.artist_id, user.email, admin);
      if (!artist) return json({ error: 'You can only add tracks to artists you added.' }, 403);

      const existingTr = await dbGet(`/tracks?album_id=eq.${albumId}&select=id,track_number`);
      const exIds = existingTr.map((t: any) => t.id);
      for (let i = 0; i < exIds.length; i += 50) {
        const rows = await dbGet(`/metrics?track_id=in.(${exIds.slice(i, i + 50).join(',')})&metric_name=eq.youtube_video_id&metric_text_value=eq.${videoId}&select=id`);
        if (rows.length) return json({ error: 'That video is already in this album.' }, 409);
      }

      const vd = await yt('videos', { part: 'statistics,snippet,contentDetails', id: videoId, maxResults: '1' });
      const v = vd.items?.[0];
      if (!v) return json({ error: 'Video not found on YouTube.' }, 404);

      const trackName = cleanTrackName(v.snippet?.title || 'Untitled', artist.name);
      const nextNo = existingTr.reduce((mx: number, t: any) => Math.max(mx, t.track_number || 0), 0) + 1;
      const [tr] = await dbInsert('tracks', {
        album_id: albumId, name: trackName, track_number: nextNo, disc_number: 1,
        duration_ms: iso8601ToMs(v.contentDetails?.duration), explicit: false, yt_snapshot_enabled: true,
      }, true);

      const now = new Date().toISOString();
      const base = {
        track_id: tr.id, album_id: null, artist_id: null,
        metric_source: 'youtube', metric_date: now, metric_type: 'track',
        metric_value: null, metric_text_value: null,
      };
      await dbInsert('metrics', [
        { ...base, metric_name: 'youtube_video_id',  metric_text_value: videoId },
        { ...base, metric_name: 'youtube_views',     metric_value: parseInt(v.statistics?.viewCount || '0', 10) },
        { ...base, metric_name: 'youtube_likes',     metric_value: parseInt(v.statistics?.likeCount || '0', 10) },
        { ...base, metric_name: 'youtube_thumbnail', metric_text_value: v.snippet?.thumbnails?.medium?.url || '' },
        { ...base, metric_name: 'youtube_title',     metric_text_value: v.snippet?.title || '' },
        { ...base, metric_name: 'youtube_channel',   metric_text_value: v.snippet?.channelTitle || '' },
      ]);

      const channel = v.snippet?.channelTitle || '';
      await dbInsert('track_videos', [{
        track_id: tr.id,
        video_id: videoId,
        title: v.snippet?.title || trackName,
        channel,
        thumbnail: v.snippet?.thumbnails?.medium?.url || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        view_count: parseInt(v.statistics?.viewCount || '0', 10),
        like_count: parseInt(v.statistics?.likeCount || '0', 10),
        is_primary: true,
        source: 'sync',
        label: /- topic$/i.test(channel) ? 'Original Audio' : null,
        counts_for_charts: true,
      }], true);

      let lyricsFound = false;
      try {
        const hit = await lrclibLookup(artist.name, trackName, tr.duration_ms ? tr.duration_ms / 1000 : null);
        if (hit && (hit.plain || hit.synced)) {
          const plain = hit.plain || (hit.synced ? hit.synced.replace(/\[[^\]]*\]/g, '').split('\n').map((x: string) => x.trim()).filter(Boolean).join('\n') : null);
          if (plain) {
            await dbInsert('lyrics', { track_id: tr.id, lyrics: plain, lyrics_source: 'lrclib', lyrics_saved_at: new Date().toISOString() });
            lyricsFound = true;
          }
          if (hit.synced) await dbPatch(`/tracks?id=eq.${tr.id}`, { lyrics_synced: hit.synced });
        }
      } catch (_) { /* lyrics are best-effort */ }

      return json({ success: true, track: { id: tr.id, name: trackName, track_number: nextNo }, lyrics_found: lyricsFound });
    }

    // ── import selected playlists ───────────────────────────────────────────
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const { channel_id, artist_name } = body;
      const isManual = body.manual === true;
      // One import path, one content store.  Visibility is stamped onto the
      // rows it writes; it never routes the import somewhere else.
      const visibility: 'public' | 'private' = body.visibility === 'private' ? 'private' : 'public';
      // 'artist' means the whole discography was on offer.  Anything narrower
      // leaves the artist flagged incomplete so the UI can offer to finish it.
      const scope: 'artist' | 'album' | 'song' =
        body.scope === 'album' ? 'album' : body.scope === 'song' ? 'song' : 'artist'; // manual add: channel came from the pasted playlist, not the artist
      let playlists: Array<{ id?: string | null; title: string; release_date?: string; rg?: string; wiki_page?: string }> = body.playlists || [];
      if (!artist_name || !playlists.length) {
        return json({ error: 'artist_name and playlists[] required' }, 400);
      }
      playlists = playlists.slice(0, MAX_PLAYLISTS_PER_IMPORT);
      const log: string[] = [`▶ Importing ${artist_name} (${playlists.length} album${playlists.length === 1 ? '' : 's'})`];

      let existingRow: any = null;
      // Manual adds pass the pasted playlist's owning channel, which for
      // auto-generated album playlists is often a shared/generic channel that
      // would merge unrelated artists - match those by name only.
      if (!isManual && isIdentifyingChannel(channel_id)) {
        const byChannel = await dbGet(`/artists?yt_channel_id=eq.${channel_id}&select=id,name,is_community,visibility,added_by`);
        existingRow = byChannel.find((a: any) => canMergeIntoArtist(a, user.email)) || null;
      }
      if (!existingRow) {
        const all = await dbGet('/artists?select=id,name,is_community,yt_channel_id,visibility,added_by');
        existingRow = all.find((a: any) => norm(a.name) === norm(artist_name) && canMergeIntoArtist(a, user.email)) || null;
      }
      if (existingRow && !existingRow.is_community) {
        return json({ error: `"${existingRow.name}" is already part of the main jukebox — no need to add them.` }, 409);
      }

      const [run] = await dbInsert('sync_runs', { source: 'youtube', notes: `Community import: ${artist_name} by ${user.email}` }, true);
      const runId = run.id;

      let artistId: string;
      if (existingRow) {
        artistId = existingRow.id;
        // An existing artist keeps the visibility it already has: a private
        // import must never quietly hide someone else's public artist, and a
        // public one must never expose a private library.  Only a full
        // discography run that actually lands albums may clear the incomplete
        // flag — marking it complete on the first batch used to leave artists
        // like The Beatles "done" with three albums after the rest failed.
        const _visPatch: Record<string, any> = { last_sync_id: runId };
        await dbPatch(`/artists?id=eq.${artistId}`, _visPatch);
        log.push(`  Artist already in jukebox: ${existingRow.name} — adding to their catalog`);
      } else {
        const slug = await uniqueSlug(artist_name);
        const [a] = await dbInsert('artists', {
          name: artist_name, slug, is_community: true, added_by: user.email, added_by_name: user.name,
          visibility, discography_complete: false,
          yt_channel_id: isIdentifyingChannel(channel_id) ? channel_id : null, last_sync_id: runId,
        }, true);
        artistId = a.id;
        log.push(`  Created artist: ${artist_name}${visibility === 'private' ? ' (My Jukebox only)' : ''}`);
      }

      // Rights are recorded for every import, public or private, so "artists I
      // brought in" is one query rather than a scan of added_by across three
      // tables.  The primary key makes a repeat import idempotent.
      try {
        await dbInsert('content_access', { artist_id: artistId, user_email: user.email });
      } catch (_) { /* already granted */ }

      let albumCount = 0, trackCount = 0, totalImported = 0;
      const importedAlbums: Array<{ id: string; name: string }> = [];
      // Built once and reused: every album with no playlist matches its songs
      // against the same sweep of the artist's channel.
      let channelIndex: YtVideo[] | null = null;

      for (const pl of playlists) {
        if (totalImported >= MAX_TRACKS_PER_IMPORT) { log.push(`  ⚠ Track cap (${MAX_TRACKS_PER_IMPORT}) reached — skipping remaining albums`); break; }

        // No playlist id means YouTube has no playlist for this album and we
        // are going after its songs one at a time.
        const bySongs = !pl.id;
        const wantName = cleanAlbumName(pl.title, artist_name) || pl.title;
        const dup = await findExistingAlbum(artistId, wantName, bySongs ? null : pl.id);
        if (dup) {
          log.push(`  ↷ "${pl.title}" already imported as "${dup.name}" — skipped`);
          continue;
        }

        const detail: Record<string, any> = {};
        let capped: Array<{ videoId: string; position: number }> = [];
        let songBuilt: Array<{ videoId: string; position: number; title: string }> | null = null;

        if (bySongs) {
          if (channelIndex === null) {
            channelIndex = await ytArtistVideoIndex(channel_id, artist_name);
            if (channelIndex.length) log.push(`  · read ${channelIndex.length} videos off the artist's channels to match songs against`);
          }
          const built = await buildAlbumFromSongs(
            artist_name, { title: wantName, rg: pl.rg, release_date: pl.release_date },
            channelIndex, MAX_TRACKS_PER_IMPORT - totalImported,
          );
          if (!built.tracks.length) { log.push(`  ⚠ "${pl.title}" — ${built.reason}, skipped`); continue; }
          for (const k in built.detail) detail[k] = built.detail[k];
          songBuilt = built.tracks;
          capped = built.tracks;
          log.push(`    ↳ no playlist on YouTube, built song by song: ${built.tracks.length} of ${built.canonical} songs` +
            ` (${built.fromChannel} from the channel, ${built.fromSearch} from search)`);
          if (built.missing) log.push(`    ⚠ ${built.missing} song${built.missing === 1 ? '' : 's'} could not be found and were left out`);
        } else {
          const vids: Array<{ videoId: string; position: number }> = [];
          let pageToken = '';
          do {
            const d = await yt('playlistItems', {
              part: 'snippet,contentDetails', playlistId: pl.id as string, maxResults: '50',
              ...(pageToken ? { pageToken } : {}),
            });
            for (const it of (d.items || [])) {
              const vid = it.contentDetails?.videoId;
              const title = it.snippet?.title || '';
              if (!vid || title === 'Private video' || title === 'Deleted video') continue;
              vids.push({ videoId: vid, position: it.snippet?.position ?? vids.length });
            }
            pageToken = d.nextPageToken || '';
          } while (pageToken && vids.length < MAX_TRACKS_PER_PLAYLIST);

          capped = vids.slice(0, Math.min(MAX_TRACKS_PER_PLAYLIST, MAX_TRACKS_PER_IMPORT - totalImported));
          if (!capped.length) { log.push(`  ⚠ "${pl.title}" has no importable videos — skipped`); continue; }

          const detailIds = capped.map(v => v.videoId);
          for (let i = 0; i < detailIds.length; i += 50) {
            const d = await yt('videos', { part: 'statistics,snippet,contentDetails', id: detailIds.slice(i, i + 50).join(','), maxResults: '50' });
            for (const it of (d.items || [])) detail[it.id] = it;
          }
        }

        const ids = capped.map(v => v.videoId);
        const pubDates = ids.map(v => detail[v]?.snippet?.publishedAt).filter(Boolean).sort();
        const releaseDate = normDate(pl.release_date || undefined) || (pubDates.length ? pubDates[0].slice(0, 10) : null);
        const ytThumb = ids.map(v => detail[v]?.snippet?.thumbnails?.medium?.url).find(Boolean) || null;

        const albName = wantName;
        let thumb = ytThumb;
        if (!isManual) {
          const wikiThumb = await wikiAlbumThumbnail(pl.wiki_page, artist_name, albName);
          if (wikiThumb) {
            thumb = wikiThumb;
            log.push(`    ↳ cover from Wikipedia`);
          }
        }

        // A playlist is only a candidate-video pool. Full-artist imports must
        // prove every imported song against the canonical MusicBrainz list;
        // they never fall back to copying unknown playlist entries.
        let finalVids: Array<{ videoId: string; position: number }> = capped;
        const defaultTrackTitle = (videoId: string, idx: number) =>
          cleanTrackName(detail[videoId]?.snippet?.title || `Track ${idx + 1}`, artist_name);
        let trackTitle = defaultTrackTitle;
        if (songBuilt) {
          const built = songBuilt;
          trackTitle = (videoId: string, idx: number) => built.find(m => m.videoId === videoId)?.title || defaultTrackTitle(videoId, idx);
        }

        // A song-built album already IS the canonical tracklist — only playlist
        // imports need reconciling against it.
        const canonical = songBuilt ? null : await mbOfficialTracklist(artist_name, albName, pl.rg || null, yearOf(pl.release_date));
        if (!songBuilt && (!canonical || !canonical.length)) {
          if (!isManual) {
            log.push(`  ⚠ "${pl.title}" has no verified tracklist — skipped rather than importing an unverified playlist`);
            continue;
          }
          log.push(`  ⚠ "${pl.title}" has no verified tracklist; keeping only your explicitly selected playlist`);
        }
        if (canonical && canonical.length) {
          const used = new Set<number>();
          const usedVids = new Set<string>();
          const slots: Array<{ videoId: string; position: number; title: string } | null> = canonical.map(() => null);
          const isNonAlbum = (videoId: string) =>
            NONALBUM_TITLE_MARKERS.some(w => (detail[videoId]?.snippet?.title || '').toLowerCase().includes(w));

          // Pass 1 — match each official track to its exact title in the
          // playlist.  Do not take the first "close enough" title: different
          // albums often share short titles, and playlist order is not quality.
          canonical.forEach((ct, ci) => {
            let best = -1, bestScore = -Infinity;
            for (let i = 0; i < capped.length; i++) {
              if (used.has(i) || isNonAlbum(capped[i].videoId)) continue;
              const raw = detail[capped[i].videoId]?.snippet?.title || '';
              if (!isSameTrack(cleanTrackName(raw, artist_name), ct.title)) continue;
              const duration = iso8601ToMs(detail[capped[i].videoId]?.contentDetails?.duration);
              const durationPenalty = ct.lengthMs && duration ? Math.abs(duration - ct.lengthMs) : 0;
              if (ct.lengthMs && duration && durationPenalty > TRACK_DUR_TOL_MS) continue;
              const channel = detail[capped[i].videoId]?.snippet?.channelTitle || '';
              const views = parseInt(detail[capped[i].videoId]?.statistics?.viewCount || '0', 10);
              const score = Math.log10(views + 1) * 1000 - durationPenalty
                + (/-\s*topic$/i.test(channel) || norm(channel).includes(norm(artist_name)) ? 2500 : 0);
              if (score > bestScore) { bestScore = score; best = i; }
            }
            if (best !== -1) {
              used.add(best); usedVids.add(capped[best].videoId);
              slots[ci] = { ...capped[best], title: ct.title };
            }
          });

          // Pass 2 — official tracks the titles missed, matched to a leftover
          // playlist video whose length lines up. Catches tracks YouTube spells
          // differently (e.g. "Pts. 1-5" vs "Parts I-V").
          canonical.forEach((ct, ci) => {
            if (slots[ci] || !ct.lengthMs) return;
            let best = -1, bestDiff = TRACK_DUR_TOL_MS + 1;
            for (let i = 0; i < capped.length; i++) {
              if (used.has(i) || isNonAlbum(capped[i].videoId)) continue;
              const dur = iso8601ToMs(detail[capped[i].videoId]?.contentDetails?.duration);
              if (!dur) continue;
              const diff = Math.abs(dur - (ct.lengthMs as number));
              if (diff < bestDiff) { best = i; bestDiff = diff; }
            }
            if (best !== -1) { used.add(best); usedVids.add(capped[best].videoId); slots[ci] = { ...capped[best], title: ct.title }; }
          });

          // Pass 3 — still missing: search YouTube for a video of the right
          // length even though it never appeared in this playlist. Bounded so a
          // big gap can't drain the daily search quota (100 units each).
          let searchBudget = MAX_TRACK_SEARCHES;
          for (let ci = 0; ci < canonical.length; ci++) {
            const ct = canonical[ci];
            if (slots[ci] || !ct.lengthMs || searchBudget <= 0) continue;
            searchBudget--;
            const found = await ytFindTrackByLength(artist_name, ct.title, ct.lengthMs as number, usedVids);
            if (found) {
              detail[found.videoId] = found.detail;
              usedVids.add(found.videoId);
              slots[ci] = { videoId: found.videoId, position: 10000 + ci, title: ct.title };
            }
          }

          const matched = slots.filter(Boolean) as Array<{ videoId: string; position: number; title: string }>;
          const minVerified = Math.min(canonical.length, Math.max(3, Math.ceil(canonical.length * 0.4)));
          if (matched.length >= minVerified) {
            const skippedN = capped.length - used.size;
            if (skippedN > 0) log.push(`    ↷ skipped ${skippedN} non-album video${skippedN === 1 ? '' : 's'} not on the official tracklist`);
            const filledN = matched.filter(m => m.position >= 10000).length;
            if (filledN > 0) log.push(`    ↳ found ${filledN} missing track${filledN === 1 ? '' : 's'} by matching video length`);
            const missingN = canonical.length - matched.length;
            if (missingN > 0) log.push(`    ⚠ ${missingN} official track${missingN === 1 ? '' : 's'} could not be found and were left out`);
            finalVids = matched;
            trackTitle = (videoId: string, idx: number) => matched.find(m => m.videoId === videoId)?.title || defaultTrackTitle(videoId, idx);
          } else if (!isManual) {
            log.push(`  ⚠ "${pl.title}" only matched ${matched.length} of ${canonical.length} official tracks — skipped rather than importing playlist extras`);
            continue;
          } else {
            log.push(`  ⚠ "${pl.title}" only matched ${matched.length} of ${canonical.length} official tracks; keeping your explicitly selected playlist`);
          }
        }

        const [album] = await dbInsert('albums', {
          visibility,
          artist_id: artistId, name: albName, release_date: releaseDate,
          added_by: user.email, added_by_name: user.name, yt_playlist_id: pl.id || null, art_url: thumb, last_sync_id: runId,
        }, true);
        albumCount++;
        importedAlbums.push({ id: album.id, name: albName });

        const now = new Date().toISOString();
        const trackRows = finalVids.map((v, idx) => ({
          album_id: album.id,
          name: trackTitle(v.videoId, idx),
          track_number: idx + 1,
          disc_number: 1,
          duration_ms: iso8601ToMs(detail[v.videoId]?.contentDetails?.duration),
          explicit: false,
          yt_snapshot_enabled: true,
          last_sync_id: runId,
          visibility,
        }));
        const inserted = await dbInsert('tracks', trackRows, true);

        const metricRows: any[] = [];
        inserted.forEach((t: any, idx: number) => {
          const v = finalVids[idx];
          const d = detail[v.videoId];
          const base = {
            track_id: t.id, album_id: null, artist_id: null,
            metric_source: 'youtube', metric_date: now, metric_type: 'track',
            metric_value: null, metric_text_value: null,
          };
          metricRows.push(
            { ...base, metric_name: 'youtube_video_id',  metric_text_value: v.videoId },
            { ...base, metric_name: 'youtube_views',     metric_value: parseInt(d?.statistics?.viewCount || '0', 10) },
            { ...base, metric_name: 'youtube_likes',     metric_value: parseInt(d?.statistics?.likeCount || '0', 10) },
            { ...base, metric_name: 'youtube_thumbnail', metric_text_value: d?.snippet?.thumbnails?.medium?.url || '' },
            { ...base, metric_name: 'youtube_title',     metric_text_value: d?.snippet?.title || '' },
            { ...base, metric_name: 'youtube_channel',   metric_text_value: d?.snippet?.channelTitle || '' },
          );
        });
        for (let i = 0; i < metricRows.length; i += 100) {
          await dbInsert('metrics', metricRows.slice(i, i + 100));
        }

        const videoRows = inserted.map((t: any, idx: number) => {
          const v = finalVids[idx];
          const d = detail[v.videoId];
          const channel = d?.snippet?.channelTitle || '';
          return {
            track_id: t.id,
            video_id: v.videoId,
            title: d?.snippet?.title || trackTitle(v.videoId, idx),
            channel,
            thumbnail: d?.snippet?.thumbnails?.medium?.url || `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
            view_count: parseInt(d?.statistics?.viewCount || '0', 10),
            like_count: parseInt(d?.statistics?.likeCount || '0', 10),
            is_primary: true,
            source: 'sync',
            label: /- topic$/i.test(channel) ? 'Original Audio' : null,
            counts_for_charts: true,
          };
        });
        for (let i = 0; i < videoRows.length; i += 100) {
          await dbInsert('track_videos', videoRows.slice(i, i + 100), true);
        }

        trackCount += inserted.length;
        totalImported += inserted.length;
        log.push(`  ✓ "${albName}" — ${inserted.length} tracks`);
      }

      await dbPatch(`/sync_runs?id=eq.${runId}`, { album_count: albumCount, track_count: trackCount });
      log.push(`✓ Done — ${albumCount} albums · ${trackCount} tracks. Daily view tracking starts tonight.`);
      return json({ success: true, artist_id: artistId, albums: albumCount, tracks: trackCount, albums_detail: importedAlbums, log });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});
