import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardHtml } from './_load.mjs';

test('mobile playlist browsing gives albums a readable three-column layout', () => {
  assert.match(dashboardHtml, /#admOverlay \.plb-results \{ max-height:min\(52dvh,560px\)/);
  assert.match(dashboardHtml, /grid-template-areas:"art info caret" "art views caret" "art add caret"/);
  assert.match(dashboardHtml, /#admOverlay \.list-album-row \.list-name[\s\S]{0,220}white-space:normal/);
});

test('nested albums do not lose the phone width to desktop indentation', () => {
  assert.match(dashboardHtml, /#admOverlay \.plb-nest \{ padding-left:6px; margin:4px 0 8px 6px; \}/);
  assert.match(dashboardHtml, /#admOverlay \.plb-add \{ min-height:34px;/);
});
