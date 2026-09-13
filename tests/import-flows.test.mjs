import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const screenshotRoute = readFileSync(
  new URL("../src/app/api/import/screenshot/route.ts", import.meta.url),
  "utf8",
);

test("screenshot reader distinguishes songs from music-app collections", () => {
  for (const label of ["Mix", "Song mix", "Radio", "Supermix", "Playlist", "Album", "Podcast"]) {
    assert.match(screenshotRoute, new RegExp(`\\"${label}\\"`));
  }
  assert.match(screenshotRoute, /Song • Artist/);
  assert.match(screenshotRoute, /now-playing bar is a real song row/);
});

test("artist import has two choices and optional post-import fine-tuning", () => {
  const modal = html.slice(html.indexOf("<!-- ADD MUSIC MODAL"), html.indexOf("<!-- Add music (adm*)"));
  assert.equal((modal.match(/class="am-step"/g) || []).length, 2);
  assert.match(modal, /id="amVisibilitySelect"/);
  assert.match(modal, /id="amFineTuneBtn"[^>]*>Fine-tune \(optional\)/);

  const importFlow = html.slice(html.indexOf("async function amImport()"), html.indexOf("// ResizeObserver"));
  assert.match(importFlow, /amStepDone\(`/);
  assert.match(importFlow, /amSetPostImportFooter\(\)/);
  assert.doesNotMatch(importFlow, /await amGoFinetune\(\)/);
});

test("Add music save counts new songs and cleans up an incomplete new playlist", () => {
  const save = html.slice(html.indexOf("async function admSave()"), html.indexOf("// ── Sign-in"));
  assert.match(save, /let imported = 0/);
  assert.match(save, /admPlural\(imported, 'song'\)/);
  assert.match(save, /dbDelete\('\/playlists\?id=eq\.'/);
});
