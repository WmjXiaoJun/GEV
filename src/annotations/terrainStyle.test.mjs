import test from 'node:test';
import assert from 'node:assert/strict';
import { slopeBand, terrainRouteColor, terrainRole, terrainDetailVisible, SLOPE_BANDS } from './terrainStyle.js';

test('terrain slope bands use exact boundaries and preserve unknown data', () => {
  for (const [slope, key] of [[0, 'green'], [7.99, 'green'], [8, 'cyan'], [14.99, 'cyan'], [15, 'amber'], [29.99, 'amber'], [30, 'red'], [90, 'red']]) {
    assert.equal(slopeBand(slope).key, key);
    assert.equal(terrainRouteColor(slope), SLOPE_BANDS.find((band) => band.key === key).color);
  }
  for (const value of [null, undefined, '', '4', NaN, Infinity, -1, 91]) assert.equal(slopeBand(value).key, 'unknown');
});

test('terrain point roles are explicit and do not restyle unrelated drawings', () => {
  assert.equal(terrainRole({source: 'terrain-analysis', visibilityClass: 'slope'}), 'slope');
  assert.equal(terrainRole({source: 'terrain-analysis', terrainRole: 'highest'}), 'highest');
  assert.equal(terrainRole({source: 'vision', terrainRole: 'highest'}), null);
});

test('explicit terrain samples and extrema remain visible across zoom bands while derived contours declutter', () => {
  assert.equal(terrainDetailVisible({ source: 'terrain-analysis', terrainRole: 'sample', visibilityClass: 'sample' }, 14_000), true);
  assert.equal(terrainDetailVisible({ source: 'terrain-analysis', terrainRole: 'slope', visibilityClass: 'slope' }, 50_000), true);
  assert.equal(terrainDetailVisible({ source: 'terrain-analysis', terrainRole: 'highest' }, 50_000), true);
  assert.equal(terrainDetailVisible({ source: 'terrain-analysis', visibilityClass: 'contour-secondary' }, 14_000), false);
});
