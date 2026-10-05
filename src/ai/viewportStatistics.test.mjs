import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createMapWorkspace } from './mapWorkspace.js';
import { buildViewBrief, pointInBounds } from './intelligence.js';
import { createViewportFilter } from './viewportGeometry.js';

function fixture(records = []) {
  const scene = {
    canvas: { clientWidth: 1000, clientHeight: 600 }, drawingBufferWidth: 1000, drawingBufferHeight: 600,
    pixelRatio: 1, mode: Cesium.SceneMode.SCENE3D, frameState: { mode: Cesium.SceneMode.SCENE3D },
    mapProjection: new Cesium.GeographicProjection(), ellipsoid: Cesium.Ellipsoid.WGS84,
    globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
  };
  const camera = new Cesium.Camera(scene);
  scene.camera = camera;
  const setView = (lon = 0, lat = 0, pitch = -90, heading = 0, height = 1000000, roll = 0) => camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
    orientation: { heading: Cesium.Math.toRadians(heading), pitch: Cesium.Math.toRadians(pitch), roll: Cesium.Math.toRadians(roll) },
  });
  setView();
  const layers = [{ id: 'data-centers', name: 'Data centers', source: 'Local', enabled: true, stats: { status: 'ready', count: 4362, lastUpdate: 1000 } }];
  const module = { getAnalystRecords: (limit) => records.slice(0, limit) };
  const dataManager = { getAll: () => layers, layers: new Map([['data-centers', { module }]]) };
  const viewer = { scene, camera };
  const workspace = createMapWorkspace({ viewer, dataManager, styleManager: {}, runAction: async () => ({ ok: true }), now: () => 2000 });
  return { workspace, scene, camera, setView, records, layers, module, viewer };
}

test('real Cesium camera counts front-facing on-screen anchors, not whole-layer stats or globe backside', () => {
  const f = fixture([
    { id: 'visible', name: 'Visible', lat: 0, lon: 0, category: 'hosting', operator: 'A', country: 'XX', usage: 'research' },
    { id: 'outside', lat: 0, lon: 30 }, { id: 'backside', lat: 0, lon: 180 },
    { id: 'invalid', lat: null, lon: 0 },
  ]);
  const snapshot = f.workspace.getViewSnapshot();
  assert.equal(snapshot.scope, 'viewport');
  assert.equal(snapshot.viewport.available, true);
  assert.equal(snapshot.viewport.method, 'camera-frustum-and-ellipsoid');
  assert.equal(snapshot.viewport.geometry, 'record-anchor');
  assert.equal(snapshot.layers[0].count, 1);
  assert.deepEqual(snapshot.layers[0].records.map((record) => record.id), ['visible']);
  assert.equal(snapshot.layers[0].records[0].category, 'hosting');
  assert.equal(snapshot.layers[0].records[0].usage, 'research');
  const brief = buildViewBrief(snapshot);
  assert.equal(brief.scope, 'viewport-loaded-data-only');
  assert.equal(brief.totalCount, 1);
  assert.equal(JSON.parse(brief.context).viewport.geometry, 'record-anchor');
});

test('tilted and rolled views exclude bbox corners that are outside the actual canvas', () => {
  const f = fixture();
  f.setView(0, 0, -45, 30, 500000, 25);
  const rectangle = f.camera.computeViewRectangle();
  const bounds = Object.fromEntries(['west', 'south', 'east', 'north'].map((key) => [key, Cesium.Math.toDegrees(rectangle[key])]));
  let outside;
  let inside;
  for (let lat = bounds.south; lat <= bounds.north; lat += (bounds.north - bounds.south) / 12) {
    for (let lon = bounds.west; lon <= bounds.east; lon += (bounds.east - bounds.west) / 12) {
      const point = Cesium.Cartesian3.fromDegrees(lon, lat);
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(f.scene, point);
      if (!screen) continue;
      if (screen.x < 0 || screen.y < 0 || screen.x > 1000 || screen.y > 600) outside ??= { id: 'bbox-only', lat, lon };
      else inside ??= { id: 'visible', lat, lon };
    }
  }
  assert.ok(inside && outside, 'real tilted camera fixture contains both projection cases');
  assert.equal(pointInBounds(bounds, outside.lat, outside.lon), true);
  f.records.push(inside, outside);
  assert.deepEqual(f.workspace.getViewSnapshot().layers[0].records.map((record) => record.id), ['visible']);
  assert.equal(f.workspace.getSnapshot().layers[0].records.length, 2, 'watchlist geographic snapshots retain their rectangular coverage contract');
});

