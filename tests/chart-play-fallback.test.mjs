// @suite Chart play-count fallback
// @area Charts, Listening Party mobile
// @covers YouTube/In-App metric selection and mobile grid/song controls
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardHtml, loadHtmlFnsInScope } from './_load.mjs';

function chartScope(extra = {}) {
  const scope = {
    ytData: {},
    inAppPlays: {},
    tracks: {},
    barChartMode: 'yt',
    ddItemById: () => null,
    myInAppPlays: {},
    trackVoteScores: {},
    ...extra,
  };
  const fns = loadHtmlFnsInScope([
    'sjChartPlayMetric', 'sjChartPlayValue', 'sjChartPlayLabel',
    'albumChartPlayLabel', 'albumViews', 'landingChartPlayMetric',
  ], scope);
  Object.assign(scope, fns);
  return { scope, ...fns };
}

test('artist-uploaded songs use In-App Plays when YouTube is unavailable', () => {
  const { sjChartPlayMetric } = chartScope({ inAppPlays: { upload: 27 } });
  assert.deepEqual(sjChartPlayMetric('upload'), {
    value: 27, source: 'inapp', label: 'In-App Plays',
  });
});

test('a real YouTube version keeps its YouTube count, including a legitimate zero', () => {
  const { sjChartPlayMetric } = chartScope({
    ytData: { video: { video_id: 'abc', views: 0 } },
    inAppPlays: { video: 19 },
  });
  assert.deepEqual(sjChartPlayMetric('video'), {
    value: 0, source: 'youtube', label: 'YouTube Views',
  });
});

test('album charts combine YouTube counts with upload In-App Plays and label the mix', () => {
  const album = { id: 'album', artist_id: 'artist' };
  const { albumViews, albumChartPlayLabel } = chartScope({
    ytData: { youtube: { video_id: 'abc', views: 100 } },
    inAppPlays: { upload: 7 },
    tracks: { artist: [
      { id: 'youtube', album_id: 'album' },
      { id: 'upload', album_id: 'album', artist_audio_only: true },
    ] },
  });
  assert.equal(albumViews(album), 107);
  assert.equal(albumChartPlayLabel(album, false), 'YouTube + In-App Plays');
});

test('artist cards fall back from an unavailable YouTube total', () => {
  const { landingChartPlayMetric } = chartScope();
  assert.deepEqual(landingChartPlayMetric({ total_views: 0, total_plays: 14 }), {
    value: 14, label: 'In-App Plays',
  });
});

test('mobile Artist and Playlist cards share a one-to-three-column pinch zoom', () => {
  assert.doesNotMatch(dashboardHtml, /html\[data-surface="lp"\]\.has-phone-tabbar \.landing-grid/);
  assert.match(dashboardHtml, /\.landing-grid\.detail-name \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  assert.match(dashboardHtml, /\.landing-grid\.detail-yt\s+\{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(dashboardHtml, /\.playlist-explore-grid\.pl-size-sm \{ grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(dashboardHtml, /\.playlist-explore-grid\.pl-size-lg \{ grid-template-columns:repeat\(1,minmax\(0,1fr\)\)/);
  assert.match(dashboardHtml, /function setLandingDetailIdx\(i\) \{ setExploreCardZoomIdx\(i\); \}/);
  assert.match(dashboardHtml, /function setPlaylistCardSizeIdx\(i\) \{ setExploreCardZoomIdx\(i\); \}/);
  assert.match(dashboardHtml, /function sjBindExploreCardPinch\(\)[\s\S]*?\.landing-grid, \.playlist-explore-grid/);
  const { sjExplorePinchZoomIdx } = loadHtmlFnsInScope(['sjExplorePinchZoomIdx'], { SJ_PL_SIZES: ['sm', 'md', 'lg'] });
  assert.equal(sjExplorePinchZoomIdx(1, 100, 160), 2);
  assert.equal(sjExplorePinchZoomIdx(1, 100, 60), 0);
  assert.equal(sjExplorePinchZoomIdx(2, 100, 200), 2);
});

test('Songs has mobile Play buttons', () => {
  assert.match(dashboardHtml, /class="tt-row-play"[^>]*onclick="ttPlayTrack\('\$\{t\.id\}',event\)"[^>]*>Play<\/button>/);
  assert.match(dashboardHtml, /grid-template-areas: "name name play more" "artist album play more"/);
});
