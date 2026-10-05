import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapWorkspace } from './mapWorkspace.js';
import { createWatchlist } from './watchlist.js';

function fixture() {
  const calls = [];
  const layers = [{ id: 'flights', name: 'Flights', source: 'OpenSky', enabled: true, stats: { lastUpdate: 1000, count: 99 } }];
  const records = [{ id: 'CALLSIGN', icao24: 'abc123', callsign: 'Flight A', lat: 1, lon: 2 }];
  const camera = { positionWC: { x: 1, y: 2, z: 3 }, heading: 0.1, pitch: -0.5, roll: 0,
    computeViewRectangle: () => ({ west: 0, south: 0, east: Math.PI / 2, north: Math.PI / 4 }),
    setView: (view) => calls.push(view) };
  const styleManager = { activeStyle: 'normal', runImmediateNavigation: (_name, fn) => { fn(); return true; } };
  const dataManager = { getAll: () => layers, isEnabled: () => true,
    layers: new Map([['flights', { module: { getAnalystRecords: () => records } }]]) };
  const runAction = async (name, args) => { calls.push([name, args]); return { ok: true }; };
  return { calls, layers, records, camera, styleManager, dataManager,
    workspace: createMapWorkspace({ viewer: { camera, scene: { globe: {} } }, styleManager, dataManager, runAction, now: () => 2000 }) };
}

test('snapshot uses bounded loaded records, stable identities and source timestamps', () => {
  const f = fixture();
  const snapshot = f.workspace.getSnapshot();
  assert.equal(snapshot.bounds.east, 90);
  assert.equal(snapshot.generatedAt, 2000);
  assert.equal(snapshot.layers[0].records[0].id, 'abc123');
  assert.equal(snapshot.layers[0].updatedAt, 1000);
  assert.equal(snapshot.layers[0].source, 'OpenSky');
  assert.equal(snapshot.layers[0].records.length, 1);
  assert.equal(snapshot.layers[0].status, 'ready');
});

test('normalized manager faults and lifecycle states cannot masquerade as ready', () => {
  for (const extra of [{ managerRefreshError: 'failed' }, { lastError: 'failed' }, { available: false }, { unavailable: true }, { status: 'unavailable' }, { status: 'source-unavailable' }, { status: 'offline' }, { status: 'degraded' }]) {
    const f = fixture();
    f.layers[0].stats = extra;
    assert.notEqual(f.workspace.getSnapshot().layers[0].status, 'ready');
    assert.equal(f.workspace.getSnapshot().layers[0].records.length, 0);
  }
  for (const phase of ['enabling', 'disabling']) {
    const f = fixture();
    f.layers[0].lifecycleState = phase;
    assert.equal(f.workspace.getSnapshot().layers[0].status, 'loading');
  }
});

test('record mapper preserves own source, aliases, numeric IDs and simulation modes', () => {
  const f = fixture();
  f.records.splice(0, 1, { id: 42, name: 'A', latitude: 3, longitude: 4, source: 'Record source', updatedAt: '2026-09-07T00:00:00Z', eventAt: 900 });
  f.layers[0].stats.mode = 'sim';
  const record = f.workspace.getSnapshot().layers[0].records[0];
  assert.equal(record.id, '42');
  assert.equal(record.latitude, 3);
  assert.equal(record.longitude, 4);
  assert.equal(record.source, 'Record source');
  assert.equal(record.updatedAt, Date.parse('2026-09-07T00:00:00Z'));
  assert.equal(record.simulated, true);
});

test('FIRMS array indexes never define event identity and acquisition time is retained', () => {
  const f = fixture();
  f.layers[0].id = 'local-firms';
  f.dataManager.layers.set('local-firms', { module: { getAnalystRecords: () => f.records } });
  f.records.splice(0, 1, { id: 'FIRE-00000', lat: 1, lon: 2, acqTime: 1000, satellite: 'NOAA20' });
  const first = f.workspace.getSnapshot().layers[0].records[0];
  f.records[0].id = 'FIRE-00099';
  const second = f.workspace.getSnapshot().layers[0].records[0];
  assert.equal(first.id, second.id);
  assert.equal(first.eventAt, 1000);
  f.records[0].acqTime = 2000;
  assert.notEqual(f.workspace.getSnapshot().layers[0].records[0].id, first.id);
  f.records[0].acqTime = null;
  assert.equal(f.workspace.getSnapshot().layers[0].records[0].id, null);
});