test('sky-facing cameras report zero and moving the camera recomputes the viewport', () => {
  const f = fixture([{ id: 'first', lat: 0, lon: 0 }, { id: 'second', lat: 0, lon: 20 }]);
  assert.equal(f.workspace.getViewSnapshot().layers[0].records[0].id, 'first');
  f.setView(20);
  assert.equal(f.workspace.getViewSnapshot().layers[0].records[0].id, 'second');
  f.setView(20, 0, 90);
  assert.equal(f.workspace.getViewSnapshot().layers[0].count, 0);
  assert.equal(buildViewBrief(f.workspace.getViewSnapshot()).totalCount, 0);
});

test('actual view across the antimeridian includes both longitude signs, not Greenwich', () => {
  const f = fixture([{ id: 'west', lat: 0, lon: 179 }, { id: 'east', lat: 0, lon: -179 }, { id: 'other', lat: 0, lon: 0 }]);
  f.setView(180);
  const result = f.workspace.getViewSnapshot();
  assert.ok(result.bounds.west > result.bounds.east);
  assert.deepEqual(result.layers[0].records.map((record) => record.id), ['west', 'east']);
});

test('viewport unavailable, non-3D mode, zero-size canvas and missing readers fail closed', () => {
  for (const damage of [
    (f) => { f.viewer.camera = undefined; },
    (f) => { f.scene.canvas.clientWidth = 0; },
    (f) => { f.scene.mode = Cesium.SceneMode.SCENE2D; },
    (f) => { f.scene.frameState = undefined; },
  ]) {
    const f = fixture([{ id: 'a', lat: 0, lon: 0 }]);
    damage(f);
    const snapshot = f.workspace.getViewSnapshot();
    assert.equal(snapshot.viewport.available, false);
    assert.equal(snapshot.layers[0].count, null);
    assert.equal(buildViewBrief(snapshot).layers[0].count, null);
  }
  const f = fixture([{ id: 'a', lat: 0, lon: 0 }]);
  f.module.getAnalystRecords = undefined;
  assert.equal(f.workspace.getViewSnapshot().layers[0].status, 'unsupported');
  assert.equal(f.workspace.getViewSnapshot().layers[0].count, null);
  f.layers[0].enabled = false;
  assert.equal(f.workspace.getViewSnapshot().layers[0].status, 'disabled');
  assert.equal(f.workspace.getViewSnapshot().layers[0].count, null);
});

test('viewport total and category statistics use all matches before capping record details', () => {
  const f = fixture(Array.from({ length: 2101 }, (_, id) => ({ id, lat: 0, lon: 0, category: id < 2050 ? 'hosting' : null, country: 'XX', simulated: id % 2 === 0 })));
  const snapshot = f.workspace.getViewSnapshot();
  const result = buildViewBrief(snapshot);
  assert.equal(snapshot.layers[0].records.length, 2000);
  assert.equal(snapshot.layers[0].truncated, true);
  assert.equal(result.layers[0].count, 2101);
  assert.equal(result.layers[0].countIsLowerBound, false);
  assert.equal(result.layers[0].simulatedCount, 1051);
  assert.deepEqual(result.layers[0].breakdown.category.values, [{ value: 'hosting', count: 2050 }]);
  assert.equal(result.layers[0].breakdown.category.unknownCount, 51);
  assert.equal(result.layers[0].breakdown.usage.unknownCount, 2101);
  assert.equal(result.layers[0].breakdown.operator.unknownCount, 2101);
});

