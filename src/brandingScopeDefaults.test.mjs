import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { MESSAGE_CATALOG } from './locale/index.js';
import {
  SCOPE_MASK_ENABLED_DEFAULT,
  _resetScopeMaskForTest,
  isScopeMaskEnabled,
  setScopeMaskEnabled,
} from './scopeMask.js';
import { ShareLinkManager } from './sharelink.js';

const indexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function managerForHash(hash = '') {
  globalThis.window = { location: { hash, href: `http://localhost/${hash}` } };
  globalThis.history = {
    replaceState(_state, _title, nextHash) {
      window.location.hash = nextHash;
    },
  };
  return new ShareLinkManager({
    camera: {
      changed: { addEventListener() {} },
      positionCartographic: { latitude: 0, longitude: 0, height: 1000 },
      heading: 0,
      pitch: -Math.PI / 2,
      roll: 0,
    },
  });
}

test('Chinese product identity is 情报视图 while English identity stays intact', () => {
  assert.equal(MESSAGE_CATALOG['zh-CN']['app.title'], '情报视图');
  assert.equal(MESSAGE_CATALOG['zh-CN']['app.view'], '视图');
  assert.equal(MESSAGE_CATALOG.en['app.title'], "GOD'S EYE VIEW");
  assert.equal(MESSAGE_CATALOG.en['app.view'], 'VIEW');

  assert.equal((indexHtml.match(/data-i18n="app\.title"/g) || []).length, 3,
    'the browser title, title bar, and loading surface must share one identity key');
  assert.match(indexHtml, /<title[^>]*data-i18n="app\.title"/);
  assert.match(indexHtml, /<h1>[\s\S]*?data-i18n="app\.title"[\s\S]*?<\/h1>/);
  assert.match(indexHtml, /<h2>[\s\S]*?data-i18n="app\.title"[\s\S]*?<\/h2>/);
});

test('a fresh scope state is disabled and the control markup reflects that state', () => {
  assert.equal(SCOPE_MASK_ENABLED_DEFAULT, false);
  _resetScopeMaskForTest();
  assert.equal(isScopeMaskEnabled(), false);
  const toggleTag = indexHtml.match(/<button[^>]*id="scope-toggle"[^>]*>/s)?.[0] || '';
  const sliderRowTag = indexHtml.match(/<div[^>]*id="scope-slider-row"[^>]*>/s)?.[0] || '';
  assert.ok(toggleTag, 'scope toggle markup must remain available for opt-in use');
  assert.ok(sliderRowTag, 'scope feather row must remain available for opt-in use');
  assert.equal(/\bactive\b/.test(toggleTag), false);
  assert.match(toggleTag, /aria-pressed="false"/);
  assert.equal(/\bvisible\b/.test(sliderRowTag), false);
});

test('scope can still be enabled explicitly after the full-screen default', () => {
  _resetScopeMaskForTest();
  setScopeMaskEnabled(true);
  assert.equal(isScopeMaskEnabled(), true);
  setScopeMaskEnabled(false);
  assert.equal(isScopeMaskEnabled(), false);
});

test('share links default scope off but preserve explicit authored states', () => {
  assert.equal(managerForHash('#lat=10&lon=20').parseInitialHash().scopeEnabled, false);
  assert.equal(managerForHash('#lat=10&lon=20&sc=0').parseInitialHash().scopeEnabled, false);
  assert.equal(managerForHash('#lat=10&lon=20&sc=1').parseInitialHash().scopeEnabled, true);
});