test('missing USGS identity uses stable time and coordinates, not index or label', () => {
  const f = fixture();
  f.layers[0].id = 'earthquakes';
  f.dataManager.layers.set('earthquakes', { module: { getAnalystRecords: () => f.records } });
  f.records.splice(0, 1, { id: 'QUAKE-0001', lat: 1, lon: 2, timeMs: 1000 });
  const first = f.workspace.getSnapshot().layers[0].records[0].id;
  f.records[0].id = 'QUAKE-0020';
  assert.equal(f.workspace.getSnapshot().layers[0].records[0].id, first);
  f.records[0].timeMs = null;
  assert.equal(f.workspace.getSnapshot().layers[0].records[0].id, null);
  f.records[0].id = 'usgs-event';
  assert.equal(f.workspace.getSnapshot().layers[0].records[0].id, 'usgs-event');
});

test('record caps detect overflow without mislabeling an exact-sized complete feed', () => {
  const f = fixture();
  f.records.splice(0, 1, ...Array.from({ length: 2000 }, (_, id) => ({ id, lat: 1, lon: 2 })));
  assert.equal(f.workspace.getSnapshot().layers[0].truncated, false);
  f.records.push({ id: 2001, lat: 1, lon: 2 });
  assert.equal(f.workspace.getSnapshot().layers[0].truncated, true);
  assert.equal(f.workspace.getSnapshot().layers[0].records.length, 2000);
});

test('reader failures, invalid records and unavailable camera rectangles are contained', () => {
  const f = fixture();
  f.dataManager.layers.get('flights').module.getAnalystRecords = () => { throw new Error('private source URL'); };
  assert.equal(f.workspace.getSnapshot().layers[0].error, 'source-unavailable');
  f.dataManager.layers.get('flights').module.getAnalystRecords = () => null;
  assert.equal(f.workspace.getSnapshot().layers[0].status, 'error');
  f.dataManager.layers.get('flights').module.getAnalystRecords = () => [null, 1, {}, { id: 'a', lat: 1, lon: 2 }];
  assert.equal(f.workspace.getSnapshot().layers[0].status, 'ready');
  assert.equal(f.workspace.getSnapshot().layers[0].records.length, 1);
  f.camera.computeViewRectangle = () => { throw new Error('destroyed'); };
  assert.equal(f.workspace.getSnapshot().bounds, null);
});

test('a regional query filters the whole loaded fleet before capping output', () => {
  const f = fixture();
  f.records.splice(0, 1, ...Array.from({ length: 5000 }, (_, id) => ({ id: String(id), lat: -45, lon: -120 })), { id: 'visible', lat: 1, lon: 2 });
  const layer = f.workspace.getSnapshot().layers[0];
  assert.equal(layer.records.length, 1);
  assert.equal(layer.records[0].id, 'visible');
  assert.equal(layer.truncated, false);
  assert.ok(layer.knownRecordIds.includes('0'));
  assert.ok(layer.knownRecordIds.includes('visible'));
});

test('region filtering honors the antimeridian and read bounds remain finite', () => {
  const f = fixture();
  let requested;
  f.dataManager.layers.get('flights').module.getAnalystRecords = (limit) => { requested = limit; return [{ id: 'west', lat: 0, lon: 175 }, { id: 'east', lat: 0, lon: -175 }, { id: 'outside', lat: 0, lon: 0 }]; };
  f.camera.computeViewRectangle = () => ({ west: 170 * Math.PI / 180, east: -170 * Math.PI / 180, south: -0.1, north: 0.1 });
  const layer = f.workspace.getSnapshot().layers[0];
  assert.deepEqual(layer.records.map((record) => record.id), ['west', 'east']);
  assert.ok(Number.isFinite(requested));
  assert.ok(requested > 2000);
});

test('capturing busy map transitions fails before an undo history entry can be created', () => {
  const f = fixture();
  f.layers[0].lifecycleUncertain = true;
  assert.throws(() => f.workspace.captureState('set_layer_visibility', { layerId: 'flights' }));
  f.layers[0].lifecycleUncertain = false;
  f.styleManager.getContextModeState = () => ({ changing: true });
  assert.throws(() => f.workspace.captureState('set_layer_visibility', { layerId: 'flights' }));
  assert.equal(f.workspace.captureState('set_visual_style', {}).style, 'normal');
});

