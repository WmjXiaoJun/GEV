import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotHistory, diffSnapshots, normalizeSnapshot } from './snapshots.js';

const rec = (id, extra = {}) => ({ id, name: id, latitude: 1, longitude: 2, ...extra });
const snap = (records, extra = {}) => ({ scope: 'viewport', generatedAt: extra.generatedAt ?? 100, bounds: { west: 0, east: 5, south: 0, north: 5 }, layers: [{ id: 'flights', name: 'Flights', records, ...extra }] });

test('normalizes records, deduplicates IDs, and keeps immutable snapshot data', () => {
  const value = normalizeSnapshot(snap([rec('a'), rec('a'), rec('b')]));
  assert.equal(value.layers[0].records.length, 2);
  assert.equal(value.layers[0].count, 2);
  assert.throws(() => { value.layers[0].records.push(rec('c')); }, TypeError);
});

test('diff reports added, removed and count changes by layer', () => {
  const diff = diffSnapshots(snap([rec('a'), rec('b')]), snap([rec('b'), rec('c')]));
  assert.equal(diff.addedCount, 1); assert.equal(diff.removedCount, 1);
  assert.deepEqual(diff.layers[0].added.map((item) => item.id), ['c']);
  assert.deepEqual(diff.layers[0].removed.map((item) => item.id), ['a']);
  assert.equal(diff.layers[0].countDelta, 0);
});

test('unavailable or disabled layers are not misreported as removed targets', () => {
  const diff = diffSnapshots(snap([rec('a')]), { ...snap([]), layers: [{ id: 'flights', enabled: false, records: [] }] });
  assert.equal(diff.removedCount, 0); assert.equal(diff.layers[0].unavailable, true);
});

test('failed or truncated feeds preserve status and never create removal diffs', () => {
  const before = snap([rec('a')]);
  const after = { ...snap([], { status: 'error', truncated: true }), layers: [{ id: 'flights', name: 'Flights', status: 'error', truncated: true, records: [] }] };
  const normalized = normalizeSnapshot(after);
  assert.equal(normalized.layers[0].status, 'error');
  assert.equal(normalized.layers[0].truncated, true);
  const diff = diffSnapshots(before, after);
  assert.equal(diff.removedCount, 0);
  assert.equal(diff.layers[0].comparable, false);
});

test('moving the viewport makes a comparison non-comparable', () => {
  const before = snap([rec('a')]);
  const after = { ...snap([rec('b')]), bounds: { west: 20, east: 25, south: 20, north: 25 } };
  const diff = diffSnapshots(before, after);
  assert.equal(diff.boundsChanged, true);
  assert.equal(diff.comparable, false);
  assert.equal(diff.addedCount, 0);
  assert.equal(diff.removedCount, 0);
});

test('snapshot history retains bounded immutable snapshots and compares entries', () => {
  const history = createSnapshotHistory({ limit: 2 });
  history.capture(snap([rec('a')], { generatedAt: 1 }));
  history.capture(snap([rec('a'), rec('b')], { generatedAt: 2 }));
  history.capture(snap([rec('b')], { generatedAt: 3 }));
  assert.equal(history.list().length, 2);
  assert.equal(history.latest().generatedAt, 3);
  assert.equal(history.compare(1, 0).removedCount, 1);
  history.clear(); assert.equal(history.latest(), null);
});
