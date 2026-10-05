// Live check that artist uploads actually play, on both brands.
//
// Nouns Group uploaded their record for distribution, and it broke over and
// over: a signed link that expired in an open tab, Listening Party's missing B2
// keys, a cross-site redirect the browser refused. Every one of those looked
// fine in the database. This asks the real site for real bytes, the same way
// the player's <audio> element does: follow the stream redirect and fetch the
// first two bytes of the file.
//
//     npm run test:live
import { test } from 'node:test';
import assert from 'node:assert/strict';

// "All My Daughters Are Named After Wars", Nouns Group EP.
const TRACK = '35b72bce-0052-4d01-a4b8-b623b36630d1';
const HOSTS = (process.env.SJ_ARTIST_AUDIO_HOSTS
  || 'https://www.sufferingjukebox.stream,https://listeningparty.stream').split(',');

for (const host of HOSTS) {
  test(`artist audio streams from ${host}`, async () => {
    const url = `${host}/api/sj-artist-audio?purpose=normal-playback&format=stream&track_ids=${TRACK}`;
    const r = await fetch(url, { headers: { Range: 'bytes=0-1' }, redirect: 'follow' });
    assert.ok(r.status === 206 || r.status === 200, `${url} answered ${r.status}`);
    assert.match(r.headers.get('content-type') || '', /audio|octet-stream|mp4/);
    assert.ok((await r.arrayBuffer()).byteLength > 0, 'no audio bytes came back');
  });

  test(`artist audio lookup answers from ${host}`, async () => {
    const r = await fetch(`${host}/api/sj-artist-audio?purpose=normal-playback&track_ids=${TRACK}`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.tracks?.[0]?.trackId, TRACK);
  });
}