test('style undo restores preset-controlled parameters without reverting map source or scope', async () => {
  const f = fixture();
  const visual = { style: 'thermal', bloom: { enabled: true, intensity: 2 }, sharpen: { enabled: false }, hud: { visible: true }, detection: { mode: 'OFF' }, styleParams: { thermal: { gain: 3 } }, mapStack: 'osm', scope: { enabled: false } };
  f.styleManager.getVisualState = () => visual;
  let restored;
  f.styleManager.applyVisualState = async (state) => { restored = state; return true; };
  const before = f.workspace.captureState('set_visual_style', {});
  visual.bloom.intensity = 9;
  assert.equal((await f.workspace.restoreState(before, 'set_visual_style', {})).ok, true);
  assert.equal(restored.bloom.intensity, 2);
  assert.equal(restored.styleParams.thermal.gain, 3);
  assert.equal(restored.mapStack, undefined);
  assert.equal(restored.scope, undefined);
  f.styleManager.applyVisualState = async () => false;
  assert.equal((await f.workspace.restoreState(before, 'set_visual_style', {})).ok, false);
});

test('Context-coupled undo restores mode and complete layer visibility through coordinator APIs', async () => {
  const f = fixture();
  f.layers.push({ id: 'rocket-launches', enabled: false, stats: {} }, { id: 'satellites', enabled: false, stats: {} });
  let mode = null;
  f.styleManager.getContextModeState = () => ({ mode, changing: false });
  f.styleManager.setContextMode = async (next) => { mode = next; f.calls.push(['context', next]); return { ok: true }; };
  f.styleManager._waitForContextLayerSettlement = async () => { f.calls.push('settled'); };
  f.dataManager.restoreEnabledLayerIds = async (ids, options) => { f.calls.push(['layers', [...ids], options.origin]); };
  const snapshot = f.workspace.captureState('set_layer_visibility', { layerId: 'rocket-launches' });
  f.layers[0].enabled = false;
  f.layers[1].enabled = true;
  mode = 'space-missions';
  assert.equal((await f.workspace.restoreState(snapshot, 'set_layer_visibility', { layerId: 'rocket-launches' })).ok, true);
  assert.deepEqual(f.calls.find((call) => call[0] === 'context'), ['context', null]);
  assert.deepEqual(f.calls.find((call) => call[0] === 'layers'), ['layers', ['flights'], 'context-restore']);
  assert.equal(mode, null);
  assert.ok(f.calls.includes('settled'));
});

test('undo refuses invalid camera snapshots or unavailable required coordinators', async () => {
  const f = fixture();
  assert.equal((await f.workspace.restoreState({ camera: { position: { x: NaN, y: 2, z: 3 } } }, 'fly_to_location', {})).ok, false);
  assert.equal((await f.workspace.restoreState(null, 'fly_to_location', {})).ok, false);
  assert.equal((await f.workspace.restoreState({}, 'unknown', {})).ok, false);
  const before = f.workspace.captureState('set_layer_visibility', { layerId: 'flights' });
  f.styleManager.runImmediateNavigation = undefined;
  assert.equal((await f.workspace.restoreState(before, 'set_layer_visibility', { layerId: 'flights' })).ok, false);
});

test('unobserved empty feeds and non-ready guidance remain unknown instead of zero evidence', () => {
  const f = fixture();
  f.records.length = 0;
  f.layers[0].stats = { count: 0, lastUpdate: null };
  assert.equal(f.workspace.getSnapshot().layers[0].status, 'unknown');
  f.layers[0].stats.lastUpdate = 100;
  assert.equal(f.workspace.getSnapshot().layers[0].status, 'ready');
  for (const status of ['unknown', 'idle', 'zoom-in']) {
    f.layers[0].stats.status = status;
    assert.equal(f.workspace.getSnapshot().layers[0].status, 'unknown');
  }
  f.layers[0].stats.status = 503;
  assert.equal(f.workspace.getSnapshot().layers[0].status, 'error');
});

test('source data integration does not alert on reordered fire indexes, only new observations', () => {
  const f = fixture();
  f.layers[0].id = 'local-firms';
  f.dataManager.layers.set('local-firms', { module: { getAnalystRecords: () => f.records } });
  f.records.splice(0, 1, { id: 'FIRE-00000', lat: 1, lon: 2, acqTime: 1000 });
  const watch = createWatchlist({ storage: null });
  watch.add({ name: 'Fires', bounds: { west: 0, south: 0, east: 5, north: 5 }, layerIds: ['local-firms'] });
  watch.observe(f.workspace.getSnapshot());
  f.records[0].id = 'FIRE-00400';
  assert.deepEqual(watch.observe(f.workspace.getSnapshot()), []);
  f.records.push({ id: 'FIRE-00000', lat: 2, lon: 3, acqTime: 2000 });
  const alerts = watch.observe(f.workspace.getSnapshot());
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].eventAt, 2000);
});

