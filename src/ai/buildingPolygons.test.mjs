import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  normalizeBuildingResult, projectBuildingPolygons, buildBuildingOverlayEntries, createBuildingPolygonLayer,
} from './buildingPolygons.js';

const square = [[10, 10], [40, 10], [40, 40], [10, 40]];
const response = (polygons = [{ points: square, confidence: null }]) => ({
  ok: true, task: 'buildings', model: 'building-model', image: { width: 100, height: 100 },
  polygons, truncated: false,
});
const projectPixel = (x, y) => [116.4 + x / 10000, 39.9 - y / 10000];

test('normalization copies bounded simple polygons and retains unknown confidence honestly', () => {
  const input = response();
  const result = normalizeBuildingResult(input);
  assert.equal(result.ok, true);
  assert.equal(result.polygons[0].confidence, null);
  assert.equal(result.model, 'building-model');
  assert.notEqual(result.polygons[0].points, input.polygons[0].points);
  assert.notEqual(result.polygons[0].points[0], input.polygons[0].points[0]);
  assert.equal(result.rejectedCount, 0);
});

test('normalization rejects invalid envelopes before processing any polygon', () => {
  for (const patch of [
    { task: 'obb' }, { ok: false }, { model: '' }, { model: 'bad\nmodel' },
    { image: { width: 0, height: 100 } }, { image: { width: 4097, height: 100 } },
    { polygons: null }, { polygons: Array.from({ length: 501 }, () => ({ points: square, confidence: null })) },
  ]) assert.equal(normalizeBuildingResult({ ...response(), ...patch }).ok, false);
});

test('invalid polygons are discarded individually without repairing or clipping vertices', () => {
  const invalidRings = [
    [[1, 1], [2, 2], [3, 3]],
    [[1, 1], [9, 9], [1, 9], [9, 1]],
    [[1, 1], [8, 1], [4, 1], [4, 8]],
    [[1, 1], [8, 1], [8, 8], [1, 1], [1, 8]],
    [[-1, 1], [8, 1], [8, 8]],
    [[1, 1], [101, 1], [8, 8]],
    [[1, 1], [8, NaN], [8, 8]],
    [[1, 1], [8, 1]],
  ];
  const result = normalizeBuildingResult(response([
    ...invalidRings.map((points) => ({ points, confidence: 0.8 })),
    { points: square, confidence: 1.2 }, { points: square, confidence: '0.8' },
    { points: square, confidence: 0.8 },
  ]));
  assert.equal(result.polygons.length, 1);
  assert.equal(result.rejectedCount, invalidRings.length + 2);
});

test('a repeated closing coordinate is removed and valid concave outlines remain unchanged', () => {
  const concave = [[0, 0], [100, 0], [100, 100], [50, 50], [0, 100]];
  const result = normalizeBuildingResult(response([{ points: [...concave, concave[0]], confidence: 0 }]));
  assert.deepEqual(result.polygons[0].points, concave);
  assert.equal(result.polygons[0].confidence, 0);
});

test('normalization preserves high-detail segmentation contours up to 256 vertices', () => {
  const detailed = Array.from({ length: 128 }, (_, index) => {
    const angle = (Math.PI * 2 * index) / 128;
    return [50 + Math.cos(angle) * 40, 50 + Math.sin(angle) * 40];
  });
  const result = normalizeBuildingResult(response([{ points: detailed, confidence: 0.91 }]));
  assert.equal(result.ok, true);
  assert.equal(result.polygons.length, 1);
  assert.equal(result.polygons[0].points.length, detailed.length);
});

test('projection preserves vertices, model provenance and Chinese labels', () => {
  const result = projectBuildingPolygons(response(), projectPixel);
  assert.equal(result.ok, true);
  assert.deepEqual(result.polygons[0].coordinates, square.map(([x, y]) => projectPixel(x, y)));
  assert.equal(result.polygons[0].label, '影像建筑 1');
  assert.equal(result.polygons[0].model, 'building-model');
  assert.deepEqual(result.polygons[0].pixelPoints, square);
});

test('projection discards the entire polygon if any vertex misses the terrain', () => {
  const result = projectBuildingPolygons(response(), (x, y) => x === 40 && y === 10 ? null : projectPixel(x, y));
  assert.equal(result.polygons.length, 0);
  assert.equal(result.rejectedCount, 1);
  assert.equal(projectBuildingPolygons(response(), () => { throw Error('sky'); }).polygons.length, 0);
});

test('projection rejects geographic collapse, invalid ranges, crossing and dateline jumps', () => {
  for (const mapper of [() => [116, 39], () => [200, 20], () => [116, Infinity],
    (x, y) => [x === 10 ? 179 : -179, y],
    (x, y) => [x, x === 40 ? 50 - y : y],
  ]) assert.equal(projectBuildingPolygons(response(), mapper).polygons.length, 0);
  assert.equal(projectBuildingPolygons(response(), null).ok, false);
});

