// @suite Native product identities
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {loadHtmlFnsInScope} from '../../tests/_load.mjs';
const native=new URL('../',import.meta.url);
execFileSync(process.execPath,['scripts/build-web.mjs','rk'],{cwd:native,stdio:'pipe'});
const read=p=>readFileSync(new URL(p,native),'utf8');
function readSurface(html) {
    const source=html.match(/<script>window\.__SURFACE__=[\s\S]*?<\/script>/)?.[0];
    assert.ok(source,'server surface stamp exists in native assets');
    const scope={window:{},document:{documentElement:{setAttribute(){}}}};
    vm.runInNewContext(source.replace(/^<script>|<\/script>$/g,''),scope);
    return scope.window.__SURFACE__;
}
test('bundled Record Keeper uses its canonical surface and native flag',()=>{
    const html=read('recordkeeper/www/index.html');
    const surface=readSurface(html);
    assert.equal(surface.id,'rk');
    assert.equal(surface.url,'https://recordkeeper.stream');
    assert.equal(surface.features.spotifyPlayback,false);
    assert.match(html,/window\.__SJ_NATIVE__=true/);
    assert.match(html,/<title>Record Keeper/);
});

test('Suffering Jukebox opens the shared Silver Jews and Purple Mountains discography', async () => {
    execFileSync(process.execPath, ['scripts/build-web.mjs', 'sj'], {cwd: native, stdio: 'pipe'});
    const html = read('products/suffering-jukebox/www/index.html');
    const surface = readSurface(html);
    const recordKeeper = readSurface(read('recordkeeper/www/index.html'));
    assert.equal(surface.id, 'sj');
    assert.equal(surface.name, 'Suffering Jukebox');
    assert.equal(surface.url, 'https://www.sufferingjukebox.stream');
    assert.equal(surface.features.homeArtist, 'silver-jews');
    for (const key of ['homeTab', 'phoneMiniPlayer', 'artistUpload', 'liveStations', 'spotifyImport', 'spotifyPlayback']) {
        assert.equal(surface.features[key], recordKeeper.features[key], key);
    }
    assert.match(html, /window\.__SJ_NATIVE__=true/);

    const silverJews = {id: 'sj', name: 'Silver Jews', slug: 'silver-jews', is_community: false};
    const purpleMountains = {id: 'pm', name: 'Purple Mountains', slug: 'purple-mountains', is_community: false};
    const pavement = {id: 'pv', name: 'Pavement', slug: 'pavement', is_community: true};
    let artistPageLoaded = false;
    const scope = {
        SJ_BRAND: surface, IS_COMMUNITY: false, FEATURED_ARTIST_ID: null,
        _SONG_PAGE: null, _PLAYLIST_PAGE: null, _SLUG_ARTIST: null,
        window: {location: new URL('capacitor://www.sufferingjukebox.stream/')},
        history: {replaceState: () => {}}, URLSearchParams,
        dbGet: async path => path.includes('slug=eq.silver-jews') ? [silverJews] : [],
        loadArtistPageData: async () => { artistPageLoaded = true; },
    };
    const {sjHomeArtistSlug, shouldOpenHomeArtistOnBoot, openHomeArtistOnBoot, filterPageArtists} =
        loadHtmlFnsInScope(['sjHomeArtistSlug', 'shouldOpenHomeArtistOnBoot', 'openHomeArtistOnBoot', 'filterPageArtists'], scope);
    assert.equal(sjHomeArtistSlug(), 'silver-jews');
    assert.equal(shouldOpenHomeArtistOnBoot(), true);
    assert.equal(await openHomeArtistOnBoot(), true);
    assert.equal(artistPageLoaded, true);
    assert.deepEqual(filterPageArtists([silverJews, purpleMountains, pavement]), [silverJews, purpleMountains]);
});
test('both new store products have a separate Record Keeper application identity',()=>{
    const config=JSON.parse(read('recordkeeper/capacitor.config.json'));
    assert.equal(config.appId,'com.johnnyoutlaw.recordkeeper');
    assert.equal(config.server.hostname,'app.recordkeeper.stream');
    assert.match(read('recordkeeper/ios/App/App/Info.plist'),/<string>Record Keeper<\/string>/);
    assert.match(read('recordkeeper/ios/App/App.xcodeproj/project.pbxproj'),/PRODUCT_BUNDLE_IDENTIFIER = com\.johnnyoutlaw\.recordkeeper/);
    assert.equal(JSON.parse(read('capacitor.config.json')).appName,'Listening Party');
});
