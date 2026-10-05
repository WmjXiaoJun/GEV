import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTerrainEvidence, terrainDisplayProfile } from './mapWorkspace.js';

test('terrain overlay budgets detail by camera altitude', () => {
  const near = terrainDisplayProfile(2_000);
  const mid = terrainDisplayProfile(20_000);
  const far = terrainDisplayProfile(100_000);
  assert.equal(near.band, 'near');
  assert.equal(near.showSamples, true);
  assert.equal(mid.band, 'mid');
  assert.ok(mid.contourLimit < near.contourLimit);
  assert.equal(mid.showSamples, true);
  assert.equal(mid.sampleLimit, 25, 'mid-range analysis keeps a visible 5x5 set of real samples');
  assert.equal(mid.showSlope, true);
  assert.equal(far.band, 'far');
  assert.equal(far.contourLimit, 0);
  assert.equal(far.showSlope, true, 'explicit analysis evidence remains visible even when contours are suppressed');
  assert.ok(far.sampleLimit > 0);
});

test('invalid camera heights use the detailed profile', () => {
  assert.equal(terrainDisplayProfile(Number.NaN).band, 'near');
  assert.equal(terrainDisplayProfile(undefined).band, 'near');
});

test('terrain evidence selector keeps a bounded real 5x5 set spanning the source grid', () => {
  const grid = Array.from({ length: 100 }, (_, index) => ({ index }));
  const selected = selectTerrainEvidence(grid, 10, 10, 25);
  assert.equal(selected.length, 25);
  assert.equal(selected[0].index, 0);
  assert.equal(selected.at(-1).index, 99);
  assert.deepEqual([...new Set(selected.map((point) => Math.floor(point.index / 10)))], [0, 2, 5, 7, 9]);
  assert.deepEqual([...new Set(selected.map((point) => point.index % 10))], [0, 2, 5, 7, 9]);
});
