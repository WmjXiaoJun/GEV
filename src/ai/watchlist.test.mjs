import test from 'node:test';
import assert from 'node:assert/strict';
import { createWatchlist } from './watchlist.js';

const bounds = { west: -10, east: 10, south: -10, north: 10 };
const input = { name: 'My area', bounds, layerIds: ['events'] };
const rec = (id, extra = {}) => ({ id, name: String(id), latitude: 0, longitude: 0, ...extra });
const snapshot = (records = [], extra = {}) => ({ bounds, generatedAt: extra.generatedAt ?? 200, layers: [{ id: 'events', name: 'Events', enabled: true, status: 'ready', source: 'USGS', updatedAt: 100, records, ...extra }] });
const storage = () => {
  let data = null;
  return { getItem: () => data, setItem: (_key, value) => { data = value; } };
};

test('first successful snapshot establishes baseline and only new stable IDs alert', () => {
  const watch = createWatchlist({ now: () => 300 });
  const area = watch.add(input);
  assert.deepEqual(watch.observe(snapshot([rec('a')])), []);
  assert.deepEqual(watch.observe(snapshot([rec('a', { latitude: 1 })])), []);
  const alerts = watch.observe(snapshot([rec('a'), rec('b', { eventAt: 50 })]));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].recordId, 'b');
  assert.equal(alerts[0].areaId, area.id);
  assert.equal(alerts[0].areaName, 'My area');
  assert.equal(alerts[0].source, 'USGS');
  assert.equal(alerts[0].eventAt, 50);
  assert.equal(alerts[0].observedAt, 200);
  assert.equal(alerts[0].read, false);
  assert.deepEqual(watch.observe(snapshot([rec('b')])), []);
  assert.deepEqual(watch.observe(snapshot([rec('a'), rec('b')])), []);
});

test('out-of-area and unstable records never alert and movements do not become events', () => {
  const watch = createWatchlist();
  watch.add(input);
  watch.observe(snapshot([rec('a', { longitude: 30 })]));
  assert.deepEqual(watch.observe(snapshot([rec('a'), rec(undefined), rec('out', { longitude: 30 }), rec('invalid', { latitude: null })])), []);
});

test('compact loaded-fleet IDs suppress moving known targets while new visible records alert', () => {
  const watch = createWatchlist();
  watch.add(input);
  watch.observe(snapshot([], { knownRecordIds: ['outside'] }));
  assert.deepEqual(watch.observe(snapshot([rec('outside')], { knownRecordIds: ['outside'] })), []);
  const additions = watch.observe(snapshot([rec('outside'), rec('new')], { knownRecordIds: ['outside', 'new'] }));
  assert.equal(additions.length, 1);
  assert.equal(additions[0].recordId, 'new');
});

test('truncated loaded-fleet identity sets reset comparison rather than misreporting movement', () => {
  const watch = createWatchlist();
  watch.add(input);
  watch.observe(snapshot([], { knownRecordIds: ['outside'] }));
  assert.deepEqual(watch.observe(snapshot([rec('new')], { knownRecordIdsTruncated: true })), []);
  assert.deepEqual(watch.observe(snapshot([rec('new')], { knownRecordIds: ['new'] })), []);
});

test('unloaded, failed, stale and disabled layers reset baseline without false recovery alerts', () => {
  for (const extra of [{ status: 'error' }, { enabled: false }, { status: 'loading' }, { status: 'stale' }, { records: null }, { error: 'failed' }, { truncated: true }]) {
    const watch = createWatchlist();
    watch.add(input);
    watch.observe(snapshot([rec('a')]));
    assert.deepEqual(watch.observe(snapshot([], extra)), []);
    assert.deepEqual(watch.observe(snapshot([rec('a'), rec('old')])), []);
    assert.equal(watch.observe(snapshot([rec('a'), rec('old'), rec('new')])).length, 1);
  }
});

test('missing default storage is an explicit memory-only persistence state', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
  try {
    const watch = createWatchlist();
    assert.equal(watch.getState().storageError, 'WATCH_STORAGE_UNAVAILABLE');
    watch.add(input);
    assert.equal(watch.getState().storageError, 'WATCH_STORAGE_UNAVAILABLE');
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});

