import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTerrainProfilePath, normalizeTerrainResult } from './terrainUi.js';

test('normalizes terrain metrics and samples from supported response envelopes', () => {
  const result = normalizeTerrainResult({
    data: { analysis: { minElevation: 12, maxElevation: 98, meanElevation: 44, relief: 86, meanSlope: 7.5, dominantAspect: 'NW', samples: [12, 20, 40, 98], summary: '起伏明显' }, overlay: { type: 'polygon' } },
  });
  assert.deepEqual(result.metrics, { minElevation: 12, maxElevation: 98, meanElevation: 44, relief: 86, meanSlope: 7.5, dominantAspect: 'NW' });
  assert.deepEqual(result.samples, [12, 20, 40, 98]);
  assert.equal(result.summary, '起伏明显');
  assert.deepEqual(result.overlay, { type: 'polygon' });
});

test('rejects invalid terrain samples and clamps pathological metrics', () => {
  const result = normalizeTerrainResult({ metrics: { minElevation: 'bad', maxElevation: 1e20, meanSlope: -4 }, profile: [{ elevation: 5 }, { elevation: 'x' }] });
  assert.equal(result.metrics.minElevation, undefined);
  assert.equal(result.metrics.maxElevation, 1e7);
  assert.equal(result.metrics.meanSlope, 0);
  assert.deepEqual(result.samples, [5]);
});

test('builds a bounded SVG polyline path from elevation samples', () => {
  assert.equal(buildTerrainProfilePath([10, 20, 30], 180, 80), 'M 0 80 L 90 40 L 180 0');
  assert.equal(buildTerrainProfilePath([], 180, 80), '');
});
