// @suite Artist uploaded discovery
// @area Artists
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHtmlFnsInScope, loadTs } from './_load.mjs';

test('artist upload discovery excludes personal files and includes group members', () => {
  const scope={_artistUploadedArtistIds:new Set(['artist']),_artistUploadedTrackIds:new Set(['original']),artistUploadedOnly:true,isLandingMode:true,landingTab:'explore',_homeLibLoaded:true,_homeLibError:false};
  const fns=loadHtmlFnsInScope(['sjArtistUploadedOn','filterArtistUploadedTracks','filterArtistUploadedSearch'],scope);
  assert.equal(fns.sjArtistUploadedOn({artist_id:'artist'}),true);
  assert.equal(fns.sjArtistUploadedOn({artist_id:'group',member_ids:['artist']}),true);
  assert.equal(fns.sjArtistUploadedOn({artist_id:'personal-owner'}),false);
  const rows=[{id:'original'},{id:'private-upload'},{id:'youtube'}];
  assert.deepEqual(fns.filterArtistUploadedTracks(rows),[rows[0]]);
  scope.landingTab='playlists';
  assert.deepEqual(fns.filterArtistUploadedTracks(rows),rows);
  scope.landingTab='songs';scope._homeLibError=true;
  assert.deepEqual(fns.filterArtistUploadedTracks(rows),rows);
  const data={tracks:[{track:{id:'original',album_id:'release'}},{track:{id:'youtube',album_id:'import'}}],artists:[{id:'artist'},{id:'importer'}],albums:[{id:'release'},{id:'import'}]};
  const filtered=fns.filterArtistUploadedSearch(data);
  assert.deepEqual(filtered.tracks,[data.tracks[0]]);
  assert.deepEqual(filtered.artists,[data.artists[0]]);
  assert.deepEqual(filtered.albums,[data.albums[0]]);
});

test('guide links appear at the top only on Home, including artist and queue transitions', () => {
  const top={hidden:true};
  const scope={document:{getElementById:()=>top},isLandingMode:true,landingTab:'home',viewMode:'timeline'};
  const {syncAudienceGuideLinks}=loadHtmlFnsInScope(['syncAudienceGuideLinks'],scope);
  syncAudienceGuideLinks();assert.equal(top.hidden,false);
  scope.landingTab='explore';syncAudienceGuideLinks();assert.equal(top.hidden,true);
  scope.landingTab='home';scope.isLandingMode=false;syncAudienceGuideLinks();assert.equal(top.hidden,true);
  scope.isLandingMode=true;scope.viewMode='playlistchart';syncAudienceGuideLinks();assert.equal(top.hidden,true);
});

test('availability identifies public artist uploads separately from private background files', async () => {
  const sb={schema:()=>({from:table=>{
    const q={select:()=>q,in:()=>q,eq:()=>q,then:resolve=>Promise.resolve({data:table==='track_audio'?[{track_id:'personal'}]:table==='tracks'?[{album_id:'album'}]:[{artist_id:'artist'}],error:null}).then(resolve)};return q;
  }})};
  const route=loadTs('src/app/api/sj-bg-available/route.ts',{
    'next/server':{NextResponse:{json:(body,options)=>Response.json(body,options)}},
    'sj-admin-auth':{getAuthUser:async()=>({id:'listener'}),createSjServiceClient:()=>sb,JUKEBOX_SCHEMA:'jukebox'},
    'bg-audio-eligibility':{approvedArtistAudioTracks:async()=>[{track_id:'approved'}],onDemandArtistAudioTracks:async()=>[{track_id:'original',artist_id:'artist'}]},
    'artist-rights':{ARTIST_AGREEMENT_VERSION:'current'},
  });
  const response=await route.GET({});const body=await response.json();
  assert.deepEqual(body.trackIds,['personal','approved']);
  assert.deepEqual(body.artistUploadedTrackIds,['original']);
  assert.deepEqual(body.artistUploadedArtistIds,['artist']);
  assert.equal(response.headers.get('Cache-Control'),'private, no-store');
});
