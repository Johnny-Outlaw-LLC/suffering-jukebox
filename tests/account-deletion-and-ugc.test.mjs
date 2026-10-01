import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadHtmlFnsInScope, readRepoFile } from './_load.mjs';

// App Store Review requires in-app account deletion (5.1.1(v)) and, for
// content other people make, a way to report it and block whoever made it
// (1.2). These guard the pieces a reviewer is shown.

const html = readRepoFile('public/index.html');
const migration = readRepoFile('supabase/migrations/20261001170000_account_deletion_and_ugc_safety.sql');
const accountRoute = readRepoFile('src/app/api/sj-account/route.ts');
const ugcRoute = readRepoFile('src/app/api/sj-ugc/route.ts');
const shareRoute = readRepoFile('src/app/api/playlist-share/route.ts');

test('Settings has Delete account and Blocked people on the Profile pane', () => {
  const profile = html.slice(html.indexOf('data-set-pane="profile"'), html.indexOf('data-set-pane="privacy"'));
  assert.match(profile, /onclick="sjDeleteAccount\(\)"/);
  assert.match(profile, /id="set-blocked-list"/);
  assert.match(html, /if \(section === 'profile'\) settingsPaintBlocked\(\);/);
});

test('account deletion keeps the shared sign-in and the owner account', () => {
  // auth.users is shared by every Outlaw Apps product; deleting it would
  // delete the person's accounts elsewhere too.
  assert.doesNotMatch(accountRoute, /auth\.admin\.deleteUser/);
  assert.match(accountRoute, /rpc\("delete_account_data"/);
  assert.match(accountRoute, /SJ_PROTECTED_ADMIN_EMAIL/);
  assert.match(migration, /revoke all on function jukebox\.delete_account_data\(uuid, text\) from public, anon, authenticated;/);
});

test('report and block act on the playlist owner the server looks up', () => {
  assert.match(ugcRoute, /from\("playlists"\)\.select\("id,name,user_email"\)/);
  assert.doesNotMatch(ugcRoute, /body\?\.(email|ownerEmail|reportedEmail)/);
  assert.match(shareRoute, /from\("user_blocks"\)/);
  assert.match(shareRoute, /!blocked\.has\(cleanEmail\(row\.user_email\)\)/);
});

test('Report / Block is offered only on somebody else\'s saved playlist', () => {
  const scope = {
    googleUser: { email: 'me@example.com' },
    _savedPlaylists: [
      { id: 'a', user_email: 'them@example.com' },
      { id: 'b', user_email: 'me@example.com' },
      { id: 'c', user_email: null },
    ],
  };
  const { ugcReportablePlaylist } = loadHtmlFnsInScope(['ugcReportablePlaylist'], scope);
  assert.equal(ugcReportablePlaylist('a'), true);
  assert.equal(ugcReportablePlaylist('b'), false);
  assert.equal(ugcReportablePlaylist('c'), false);
  assert.equal(ugcReportablePlaylist('__dynamic_now_playing'), false);
  assert.equal(ugcReportablePlaylist('missing'), false);
  assert.match(html, /\$\{settingsBtn\}\$\{reportBtn\}<\/div>/);
});