test('source scan overflow is a lower bound, detail caps alone are not', () => {
  const f = fixture();
  let requested;
  const outside = { id: 'outside', lat: 0, lon: 120 };
  f.module.getAnalystRecords = (limit) => {
    requested = limit;
    return [{ id: 'inside', lat: 0, lon: 0 }, ...Array(500000).fill(outside)];
  };
  const layer = buildViewBrief(f.workspace.getViewSnapshot()).layers[0];
  assert.equal(requested, 500001);
  assert.equal(layer.count, 1);
  assert.equal(layer.countIsLowerBound, true);
});

test('classification only uses explicit fields and preserves unknown and overflow totals', () => {
  const f = fixture(Array.from({ length: 12 }, (_, id) => ({ id, name: `Cloud ${id}`, lat: 0, lon: 0, operator: `Operator ${id}`, category: null, usage: id === 0 ? '<raw>' : null })));
  const result = buildViewBrief(f.workspace.getViewSnapshot());
  const breakdown = result.layers[0].breakdown;
  assert.equal(breakdown.operator.values.length, 10);
  assert.equal(breakdown.operator.otherCount, 2);
  assert.equal(breakdown.operator.otherCategoryCount, 2);
  assert.equal(breakdown.category.unknownCount, 12);
  assert.equal(breakdown.usage.unknownCount, 11);
  assert.equal(result.layers[0].sample[0].category, null);
  assert.equal(result.layers[0].sample[0].usage, '<raw>');
});

test('compacted model context retains category evidence, counts and a hard size bound', () => {
  const f = fixture(Array.from({ length: 12 }, (_, id) => ({ id, name: 'n'.repeat(160), lat: 0, lon: 0, category: `Category ${id}`, operator: `Operator ${id}`, country: 'XX', usage: 'research' })));
  const snapshot = f.workspace.getViewSnapshot();
  const originalLayer = snapshot.layers[0];
  const large = { ...snapshot, layers: Array.from({ length: 32 }, (_, id) => ({ ...originalLayer, id: `${id}${'i'.repeat(80)}`, name: 'n'.repeat(160), source: 's'.repeat(120) })) };
  const result = buildViewBrief(large);
  const context = JSON.parse(result.context);
  assert.ok(result.context.length <= 14000);
  assert.ok(context.layers.length > 0);
  for (const layer of context.layers) {
    assert.equal(layer.count, 12);
    assert.ok(layer.breakdown.category.values.length > 0);
    assert.equal(layer.breakdown.usage.values[0].value, 'research');
  }
});

test('static sources distinguish local load time from unknown source freshness', () => {
  const f = fixture([{ id: 'a', lat: 0, lon: 0, source: 'OpenStreetMap', loadedAt: 1000, updatedAt: null, sourceUpdatedAt: null }]);
  f.layers[0].stats = { isStatic: true, lastUpdate: 1000, loadedAt: 1000, sourceUpdatedAt: null, status: 'ready' };
  const snapshot = f.workspace.getViewSnapshot();
  const result = buildViewBrief(snapshot);
  assert.equal(snapshot.layers[0].loadedAt, 1000);
  assert.equal(snapshot.layers[0].updatedAt, null);
  assert.equal(result.layers[0].lastUpdated, null);
  assert.equal(result.layers[0].loadedAt, 1000);
  assert.equal(result.layers[0].sourceUpdatedAt, null);
  assert.equal(result.layers[0].sample[0].loadedAt, 1000);
  assert.equal(result.layers[0].sample[0].sourceUpdatedAt, null);
  f.layers[0].stats.sourceUpdatedAt = 500;
  assert.equal(buildViewBrief(f.workspace.getViewSnapshot()).layers[0].lastUpdated, 500);
});

test('enabled viewport layers are summarized before disabled catalog entries', () => {
  const f = fixture([{ id: 'a', lat: 0, lon: 0 }]);
  f.layers.unshift(...Array.from({ length: 40 }, (_, id) => ({ id: `disabled-${id}`, enabled: false })));
  const brief = buildViewBrief(f.workspace.getViewSnapshot());
  assert.equal(brief.layers[0].id, 'data-centers');
  assert.equal(brief.totalCount, 1);
  assert.equal(brief.truncated, true);
});

