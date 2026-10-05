import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeTerrainSamples,
  normalizeTerrainGrid,
  normalizeTerrainViewport,
  parseTerrainAnalysisRequest,
  terrainSamplePoints,
  deriveSlopeGrid,
  buildElevationBands,
  detectTerrainFeatures,
  buildElevationProfile,
  analyzeLineOfSight,
} from './terrainAnalysis.js';

test('normalizes bounded viewport and generates row-major samples', () => {
  const viewport = normalizeTerrainViewport({ west: -10, south: 20, east: 0, north: 30, cols: 3, rows: 3 });
  assert.deepEqual(terrainSamplePoints(viewport), [
    [-10, 20], [-5, 20], [0, 20],
    [-10, 25], [-5, 25], [0, 25],
    [-10, 30], [-5, 30], [0, 30],
  ]);
});

test('rejects inverted bounds and oversized grids', () => {
  assert.throws(() => normalizeTerrainViewport({ west: 0, south: 0, east: -1, north: 1 }));
  assert.throws(() => normalizeTerrainViewport({ west: 0, south: 0, east: 1, north: 1, cols: 32, rows: 3 }));
});

test('analyzes relief, missing samples and drawable contour segments', () => {
  const viewport = { west: 0, south: 0, east: 2, north: 2, cols: 3, rows: 3 };
  const samples = [
    { elevation: 0 }, { elevation: 50 }, { elevation: 100 },
    { elevation: 0 }, { elevation: 50 }, { elevation: 100 },
    { elevation: 0 }, { elevation: 50 }, { elevation: null },
  ];
  const result = analyzeTerrainSamples(viewport, samples);
  assert.equal(result.stats.sampleCount, 8);
  assert.equal(result.stats.missingCount, 1);
  assert.equal(result.stats.min, 0);
  assert.equal(result.stats.max, 100);
  assert.equal(result.stats.range, 100);
  assert.equal(result.stats.terrainClass, 'rolling');
  assert.ok(result.contours.length > 0);
  assert.ok(result.contours.every((contour) => contour.segments.every((segment) => segment.length === 2)));
});

test('does not fabricate a zero result when all samples are missing', () => {
  assert.throws(() => analyzeTerrainSamples(
    { west: 0, south: 0, east: 1, north: 1, cols: 3, rows: 3 },
    Array.from({ length: 9 }, () => null),
  ), /no usable heights/);
});

test('accepts camera-ray grids with sky cells and keeps drawable coordinates', () => {
  const points = [
    null, [10, 20], [11, 20],
    null, [10, 21], [11, 21],
    [9, 22], [10, 22], [11, 22],
  ];
  const grid = normalizeTerrainGrid({ rows: 3, cols: 3, points });
  const result = analyzeTerrainSamples(grid, [
    null, { elevation: 30 }, { elevation: 50 },
    null, { elevation: 40 }, { elevation: 60 },
    { elevation: 20 }, { elevation: 35 }, { elevation: 55 },
  ]);
  assert.equal(result.stats.sampleCount, 7);
  assert.equal(result.stats.missingCount, 2);
  assert.deepEqual(result.grid.points[1], [10, 20]);
  assert.equal(result.grid.values[0], null);
  assert.ok(result.stats.maxSlopeDeg !== null);
  assert.equal(result.profiles.westEast.length, 3);
  assert.equal(result.profiles.southNorth.length, 3);
});

test('keeps antimeridian grid bounds compact', () => {
  const grid = normalizeTerrainGrid({ rows: 3, cols: 3, points: [
    [179, 0], [-179, 0], [180, 0], [179, 1], [-179, 1], [180, 1], [179, 2], [-179, 2], [180, 2],
  ] });
  const span = grid.bounds.east >= grid.bounds.west
    ? grid.bounds.east - grid.bounds.west
    : (grid.bounds.east + 360) - grid.bounds.west;
  assert.ok(span < 10);
});

test('validates the POST camera-ray grid contract', () => {
  const body = JSON.stringify({ rows: 3, cols: 3, points: Array.from({ length: 9 }, (_, index) => ({
    lon: -97 + (index % 3) * 0.01,
    lat: 30 + Math.floor(index / 3) * 0.01,
  })) });
  const parsed = parseTerrainAnalysisRequest({ method: 'POST', contentType: 'application/json; charset=utf-8', body });
  assert.equal(parsed.points.length, 9);
  assert.throws(() => parseTerrainAnalysisRequest({ method: 'GET', contentType: 'application/json', body }));
  assert.throws(() => parseTerrainAnalysisRequest({ method: 'POST', contentType: 'text/plain', body }));
  assert.throws(() => parseTerrainAnalysisRequest({ method: 'POST', contentType: 'application/json', body: JSON.stringify({ rows: '3', cols: 3, points: [] }) }));
});

test('derives bounded slope grid and elevation bands', () => {
  const points = [[0, 0], [0.01, 0], [0.02, 0], [0, 0.01], [0.01, 0.01], [0.02, 0.01], [0, 0.02], [0.01, 0.02], [0.02, 0.02]];
  const values = [0, 10, 20, 0, 10, 20, 0, 10, 20];
  const slopes = deriveSlopeGrid({ rows: 3, cols: 3, points, values });
  assert.equal(slopes.length, 9);
  assert.ok(slopes.some((value) => Number.isFinite(value) && value > 0));
  const bands = buildElevationBands(values, 4);
  assert.equal(bands.length, 4);
  assert.equal(bands.reduce((sum, band) => sum + band.sampleCount, 0), values.length);
});

test('detects prominent extrema and computes line-of-sight obstruction', () => {
  const points = [];
  for (let row = 0; row < 3; row += 1) for (let col = 0; col < 3; col += 1) points.push([col, row]);
  const features = detectTerrainFeatures({ rows: 3, cols: 3, points, values: [0, 0, 0, 0, 100, 0, 0, 0, 0] }, { prominence: 20 });
  assert.equal(features.highPoints.length, 1);
  const profile = buildElevationProfile([[0, 0], [0.01, 0], [0.02, 0]], [0, 100, 0]);
  const los = analyzeLineOfSight(profile);
  assert.equal(los.visible, false);
  assert.ok(los.blockingPoint);
});
