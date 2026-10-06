// @suite Native product identities
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
const native=new URL('../',import.meta.url);
execFileSync(process.execPath,['scripts/build-web.mjs','rk'],{cwd:native,stdio:'pipe'});
const read=p=>readFileSync(new URL(p,native),'utf8');
test('bundled Record Keeper uses its canonical surface and native flag',()=>{
    const html=read('recordkeeper/www/index.html');
    const source=html.match(/<script>window\.__SURFACE__=[\s\S]*?<\/script>/)?.[0];
    assert.ok(source,'server surface stamp exists in native assets');
    const scope={window:{},document:{documentElement:{setAttribute(){}}}};
    vm.runInNewContext(source.replace(/^<script>|<\/script>$/g,''),scope);
    assert.equal(scope.window.__SURFACE__.id,'rk');
    assert.equal(scope.window.__SURFACE__.url,'https://recordkeeper.stream');
    assert.equal(scope.window.__SURFACE__.features.spotifyPlayback,false);
    assert.match(html,/window\.__SJ_NATIVE__=true/);
    assert.match(html,/<title>Record Keeper/);
});
test('both new store products have a separate Record Keeper application identity',()=>{
    const config=JSON.parse(read('recordkeeper/capacitor.config.json'));
    assert.equal(config.appId,'com.johnnyoutlaw.recordkeeper');
    assert.equal(config.server.hostname,'app.recordkeeper.stream');
    assert.match(read('recordkeeper/ios/App/App/Info.plist'),/<string>Record Keeper<\/string>/);
    assert.match(read('recordkeeper/ios/App/App.xcodeproj/project.pbxproj'),/PRODUCT_BUNDLE_IDENTIFIER = com\.johnnyoutlaw\.recordkeeper/);
    assert.equal(JSON.parse(read('capacitor.config.json')).appName,'Listening Party');
});