test('persisted area IDs and duplicate snapshot record IDs are validated', () => {
  const watch = createWatchlist({ storage: { getItem: () => JSON.stringify({ version: 1, areas: [{ ...input, createdAt: 1, enabled: true }], alerts: [], baselines: [] }), setItem() {} } });
  assert.equal(watch.getState().areas.length, 0);
  watch.add(input);
  watch.observe(snapshot([]));
  assert.equal(watch.observe(snapshot([rec('a'), rec('a')])).length, 1);
});

test('saturated baselines stop comparing rather than repeatedly alerting on evicted IDs', () => {
  const watch = createWatchlist();
  watch.add(input);
  watch.observe(snapshot([]));
  const large = Array.from({ length: 50001 }, (_, i) => rec(String(i)));
  assert.deepEqual(watch.observe(snapshot(large)), []);
  assert.deepEqual(watch.observe(snapshot([rec('50000'), rec('new')])), []);
});

test('source changes, missing layers and camera coverage changes establish fresh baselines', () => {
  const watch = createWatchlist();
  watch.add(input);
  watch.observe(snapshot([]));
  assert.deepEqual(watch.observe(snapshot([rec('old')], { source: 'Other' })), []);
  watch.observe({ ...snapshot(), layers: [] });
  assert.deepEqual(watch.observe(snapshot([rec('old'), rec('old2')])), []);
  watch.observe({ ...snapshot([rec('old')]), bounds: { west: 20, east: 30, south: 20, north: 30 } });
  assert.deepEqual(watch.observe(snapshot([rec('old'), rec('old2'), rec('old3')])), []);
});

test('local storage persists areas, alerts, and deduplication baselines across reload', () => {
  const store = storage();
  const watch = createWatchlist({ storage: store });
  watch.add(input);
  watch.observe(snapshot([]));
  watch.observe(snapshot([rec('a')]));
  const restored = createWatchlist({ storage: store });
  assert.equal(restored.getState().areas.length, 1);
  assert.equal(restored.getState().alerts.length, 1);
  assert.deepEqual(restored.observe(snapshot([rec('a')])), []);
  assert.equal(restored.observe(snapshot([rec('a'), rec('b')])).length, 1);
});

test('pause and delete clear related alerts and resume uses a new baseline', () => {
  const watch = createWatchlist();
  const area = watch.add(input);
  watch.observe(snapshot([]));
  watch.observe(snapshot([rec('a')]));
  assert.equal(watch.toggle(area.id, false), true);
  assert.equal(watch.getState().alerts.length, 0);
  assert.deepEqual(watch.observe(snapshot([rec('b')])), []);
  assert.equal(watch.toggle(area.id), true);
  assert.deepEqual(watch.observe(snapshot([rec('a'), rec('b')])), []);
  watch.observe(snapshot([rec('a'), rec('b'), rec('c')]));
  assert.equal(watch.remove(area.id), true);
  assert.equal(watch.getState().areas.length, 0);
  assert.equal(watch.getState().alerts.length, 0);
  assert.equal(watch.remove(area.id), false);
});

test('rename, read, and clearing return immutable state and publish notifications', () => {
  const changes = [];
  const watch = createWatchlist({ onChange: (state) => changes.push(state) });
  const area = watch.add(input);
  watch.observe(snapshot([]));
  watch.observe(snapshot([rec('a'), rec('b', { simulated: true })]));
  assert.equal(watch.rename(area.id, 'Renamed'), true);
  assert.equal(watch.getState().alerts[0].areaName, 'Renamed');
  const stale = watch.getState();
  stale.areas[0].bounds.west = 99;
  stale.alerts[0].name = 'modified';
  assert.equal(watch.getState().areas[0].bounds.west, -10);
  assert.notEqual(watch.getState().alerts[0].name, 'modified');
  watch.markRead(watch.getState().alerts[0].id);
  assert.equal(watch.getState().alerts.filter((a) => a.read).length, 1);
  watch.markRead();
  assert.ok(watch.getState().alerts.every((a) => a.read));
  watch.clearAlerts(area.id);
  assert.equal(watch.getState().alerts.length, 0);
  watch.clearAlerts();
  assert.ok(changes.length >= 7);
  assert.equal(watch.rename('missing', 'Name'), false);
  assert.equal(watch.toggle('missing'), false);
});

