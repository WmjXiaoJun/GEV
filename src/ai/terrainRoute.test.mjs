import test from 'node:test';
import assert from 'node:assert/strict';
import { associateNearbyEntities, haversineDistanceM, planTerrainRoute, terrainRouteSegments, restorePlannedRouteGrades } from './terrainRoute.js';

test('matched planned geometry uses measured grades even if the model omits or alters them', () => {
  const points = [{latitude: 30, longitude: -97, elevation: 5, slopeDeg: 0}, {latitude: 30.01, longitude: -97, elevation: 120, slopeDeg: 12}];
  const args = { annotations: [{type: 'route', label: 'route', points: points.map(({latitude, longitude}) => ({latitude, longitude}))}] };
  const saved = structuredClone(args);
  const result = restorePlannedRouteGrades(args, {feasible: true, points});
  assert.deepEqual(result.annotations[0].points, points);
  assert.equal(result.annotations[0].source, 'terrain-route');
  assert.deepEqual(args, saved);
  assert.equal(restorePlannedRouteGrades(args, null), args);
  assert.equal(restorePlannedRouteGrades(args, {feasible: false, points}), args);
  const other = {...args, annotations: [{type: 'route', points: [{latitude: 31, longitude: -97}, {latitude: 32, longitude: -97}]}]};
  assert.deepEqual(restorePlannedRouteGrades(other, {feasible: true, points}), other);
});

function grid(values) {
  const points = [];
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) points.push([-97.7 + col * 0.01, 30 + row * 0.01]);
  }
  return { grid: { rows: 5, cols: 5, points, values } };
}

test('plans a route over usable terrain and reports elevation metrics', () => {
  const values = Array.from({ length: 25 }, (_, index) => Math.floor(index / 5) * 10 + (index % 5));
  const result = planTerrainRoute(grid(values), { longitude: -97.7, latitude: 30 }, { longitude: -97.66, latitude: 30.04 });
  assert.equal(result.feasible, true);
  assert.ok(result.points.length >= 2);
  assert.ok(result.stats.distanceM > 0);
  assert.ok(result.stats.ascentM > 0);
  assert.ok(result.stats.maxSlopeDeg >= 0);
  assert.equal(result.segments.length, result.points.length - 1);
  assert.ok(result.segments.every((segment) => Number.isFinite(segment.slopeDeg)));
});

test('terrain route segments preserve endpoints and expose local grade for styling', () => {
  const segments = terrainRouteSegments([
    { longitude: 0, latitude: 0, elevation: 0 },
    { longitude: 0.01, latitude: 0, elevation: 100 },
  ]);
  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].from, { longitude: 0, latitude: 0, elevation: 0 });
  assert.deepEqual(segments[0].to, { longitude: 0.01, latitude: 0, elevation: 100 });
  assert.ok(segments[0].slopeDeg > 0);
  assert.deepEqual(terrainRouteSegments([]), []);
});

test('missing heights and zero length segments never become a gentle grade', () => {
  const point = { longitude: 0, latitude: 0, elevation: 100 };
  for (const elevation of [null, undefined, '', NaN]) {
    assert.equal(terrainRouteSegments([point, {longitude: 0.01, latitude: 0, elevation}])[0].slopeDeg, null);
  }
  assert.equal(terrainRouteSegments([point, {...point}])[0].slopeDeg, null);
});

test('does not cross missing or over-limit slope cells', () => {
  const values = Array(25).fill(0);
  values[12] = null;
  values[13] = 10_000;
  const result = planTerrainRoute(grid(values), [-97.7, 30], [-97.66, 30.04], { maxSlopeDeg: 20 });
  assert.equal(result.feasible, true);
  assert.ok(result.points.every((point) => point.elevation !== null));
});

test('returns an explicit infeasible result when barriers split the grid', () => {
  const values = Array(25).fill(0);
  for (let row = 0; row < 5; row += 1) values[row * 5 + 2] = null;
  const result = planTerrainRoute(grid(values), [-97.7, 30], [-97.66, 30.04]);
  assert.equal(result.feasible, false);
  assert.deepEqual(result.points, []);
});

test('associates nearby entities and ignores malformed coordinates', () => {
  const result = associateNearbyEntities(
    [{ id: 'airport-1', longitude: -97.7, latitude: 30 }],
    [
      { id: 'target-1', kind: 'target', label: 'A', longitude: -97.701, latitude: 30 },
      { id: 'far', longitude: -97, latitude: 30 },
      { id: 'bad', longitude: 999, latitude: 30 },
    ],
    { radiusM: 500 },
  );
  assert.equal(result[0].matches.length, 1);
  assert.equal(result[0].matches[0].entityId, 'target-1');
});

test('haversine handles antimeridian distance', () => {
  const distance = haversineDistanceM([179.9, 0], [-179.9, 0]);
  assert.ok(distance > 20_000 && distance < 25_000);
});

test('does not silently snap endpoints outside a known viewport', () => {
  const terrain = { ...grid(Array(25).fill(0)), viewport: { bounds: { west: -97.7, east: -97.66, south: 30, north: 30.04 } } };
  const result = planTerrainRoute(terrain, [-97.9, 30], [-97.66, 30.04]);
  assert.equal(result.feasible, false);
  assert.match(result.reason, /outside/);
});

test('accepts route endpoints inside an antimeridian-crossing viewport', () => {
  const points = [];
  const longitudes = [179.8, 179.9, -180, -179.9, -179.8];
  for (let row = 0; row < 5; row += 1) {
    for (const longitude of longitudes) points.push([longitude, row * 0.01]);
  }
  const terrain = { grid: { rows: 5, cols: 5, points, values: Array(25).fill(0) }, viewport: { bounds: { west: 179.8, east: -179.8, south: 0, north: 0.04 } } };
  const result = planTerrainRoute(terrain, [179.8, 0], [-179.8, 0.04]);
  assert.equal(result.feasible, true);
});