test('Chinese map labels are collision-managed and do not invent confidence scores', () => {
  const result = projectBuildingPolygons(response(), projectPixel);
  const entries = buildBuildingOverlayEntries(result.polygons);
  assert.equal(entries[0].title, '影像建筑 1');
  assert.equal(entries[0].collisionGroup, 'ambient-label');
  assert.equal(entries[0].accent, '#35edff');
  assert.ok(!entries[0].title.includes('%'));
  assert.ok(buildBuildingOverlayEntries(Array.from({ length: 100 }, () => result.polygons[0])).length <= 60);
});

function viewerHarness() {
  const sources = new Set();
  let requestRenderCount = 0;
  const calls = [];
  return {
    sources, calls,
    viewer: {
      dataSources: { add: async (source) => { sources.add(source); return source; }, remove: (source) => sources.delete(source) },
      scene: { requestRender: () => { requestRenderCount += 1; } },
    },
    overlay: { setEntries: (id, entries) => calls.push(['set', id, entries]), clear: (id) => calls.push(['clear', id]) },
    get requestRenderCount() { return requestRenderCount; },
  };
}

test('layer draws ground-clamped independent cyan geometry with Chinese entity names', async () => {
  const harness = viewerHarness();
  const layer = createBuildingPolygonLayer({ viewer: harness.viewer, overlay: harness.overlay });
  const result = await layer.replace(response(), { projectPixel });
  assert.equal(result.ok, true);
  assert.equal(harness.sources.size, 1);
  const source = [...harness.sources][0];
  assert.ok(source instanceof Cesium.CustomDataSource);
  const polygon = source.entities.values.find((entity) => entity.polygon);
  const outline = source.entities.values.find((entity) => entity.polyline);
  assert.equal(polygon.name, '影像建筑 1');
  assert.equal(polygon.properties.model.getValue(), 'building-model');
  assert.equal(polygon.polygon.material.color.getValue().withAlpha(1).toCssHexString(), '#35edff');
  assert.ok(polygon.polygon.material.color.getValue().alpha <= 0.2);
  assert.equal(outline.polyline.clampToGround.getValue(), true);
  assert.ok(outline.polyline.width.getValue() >= 3);
  assert.equal(outline.polyline.positions.getValue().length, square.length + 1);
  assert.equal(layer.getRecords().length, 1);
  assert.ok(harness.requestRenderCount > 0);
  layer.destroy();
  assert.equal(harness.sources.size, 0);
});

test('layer preserves previous geometry on invalid replacement or insertion failure', async () => {
  const harness = viewerHarness();
  const layer = createBuildingPolygonLayer({ viewer: harness.viewer, overlay: harness.overlay });
  await layer.replace(response(), { projectPixel });
  const original = [...harness.sources][0];
  assert.equal((await layer.replace({ ok: false }, { projectPixel })).ok, false);
  assert.ok(harness.sources.has(original));
  harness.viewer.dataSources.add = async () => { throw Error('insert failed'); };
  assert.equal((await layer.replace(response(), { projectPixel })).ok, false);
  assert.ok(harness.sources.has(original));
  assert.equal(layer.getRecords().length, 1);
});

test('layer atomically replaces geometry and a valid empty result clears it', async () => {
  const harness = viewerHarness();
  const layer = createBuildingPolygonLayer({ viewer: harness.viewer, overlay: harness.overlay });
  await layer.replace(response(), { projectPixel });
  const original = [...harness.sources][0];
  await layer.replace(response([{ points: square, confidence: 0.9 }]), { projectPixel });
  assert.equal(harness.sources.size, 1);
  assert.ok(!harness.sources.has(original));
  await layer.replace(response([]), { projectPixel });
  assert.equal(layer.getRecords().length, 0);
  assert.equal(harness.sources.size, 0);
  assert.equal(harness.calls.at(-1)[0], 'clear');
});

test('capture visibility hides current and replacement sources, then restores after concurrent releases', async () => {
  const harness = viewerHarness();
  const layer = createBuildingPolygonLayer({ viewer: harness.viewer, overlay: harness.overlay });
  await layer.replace(response(), { projectPixel });
  const first = [...harness.sources][0];
  const releaseA = layer.beginCapture();
  const releaseB = layer.beginCapture();
  assert.equal(first.show, false);
  await layer.replace(response([{ points: square, confidence: 0.9 }]), { projectPixel });
  const replacement = [...harness.sources][0];
  assert.equal(replacement.show, false);
  releaseA();
  assert.equal(replacement.show, false);
  releaseB();
  assert.equal(replacement.show, true);
});

test('clear and destroy invalidate in-flight insertions and remove their late data source', async () => {
  for (const method of ['clear', 'destroy']) {
    const harness = viewerHarness();
    let resolve;
    harness.viewer.dataSources.add = (source) => new Promise((done) => { resolve = () => { harness.sources.add(source); done(source); }; });
    const layer = createBuildingPolygonLayer({ viewer: harness.viewer, overlay: harness.overlay });
    const pending = layer.replace(response(), { projectPixel });
    layer[method]();
    resolve();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(harness.sources.size, 0);
    assert.equal(layer.getRecords().length, 0);
    if (method === 'destroy') assert.equal((await layer.replace(response(), { projectPixel })).ok, false);
  }
});