test('style undo restores the celestial ring through its public control without camera focus', async () => {
  const f = fixture();
  f.styleManager.celestialRingEnabled = true;
  f.styleManager.setCelestialRingEnabled = (enabled, options) => { f.calls.push(['ring', enabled, options]); return { ok: true }; };
  const before = f.workspace.captureState('set_visual_style', {});
  f.styleManager.celestialRingEnabled = false;
  assert.equal((await f.workspace.restoreState(before, 'set_visual_style', {})).ok, true);
  assert.deepEqual(f.calls.at(-1), ['ring', true, { focus: false }]);
});

test('Context undo retains history failure on coordinator rejection or missing APIs', async () => {
  const f = fixture();
  f.styleManager.getContextModeState = () => ({ mode: 'flights', active: true });
  const before = f.workspace.captureState('set_layer_visibility', { layerId: 'flights' });
  assert.equal((await f.workspace.restoreState(before, 'set_layer_visibility', { layerId: 'flights' })).ok, false);
  f.styleManager.setContextMode = async () => ({ ok: false });
  f.dataManager.restoreEnabledLayerIds = async () => { throw new Error('must not restore on context failure'); };
  assert.equal((await f.workspace.restoreState(before, 'set_layer_visibility', { layerId: 'flights' })).ok, false);
  f.styleManager.setContextMode = async () => ({ ok: true });
  await assert.rejects(f.workspace.restoreState(before, 'set_layer_visibility', { layerId: 'flights' }));
});

test('snapshot distinguishes missing reader, stale and disabled sources from empty results', () => {
  const f = fixture();
  f.layers.push({ id: 'unknown', enabled: true, stats: { count: 50 } });
  f.layers[0].stats.stale = true;
  assert.equal(f.workspace.getSnapshot().layers[0].status, 'stale');
  assert.equal(f.workspace.getSnapshot().layers[1].status, 'unsupported');
  f.layers[0].enabled = false;
  assert.equal(f.workspace.getSnapshot().layers[0].status, 'disabled');
  f.camera.computeViewRectangle = () => undefined;
  assert.equal(f.workspace.getSnapshot().bounds, null);
});

test('camera undo restores position and orientation through navigation ownership', async () => {
  const f = fixture();
  const snapshot = f.workspace.captureState('fly_to_location', {});
  f.camera.positionWC.x = 8;
  assert.equal((await f.workspace.restoreState(snapshot, 'fly_to_location', {})).ok, true);
  assert.equal(f.calls[0].destination.x, 1);
  assert.equal(f.calls[0].orientation.pitch, -0.5);
  f.styleManager.runImmediateNavigation = () => false;
  assert.equal((await f.workspace.restoreState(snapshot, 'fly_to_location', {})).ok, false);
});

test('style and layer undo use existing map actions without affecting unrelated layers', async () => {
  const f = fixture();
  const style = f.workspace.captureState('set_visual_style', {});
  await f.workspace.restoreState(style, 'set_visual_style', {});
  assert.deepEqual(f.calls[0], ['set_visual_style', { style: 'normal' }]);
  const layer = f.workspace.captureState('set_layer_visibility', { layerId: 'flights' });
  await f.workspace.restoreState(layer, 'set_layer_visibility', { layerId: 'flights' });
  assert.deepEqual(f.calls[1], ['set_layer_visibility', { layerId: 'flights', enabled: true }]);
  assert.throws(() => f.workspace.captureState('untrusted_action', {}));
});

test('vision detections are drawn as bounded world-anchor requests and replace only prior vision marks', async () => {
  const calls = [];
  const annotations = {
    snapshot: () => [{ id: 'manual', source: 'manual' }, { id: 'old', source: 'vision' }],
    restore: async (saved) => { calls.push(['restore', saved]); return true; },
    annotate: async (specs, options) => { calls.push(['annotate', specs, options]); return { ok: true, drawn: specs.length, ids: ['vision-1'] }; },
  };
  const f = fixture();
  const workspace = createMapWorkspace({ viewer: { camera: f.camera, scene: { globe: {} } }, styleManager: f.styleManager, dataManager: f.dataManager, runAction: f.runAction, annotations });
  const output = await workspace.drawVisionDetections({ image: { width: 100, height: 100 }, detections: [
    { class: 'plane', confidence: 0.9, box: { x: 10, y: 20, width: 20, height: 20 } },
  ] }, { width: 100, height: 100 });
  assert.equal(output.ok, true);
  assert.equal(calls[0][0], 'restore');
  assert.deepEqual(calls[0][1], [{ id: 'manual', source: 'manual' }]);
  assert.equal(calls[1][0], 'annotate');
  assert.equal(calls[1][1][0].source, 'vision');
  assert.equal(calls[1][1][0].screenX, 0.2);
  assert.equal(calls[1][1][0].screenY, 0.3);
});
