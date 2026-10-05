import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceBetweenRecords, diffViewportSnapshots, createViewportSnapshotStore } from './viewportSnapshots.js';

const rec = (id, latitude, longitude) => ({ id, name: id, latitude, longitude });
const snap = (records, generatedAt = 1) => ({ scope: 'viewport', generatedAt, bounds: { west: 0, east: 10, south: 0, north: 10 }, layers: [{ id: 'targets', name: 'Targets', status: 'ready', enabled: true, records }] });

test('distance handles antimeridian and rejects invalid coordinates', () => {
  assert.ok(distanceBetweenRecords(rec('a', 0, 179.9), rec('a', 0, -179.9)) < 23000);
  assert.equal(distanceBetweenRecords({ latitude: 91, longitude: 0 }, rec('x', 0, 0)), null);
});

test('diff reports moved targets while retaining added and removed counts', () => {
  const before = snap([rec('stay', 1, 1), rec('move', 1, 1), rec('gone', 2, 2)]);
  const after = snap([rec('stay', 1, 1), rec('move', 1.01, 1), rec('new', 3, 3)], 2);
  const diff = diffViewportSnapshots(before, after, { moveThresholdM: 500 });
  assert.equal(diff.addedCount, 1); assert.equal(diff.removedCount, 1); assert.equal(diff.movedCount, 1);
  assert.equal(diff.moved[0].id, 'move');
  assert.equal(diff.layers[0].movedCount, 1);
});

test('failed and truncated layers never produce movement', () => {
  const before = snap([rec('x', 1, 1)]);
  const after = { ...snap([rec('x', 2, 2)]), layers: [{ id: 'targets', status: 'error', enabled: true, truncated: true, records: [{ id: 'x', latitude: 2, longitude: 2 }] }] };
  const diff = diffViewportSnapshots(before, after);
  assert.equal(diff.movedCount, 0);
  assert.equal(diff.layers[0].comparable, false);
});

test('snapshot store is bounded and compares latest entries', () => {
  const store = createViewportSnapshotStore({ limit: 2 });
  store.capture(snap([rec('x', 1, 1)], 1)); store.capture(snap([rec('x', 1.1, 1)], 2)); store.capture(snap([rec('x', 1.2, 1)], 3));
  assert.equal(store.list().length, 2); assert.equal(store.compareLatest({ moveThresholdM: 100 }).movedCount, 1); store.clear(); assert.equal(store.latest(), null);
});