test('projection failures produce unavailable evidence rather than zero counts', () => {
  const f = fixture([{ id: 'a', lat: 0, lon: 0 }]);
  const projection = Cesium.SceneTransforms.worldToWindowCoordinates;
  try {
    Cesium.SceneTransforms.worldToWindowCoordinates = () => { throw new Error('lost rendering context'); };
    const result = f.workspace.getViewSnapshot();
    assert.equal(result.layers[0].count, null);
    assert.equal(buildViewBrief(result).layers[0].count, null);
  } finally { Cesium.SceneTransforms.worldToWindowCoordinates = projection; }
});

test('clip planes and unusable screen projections exclude invisible geographic anchors', () => {
  const f = fixture([{ id: 'a', lat: 0, lon: 0 }]);
  f.camera.frustum.far = 100;
  assert.equal(f.workspace.getViewSnapshot().layers[0].count, 0);
  f.camera.frustum.far = 10000000;
  f.camera.frustum.near = 2000000;
  assert.equal(f.workspace.getViewSnapshot().layers[0].count, 0);
  f.camera.frustum.near = 1;
  const projection = Cesium.SceneTransforms.worldToWindowCoordinates;
  try {
    for (const screen of [undefined, { x: NaN, y: 1 }, { x: 1, y: Infinity }, { x: 1001, y: 300 }, { x: 1, y: -1 }]) {
      Cesium.SceneTransforms.worldToWindowCoordinates = () => screen;
      assert.equal(f.workspace.getViewSnapshot().layers[0].count, 0);
    }
  } finally { Cesium.SceneTransforms.worldToWindowCoordinates = projection; }
});

test('invalid geometry dependencies expose a closed predicate without throwing', () => {
  const f = fixture();
  const viewers = [
    null,
    { ...f.viewer, scene: { ...f.scene, canvas: { clientWidth: 0, clientHeight: 600 } } },
    { ...f.viewer, get camera() { throw new Error('destroyed camera'); } },
  ];
  const invalidCamera = { positionWC: Cesium.Cartesian3.ZERO, directionWC: Cesium.Cartesian3.ZERO, frustum: { near: 1, far: 10 } };
  viewers.push({ camera: invalidCamera, scene: { ...f.scene, camera: invalidCamera } });
  for (const viewer of viewers) {
    const filter = createViewportFilter(viewer);
    assert.equal(filter.metadata.available, false);
    assert.equal(filter.contains({ lat: 0, lon: 0 }), false);
  }
});

test('geographic bbox failure does not replace a working precise viewport with global counts', () => {
  const f = fixture([{ id: 'a', lat: 0, lon: 0 }, { id: 'b', lat: 0, lon: 20 }]);
  f.camera.computeViewRectangle = () => undefined;
  const result = f.workspace.getViewSnapshot();
  assert.equal(result.bounds, null);
  assert.equal(result.viewport.available, true);
  assert.equal(buildViewBrief(result).layers[0].count, 1);
});

test('unobserved empty viewport sources keep count unavailable rather than claiming zero', () => {
  const f = fixture();
  f.layers[0].stats = {};
  assert.equal(f.workspace.getViewSnapshot().layers[0].status, 'unknown');
  assert.equal(f.workspace.getViewSnapshot().layers[0].count, null);
});

test('missing geographic anchors are explicit partial coverage, not guessed from layer stats counts', () => {
  const f = fixture([{ id: 'a', lat: 0, lon: 0 }, { id: 'invalid', lat: null, lon: 0 }]);
  f.layers[0].stats = { status: 'ready', count: 999, analystRecordCount: 2, unlocatedRecordCount: 12 };
  const result = buildViewBrief(f.workspace.getViewSnapshot()).layers[0];
  assert.equal(result.count, 1);
  assert.equal(result.countIsLowerBound, true);
  assert.equal(result.unlocatedRecordCount, 13);
  f.records.pop();
  f.layers[0].stats.unlocatedRecordCount = 0;
  assert.equal(buildViewBrief(f.workspace.getViewSnapshot()).layers[0].countIsLowerBound, false, 'unrelated display count never defines statistical completeness');
});