test('input validation and watch/alert limits are enforced', () => {
  const watch = createWatchlist({ now: () => 1 });
  for (const item of [null, { ...input, name: '' }, { ...input, bounds: {} }, { ...input, layerIds: [] }, { ...input, layerIds: ['../bad'] }]) assert.throws(() => watch.add(item));
  const area = watch.add(input);
  assert.throws(() => watch.rename(area.id, ' '));
  for (let i = 1; i < 10; i++) watch.add({ ...input, name: `area ${i}` });
  assert.throws(() => watch.add(input), { code: 'WATCH_LIMIT' });
  watch.observe(snapshot([]));
  watch.observe(snapshot(Array.from({ length: 110 }, (_, i) => rec(String(i)))));
  assert.equal(watch.getState().alerts.length, 100);
  assert.equal(new Set(watch.getState().areas.map((a) => a.id)).size, 10);
});

test('corrupt or unavailable storage cannot crash monitoring and exposes persistence failure', () => {
  for (const text of ['{bad', JSON.stringify({ version: 99, areas: [] }), JSON.stringify({ version: 1, areas: [null, input], alerts: [{}], baselines: {} })]) {
    const watch = createWatchlist({ storage: { getItem: () => text, setItem() {} } });
    assert.equal(watch.getState().areas.length, 0);
  }
  const watch = createWatchlist({ storage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } } });
  assert.equal(watch.getState().storageError, 'WATCH_STORAGE_UNAVAILABLE');
  watch.add(input);
  assert.equal(watch.getState().areas.length, 1);
  assert.equal(watch.getState().storageError, 'WATCH_STORAGE_UNAVAILABLE');
});

test('global layer coverage permits watches outside current view without pretending global monitoring', () => {
  const watch = createWatchlist();
  watch.add(input);
  const layerExtra = { coverageBounds: { west: -180, east: 180, south: -90, north: 90 } };
  const away = { west: 20, east: 30, south: 20, north: 30 };
  watch.observe({ ...snapshot([], layerExtra), bounds: away });
  const alerts = watch.observe({ ...snapshot([rec('a')], layerExtra), bounds: away });
  assert.equal(alerts.length, 1);
  assert.deepEqual(watch.observe(null), []);
});

test('rule-based watches gate alerts by count and sustained duration', () => {
  const watch = createWatchlist({ now: () => 1000 });
  const area = watch.add({ ...input, rules: { countThreshold: 2, sustainedMs: 1000 } });
  watch.observe(snapshot([], { generatedAt: 1000 }));
  assert.deepEqual(watch.observe(snapshot([rec('a')], { generatedAt: 1500 })), []);
  assert.deepEqual(watch.observe(snapshot([rec('a'), rec('b')], { generatedAt: 1800 })), []);
  const alerts = watch.observe(snapshot([rec('a'), rec('b'), rec('c')], { generatedAt: 2800 }));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].areaId, area.id);
  assert.equal(watch.observe(snapshot([rec('a'), rec('b'), rec('c'), rec('d')], { generatedAt: 2300 })).length, 0);
});

test('category rules and quiet hours suppress notifications while retaining the baseline', () => {
  // Quiet-hour rules are evaluated in the operator's local clock. Construct
  // fixtures with the local Date constructor so this regression stays valid
  // on runners whose system timezone differs from the developer machine.
  const quietStart = new Date(2024, 0, 1, 21).getTime();
  const quietObservation = new Date(2024, 0, 1, 22).getTime();
  const nextObservation = new Date(2024, 0, 2, 1).getTime();
  const watch = createWatchlist({ now: () => quietStart });
  watch.add({ ...input, rules: { categories: ['military'], quietHours: { start: 21, end: 23 } } });
  watch.observe(snapshot([], { generatedAt: new Date(2024, 0, 1, 20).getTime() }));
  assert.deepEqual(watch.observe(snapshot([rec('a', { category: 'military' })], { generatedAt: quietObservation })), []);
  assert.deepEqual(watch.observe(snapshot([rec('a', { category: 'military' }), rec('b', { category: 'civilian' })], { generatedAt: nextObservation })), []);
  assert.equal(watch.getState().alerts.length, 0);
});

test('alerts can be marked processed with an immutable operator note', () => {
  const watch = createWatchlist();
  const area = watch.add(input);
  watch.observe(snapshot([])); watch.observe(snapshot([rec('a')]));
  const alert = watch.getState().alerts[0];
  assert.equal(watch.markProcessed(alert.id, '已核实'), true);
  assert.equal(watch.getState().alerts[0].processed, true);
  assert.equal(watch.getState().alerts[0].note, '已核实');
  assert.equal(watch.markProcessed('missing'), false);
  assert.equal(watch.updateRules(area.id, { countThreshold: 2 }), true);
});
