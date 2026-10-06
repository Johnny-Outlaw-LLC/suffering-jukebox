// @suite Explore playback and native hearts
// @area Playback
// @covers collection Play All/Shuffle All and native reaction persistence
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHtmlFnsInScope } from './_load.mjs';

for (const kind of ['artist', 'playlist']) {
  for (const n of [1, 2]) test(`${kind} menu offers ordered play and only shuffles multiple songs (${n})`, () => {
    const menu = { innerHTML: '' };
    const scope = { document: { getElementById: () => menu }, googleUser: null,
      _sjmHeader: () => '', YTP_DECK_ICONS: {}, playlistIdCanShare: () => false,
      oaIsMine: () => false, _lamFavIds: [], _lamOnPage: false, sjmArtistHasDiscography: () => false,
      lamCanManage: () => false };
    const { lamRender, plmRender } = loadHtmlFnsInScope(['lamRender', 'plmRender'], scope);
    if (kind === 'artist') lamRender({ name: 'Artist', track_count: n });
    else plmRender({ id: 'playlist', _tracks: Array(n).fill('track') });
    assert.ok(menu.innerHTML.includes('Play All'));
    assert.equal(menu.innerHTML.includes('Shuffle All'), n > 1);
    if (n > 1) assert.ok(menu.innerHTML.indexOf('Play All') < menu.innerHTML.indexOf('Shuffle All'));
    assert.match(menu.innerHTML, kind === 'artist' ? /lamPlayAll\(false\)/ : /plmStart\(false\)/);
  });
}

test('playlist Play All preserves order and disables shuffle', async () => {
  let played;
  const scope = { document: { getElementById: () => null }, homeJukeboxBgFilterOn: () => false,
    playlistExploreTrackIds: () => ['a','b'], resolvePlaylistTracks: async () => ({a:{videoId:'va'},b:{videoId:'vb'}}),
    playlistQueueItem: (id) => ({trackId:id}), isTrackSkipped: () => false, filterQueueForHomeBg: q => q,
    landingPlayQueue: async (q,opts) => {played={q,opts};}, loadTrackAudio: async () => {}, taSyncAudioBtn() {}, console };
  const { playlistsShuffleAll } = loadHtmlFnsInScope(['playlistsShuffleAll'],scope);
  await playlistsShuffleAll(false);
  assert.deepEqual(played, {q:[{trackId:'a'},{trackId:'b'}],opts:{shuffle:false}});
});

function reactionScope(fail = false) {
  const requests = [], toasts = [];
  const scope = { SJ_REACTION_TYPES: [{key:'heart',icon:'heart'}], trackReactionCounts: {},
    sessionTrackReactions: {}, myReactionTrackIds: [], _myHeartCounts: {}, _myHeartCountsToday: {},
    refreshTrackReactionUI() {}, sjBumpTrackVoteScore() {}, ytpReactionBurst() {}, ytpPushReactionTimeline() {},
    isLandingMode: false, getDeviceId: () => 'device', showToast: msg => toasts.push(msg),
    sjAuthHeaders: async () => ({Authorization:'test-token'}), sjApiUrl: p => 'https://recordkeeper.stream'+p,
    sjIsNative: () => true, SJ_FETCH_TIMEOUT_MS: 45000,
    window: {Capacitor:{Plugins:{CapacitorHttp:{request: async req => {
      requests.push(req); return {status:fail ? 500 : 200,data:fail ? {ok:false,error:'Could not save reaction.'} : {ok:true,reaction_id:'saved',counts:{heart:1}}};
    }}}}}, sjFetch: () => {throw Error('native reaction used browser transport');} };
  return {scope,requests,toasts};
}

test('a native heart uses URLSession and retains the confirmed reaction', async () => {
  const {scope,requests,toasts}=reactionScope();
  const {ytpSendReaction}=loadHtmlFnsInScope(['sjApiJson','ytpSendReaction'],scope);
  assert.equal(await ytpSendReaction('track','heart',33000,null),true);
  assert.equal(requests[0].method,'POST');
  assert.equal(requests[0].data.track_id,'track');
  assert.equal(requests[0].data.position_ms,33000);
  assert.deepEqual(scope.myReactionTrackIds,['track']);
  assert.deepEqual(scope.sessionTrackReactions.track.heart,['saved']);
  assert.deepEqual(toasts,[]);
});

test('a rejected native heart rolls back its optimistic count', async () => {
  const {scope,toasts}=reactionScope(true);
  const {ytpSendReaction}=loadHtmlFnsInScope(['sjApiJson','ytpSendReaction'],scope);
  assert.equal(await ytpSendReaction('track','heart',33000,null),false);
  assert.equal(scope.trackReactionCounts.track.heart,0);
  assert.deepEqual(scope.myReactionTrackIds,[]);
  assert.deepEqual(toasts,['Could not save reaction.']);
});
