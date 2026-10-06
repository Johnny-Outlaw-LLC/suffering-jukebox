// @suite Song menu and artist artwork
// @area Playback
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHtmlFnsInScope } from './_load.mjs';

function metaScope() {
  return {
    tracks: {}, albums: {}, allArtists: [], ytData: {}, ALBUM_ART: {},
    SJ_BRAND: { icon: '/favicon.png' },
    SJ_TRACK_META: { song: { artist: 'Nouns Group', album: 'Record', artwork: '/favicon.png' } },
    ytQueue: [{ trackId: 'song', title: 'Ignorance Is Not Innocence', artistAudio: true, artwork: '/favicon.png' }],
    ytQueueIdx: 0, nowPlayingTrackId: 'song', ytVideoId: null,
    albumThumb: a => a.art_url,
  };
}

test('placeholder artwork does not mask a restored album cover', () => {
  const scope = metaScope();
  scope.ALBUM_ART.Record = 'https://example.com/nouns.jpg';
  const { ytpTrackMeta } = loadHtmlFnsInScope(['ytpTrackMeta'], scope);
  assert.equal(ytpTrackMeta('song').artwork, scope.ALBUM_ART.Record);
  delete scope.ALBUM_ART.Record;
  scope.ytQueue[0].artwork = 'https://example.com/queue-cover.jpg';
  assert.equal(ytpTrackMeta('song').artwork, scope.ytQueue[0].artwork);
});

for (const [active, artFrame] of [[true, true], [false, true], [true, false]]) {
  test(`late artist metadata refreshes only the active cover (active=${active}, artFrame=${artFrame})`, async () => {
    const painted = [];
    const scope = {
      ...metaScope(), _ytpMetaFetch: {}, _ytUserWantsPlay: false,
      ytPlayerEl: { querySelector: () => artFrame ? {} : null },
      ytpApplyTitle() {}, ytpUpdateMiniFooter() {},
      ytpShowArtFrame: art => painted.push(art),
      dbGet: async path => path.startsWith('/tracks')
        ? [{ id: 'song', name: 'Ignorance Is Not Innocence', album_id: 'record', artist_audio_only: true }]
        : path.startsWith('/albums')
          ? [{ id: 'record', name: 'Record', artist_id: 'nouns', art_url: 'https://example.com/nouns.jpg' }]
          : [{ id: 'nouns', name: 'Nouns Group' }],
    };
    if (!active) scope.nowPlayingTrackId = 'another-song';
    const fns = loadHtmlFnsInScope(['ytpTrackMeta', 'ytpStampQueueMeta', 'ytpEnsureTrackMeta'], scope);
    await fns.ytpEnsureTrackMeta('song');
    assert.equal(scope.ytQueue[0].artwork, 'https://example.com/nouns.jpg');
    assert.deepEqual(painted, active && artFrame ? ['https://example.com/nouns.jpg'] : []);
  });
}

for (const state of ['none', 'downloading', 'done']) {
  test(`available audio has no CarPlay download offer (${state})`, () => {
    const menu = {};
    const scope = {
      document: { getElementById: () => menu }, _sjmTrackId: 'song', _sjmQueueIdx: -1,
      ytQueue: [{ trackId: 'song' }], ytQueueIdx: 0, ytData: {}, googleUser: null,
      SJ_BRAND: { features: {} }, _queueSourcePlaylistId: null, playlistChartId: null,
      findTrackById: () => ({}), isTrackBlocked: () => false,
      _sjmArtistFor: () => null, sjmCloseSubmenu() {}, sjmPosition() {},
      ytpTrackMeta: () => ({ title: 'Song' }), _sjmHeader: () => '', sjmPlayerSectionHTML: () => '',
      sjIsNative: () => true, sjDlPlugin: () => ({}), sjDlState: () => state,
      taTrackAudio: () => ({ url: 'uploaded-audio' }), taIsMobileDevice: () => true,
      ugcReportablePlaylist: () => false,
    };
    const { sjmRenderRoot } = loadHtmlFnsInScope(['sjmRenderRoot'], scope);
    sjmRenderRoot();
    assert.doesNotMatch(menu.innerHTML, /Download for CarPlay/);
    assert.equal(menu.innerHTML.includes('Remove download'), state === 'done');
    assert.equal(menu.innerHTML.includes('Downloading...'), state === 'downloading');
  });
}
