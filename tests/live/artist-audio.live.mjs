// Live check that every artist upload the public catalogue shows actually
// plays, on both brands. The same check runs nightly on the server
// (/api/sj-artist-audio-health, pg_cron jukebox-artist-audio-health) and
// emails on failure; this is the by-hand version.
//
// Nouns Group uploaded their record for distribution and it broke over and
// over, each time in a way the database could not see. So this reads the
// catalogue as an anonymous visitor, then asks each site for the first bytes
// of each song, the way the player's <audio> element does.
//
//     npm run test:live
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTs } from '../_load.mjs';

const SUPABASE_URL = 'https://ntyvtpimesfoesuykuyi.supabase.co';
const ANON = readFileSync(new URL('../../src/lib/sj-admin-auth.ts', import.meta.url), 'utf8')
  .match(/SJ_SUPABASE_ANON_KEY\s*=\s*"([^"]+)"/)[1];
const HOSTS = (process.env.SJ_ARTIST_AUDIO_HOSTS
  || 'https://www.sufferingjukebox.stream,https://listeningparty.stream').split(',');

const health = loadTs('src/lib/artist-audio-health.ts', { 'sj-admin-auth': { JUKEBOX_SCHEMA: 'jukebox' } });

// Just enough of a Supabase client for publicArtistAudioSongs, over anon REST.
function anonDb() {
  const from = (table) => {
    const params = new URLSearchParams();
    const q = {
      select: (cols) => { params.set('select', cols); return q; },
      eq: (k, v) => { params.append(k, 'eq.' + v); return q; },
      in: (k, vs) => { params.append(k, 'in.(' + vs.join(',') + ')'); return q; },
      then: (res, rej) => fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
        headers: { apikey: ANON, Authorization: 'Bearer ' + ANON, 'Accept-Profile': 'jukebox' },
      }).then(async r => r.ok ? { data: await r.json(), error: null } : { data: null, error: new Error(`${table}: ${r.status}`) })
        .then(res, rej),
    };
    return q;
  };
  return { schema: () => ({ from }) };
}

test('every public artist upload plays from every site', async () => {
  const songs = await health.publicArtistAudioSongs(anonDb());
  assert.ok(songs.length > 0, 'the catalogue lists no artist uploads at all - Nouns Group should be there');
  assert.ok(songs.some(s => s.artist === 'Nouns Group'), 'Nouns Group has dropped out of the public catalogue');
  const report = await health.checkArtistAudio(songs, HOSTS);
  const lines = report.failures.map(f => `  ${f.artist} - ${f.track} on ${f.host}: ${f.reason}`);
  assert.equal(report.failures.length, 0, `${report.failures.length} of ${report.checks} failed:\n${lines.join('\n')}`);
});
