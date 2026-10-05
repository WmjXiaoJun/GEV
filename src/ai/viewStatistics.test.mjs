import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewStatisticsRunner, getViewStatistics, readViewSnapshot, flattenViewportRecords, getViewportRecordPage, getViewportRecords, viewportRecordsToCsv } from './viewStatistics.js';
import { validToolCall } from './tools.js';

const bounds = { west: -10, south: -10, east: 10, north: 10 };
const viewport = { available: true, width: 1000, height: 700, method: 'camera-frustum-and-ellipsoid', geometry: 'record-anchor', reason: null };
const layer = (id = 'local-datacenters', count = 2301) => ({
  id, name: id, enabled: true, status: 'ready', source: 'Local', updatedAt: 100, count,
  countIsLowerBound: false, simulatedCount: 0,
  breakdown: { usage: { values: [], unknownCount: count, otherCount: 0, otherCategoryCount: 0 } },
  records: Array.from({ length: 5 }, (_, index) => ({ id: String(index), name: `DC ${index}`, latitude: 0, longitude: 0 })),
});
const snapshot = (layers = [layer()]) => ({ scope: 'viewport', viewport, bounds, generatedAt: 200, layers });

test('viewport record page filters, sorts and paginates loaded records deterministically', () => {
  const input = snapshot([{ ...layer('flights', 3), records: [
    { id: 'b', name: 'Zulu', type: 'cargo', latitude: 1, longitude: 2 },
    { id: 'a', name: 'Alpha', type: 'passenger', latitude: 3, longitude: 4, country: 'CN' },
    { id: 'c', name: 'Bravo', type: 'cargo', latitude: 5, longitude: 6 },
  ] }, { ...layer('disabled', 1), enabled: false, records: [{ id: 'hidden', name: 'Hidden' }] }]);
  assert.equal(flattenViewportRecords(input).length, 3);
  const first = getViewportRecordPage(input, { sortBy: 'name', pageSize: 2 });
  assert.deepEqual(first.records.map((record) => record.id), ['a', 'c']);
  assert.equal(first.total, 3); assert.equal(first.pageCount, 2); assert.equal(first.hasNext, true);
  const second = getViewportRecordPage(input, { query: 'cargo', sortBy: 'id', sortDir: 'desc', page: 2, pageSize: 1 });
  assert.deepEqual(second.records.map((record) => record.id), ['b']);
  assert.equal(getViewportRecordPage(input, { layerId: 'disabled' }).total, 0);
});

test('viewport CSV escapes cells and excludes non-record data', () => {
  const records = flattenViewportRecords(snapshot([{ ...layer('flights', 1), records: [{ id: '1', name: 'A, "quoted"', latitude: 0, longitude: 1 }] }]));
  const csv = viewportRecordsToCsv(records);
  assert.match(csv, /^layerName,id,name,type/);
  assert.match(csv, /"A, ""quoted"""/);
  assert.equal(csv.includes('apiKey'), false);
});

test('CSV neutralizes formula-like cells before spreadsheet evaluation', () => {
  const records = flattenViewportRecords(snapshot([{ ...layer('flights', 4), records: [
    { id: '=1+1', name: '+SUM(A1:A2)', type: '-danger', category: '@cmd', latitude: 0, longitude: 1 },
  ] }]));
  const csv = viewportRecordsToCsv(records);
  assert.match(csv, /,'?\'=1\+1/);
  assert.ok(csv.includes("'+SUM(A1:A2)"));
  assert.ok(csv.includes("'-danger"));
  assert.ok(csv.includes("'@cmd"));
});

test('complete viewport export returns all filtered records, not only the first page', () => {
  const input = snapshot([{ ...layer('flights', 401), records: Array.from({ length: 401 }, (_, i) => ({ id: String(i), name: `Flight ${i}`, latitude: 0, longitude: 0 })) }]);
  const all = getViewportRecords(input, { layerId: 'flights' });
  assert.equal(all.length, 401);
  assert.equal(getViewportRecordPage(input, { layerId: 'flights', pageSize: 200 }).records.length, 200);
});

test('statistics tool validates bounded samples and layer allowlist', () => {
  const call = (args) => validToolCall({ id: 'stat', name: 'get_view_statistics', arguments: args });
  for (const args of [{}, { layerId: 'all', limit: 12 }, { layerId: 'local-datacenters', limit: 1 }]) assert.equal(call(args), true);
  for (const args of [{ limit: 0 }, { limit: 13 }, { limit: 1.5 }, { layerId: 'private' }, { count: 4 }]) assert.equal(call(args), false);
});

test('LLM drawing tools accept bounded marks and reject unsafe or incomplete shapes', () => {
  assert.equal(validToolCall({ id: 'draw', name: 'annotate_map', arguments: {
    annotations: [{ type: 'pin', target: 'Austin', color: 'cyan' }], persist: true,
  } }), true);
  assert.equal(validToolCall({ id: 'draw', name: 'annotate_map', arguments: {
    annotations: [{ type: 'route', points: [{ target: 'A' }, { latitude: 30, longitude: -97 }] }],
  } }), true);
  assert.equal(validToolCall({ id: 'draw', name: 'annotate_map', arguments: {
    annotations: [{ type: 'pin', latitude: 30, longitude: -97, script: 'alert(1)' }],
  } }), false);
  assert.equal(validToolCall({ id: 'draw', name: 'annotate_map', arguments: {
    annotations: [{ type: 'arrow', target: 'Austin' }],
  } }), false);
  assert.equal(validToolCall({ id: 'clear', name: 'clear_annotations', arguments: {} }), true);
  assert.equal(validToolCall({ id: 'area', name: 'annotate_map', arguments: {
    annotations: [{ type: 'area', ring: [[-97.8, 30.2], [-97.7, 30.2], [-97.7, 30.3]], label: '区域' }],
  } }), true);
  assert.equal(validToolCall({ id: 'bad-area', name: 'annotate_map', arguments: {
    annotations: [{ type: 'area', ring: [[-97.8, 30.2], [999, 30.2], [-97.7, 30.3]] }],
  } }), false);
});

test('statistics keep exact viewport totals independent of sample limit and filter before briefing', async () => {
  const original = snapshot([...Array.from({ length: 40 }, (_, index) => layer(`other-${index}`, 10)), layer()]);
  const before = structuredClone(original);
  const result = await getViewStatistics({ getViewSnapshot: () => original }, { layerId: 'local-datacenters', limit: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'get_view_statistics');
  assert.equal(result.scope, 'viewport-loaded-data-only');
  assert.equal(result.totalCount, 2301);
  assert.equal(result.layers.length, 1);
  assert.equal(result.layers[0].count, 2301);
  assert.equal(result.layers[0].sample.length, 2);
  assert.equal(result.layers[0].breakdown.usage.unknownCount, 2301);
  assert.deepEqual(original, before);
  assert.ok(JSON.stringify(result).length < 16000);
});

test('explicit flight statistics list all identities up to the requested limit with truthful omitted totals', async () => {
  const flights = (count) => ({
    ...layer('flights', count),
    records: Array.from({ length: count }, (_, index) => ({
      id: `icao-${index}`, name: `CCA${100 + index}`, type: 'flights', latitude: 0, longitude: 0,
    })),
  });
  for (const count of [0, 6, 12, 15]) {
    const original = snapshot([flights(count)]);
    const before = structuredClone(original);
    const result = await getViewStatistics({ getViewSnapshot: () => original }, { layerId: 'flights', limit: 12 });
    const detail = result.layers[0];
    assert.equal(result.totalCount, count);
    assert.equal(detail.sample.length, Math.min(count, 12));
    assert.equal(detail.sampleCount, Math.min(count, 12));
    assert.equal(detail.omittedRecordCount, Math.max(0, count - 12));
    assert.deepEqual(detail.sample.map((entry) => entry.name), flights(count).records.slice(0, 12).map((entry) => entry.name));
    assert.deepEqual(original, before);
  }
});

test('statistics omitted identities track smaller limits, unavailable feeds and context compaction', async () => {
  const source = { ...layer('flights', 12), records: Array.from({ length: 12 }, (_, index) => ({ id: String(index), name: `CCA${index}` })) };
  const workspace = { getViewSnapshot: () => snapshot([source]) };
  assert.equal((await getViewStatistics(workspace, { limit: 2 })).layers[0].omittedRecordCount, 10);
  assert.equal((await getViewStatistics(workspace)).layers[0].sampleCount, 5);
  const unavailable = await getViewStatistics({ getViewSnapshot: () => snapshot([{ ...source, status: 'loading', count: null }]) });
  assert.equal(unavailable.layers[0].sampleCount, 0);
  assert.equal(unavailable.layers[0].omittedRecordCount, null);
  const compacted = await getViewStatistics({ getViewSnapshot: () => snapshot(Array.from({ length: 32 }, (_, index) => ({ ...source, id: `layer-${index}` }))) }, { limit: 12 });
  for (const detail of compacted.layers) {
    assert.equal(detail.sampleCount, detail.sample.length);
    assert.equal(detail.omittedRecordCount, detail.count - detail.sampleCount);
  }
  assert.ok(JSON.stringify(compacted).length <= 16000);
});

test('multi-layer statistics preserve all short identity lists through context compaction', async () => {
  const sources = ['flights', 'military', 'ais-live-vessels', 'local-datacenters'].map((id) => ({
    ...layer(id, 12),
    records: Array.from({ length: 12 }, (_, index) => ({
      id: `${id}-${index}`, name: `Target ${index}`, type: id, latitude: 0, longitude: 0, simulated: index === 0,
    })),
  }));
  const original = snapshot(sources);
  const before = structuredClone(original);
  const result = await getViewStatistics({ getViewSnapshot: () => original }, { layerId: 'all', limit: 12 });
  assert.equal(result.totalCount, 48);
  assert.equal(result.layers.length, 4);
  for (const [index, detail] of result.layers.entries()) {
    assert.equal(detail.count, 12);
    assert.equal(detail.sampleCount, 12);
    assert.equal(detail.omittedRecordCount, 0);
    assert.deepEqual(detail.sample.map(({ id, name, type, simulated }) => ({ id, name, type, simulated })),
      sources[index].records.map(({ id, name, type, simulated }) => ({ id, name, type, simulated })));
    assert.equal(detail.breakdown.usage.unknownCount, 12);
  }
  assert.ok(JSON.stringify(result).length <= 16000);
  assert.deepEqual(original, before);
});

test('missing, failed and non-viewport readers fail closed without using geographic totals', async () => {
  for (const workspace of [null, {}, { getSnapshot: () => snapshot() }, { getViewSnapshot: () => { throw new Error('secret detail'); } },
    { getViewSnapshot: () => ({ ...snapshot(), scope: 'bounds' }) },
    { getViewSnapshot: () => ({ ...snapshot(), layers: null }) },
    { getViewSnapshot: () => ({ ...snapshot(), viewport: { ...viewport, width: 0 } }) },
    { getViewSnapshot: () => ({ ...snapshot(), viewport: { ...viewport, available: false } }) }]) {
    const result = await getViewStatistics(workspace);
    assert.equal(result.ok, false);
    assert.equal(result.available, false);
    assert.equal(result.totalCount, null);
    assert.deepEqual(result.layers, []);
    assert.equal(JSON.stringify(result).includes('secret detail'), false);
    assert.equal((await readViewSnapshot(workspace)).viewport.available, false);
  }
});

test('statistics reread the current camera and preserve disabled, empty and unavailable layers', async () => {
  let reads = 0;
  const workspace = { getViewSnapshot: () => snapshot([layer('local-datacenters', ++reads), { ...layer('flights'), enabled: false, status: 'disabled' }]) };
  assert.equal((await getViewStatistics(workspace)).layers[0].count, 1);
  assert.equal((await getViewStatistics(workspace)).layers[0].count, 2);
  const disabled = await getViewStatistics(workspace, { layerId: 'flights' });
  assert.equal(disabled.layers[0].count, null);
  assert.equal(disabled.layers[0].status, 'disabled');
  assert.equal((await getViewStatistics(workspace, { layerId: 'earthquakes' })).ok, false);
  assert.equal((await getViewStatistics({ getViewSnapshot: () => snapshot([layer('local-datacenters', 0)]) })).totalCount, 0);
});

test('targeted disabled or unsupported sources stay unavailable instead of reporting zero', async () => {
  for (const status of ['disabled', 'unsupported', 'error', 'loading', 'stale']) {
    const source = { ...layer(), status, enabled: status !== 'disabled', count: null };
    const result = await getViewStatistics({ getViewSnapshot: () => snapshot([source]) }, { layerId: 'local-datacenters' });
    assert.equal(result.ok, false, status);
    assert.equal(result.available, false, status);
    assert.equal(result.totalCount, null, status);
    assert.equal(result.layers[0].count, null, status);
    assert.equal(result.layers[0].status, status);
    assert.equal(result.layers[0].source, 'Local');
  }
  const empty = await getViewStatistics({ getViewSnapshot: () => snapshot([{ ...layer('local-datacenters', 0), records: [] }]) });
  assert.equal(empty.ok, true);
  assert.equal(empty.available, true);
  assert.equal(empty.totalCount, 0);
});

test('statistics retain lower-bound and partial coverage flags for mixed availability', async () => {
  const result = await getViewStatistics({ getViewSnapshot: () => snapshot([
    layer('local-datacenters', 9), { ...layer('earthquakes'), status: 'error', count: null },
  ]) });
  assert.equal(result.available, true);
  assert.equal(result.totalCount, 9);
  assert.equal(result.totalCountIsLowerBound, true);
  assert.equal(result.partialCoverage, true);
  assert.equal(result.layers[1].count, null);
});

test('AI boundary names loaded-layer totals and entity sample counts without mutating legacy results', async () => {
  const raw = { ok: true, count: 5, layers: [{ id: 'local-datacenters', count: 4362 }], scene: { enabledLayers: [{ id: 'local-datacenters', count: 4362 }] } };
  const before = structuredClone(raw);
  const runner = createViewStatisticsRunner({ runAction: async () => raw, workspace: { getViewSnapshot: () => snapshot() } });
  const view = await runner('get_current_view_state', {});
  assert.equal(view.layers[0].count, undefined);
  assert.equal(view.layers[0].loadedCount, 4362);
  assert.equal(view.layers[0].countScope, 'loaded-layer-total');
  const entity = await runner('get_entity_context', {});
  assert.equal(entity.count, undefined);
  assert.equal(entity.sampleCount, 5);
  assert.equal(entity.countScope, 'entity-sample');
  assert.equal(entity.scene.enabledLayers[0].loadedCount, 4362);
  assert.equal((await runner('get_view_statistics', { limit: 1 })).layers[0].sample.length, 1);
  assert.equal(await runner('set_visual_style', { style: 'normal' }), raw);
  assert.deepEqual(raw, before);
});

test('statistics runner does not read or forward invalid and cancelled requests', async () => {
  let called = 0;
  const runner = createViewStatisticsRunner({ runAction: async () => { called += 1; return null; }, workspace: { getViewSnapshot: () => { called += 1; return snapshot(); } } });
  assert.equal((await runner('get_view_statistics', { layerId: 'bad' })).ok, false);
  assert.equal((await runner('get_view_statistics', {}, { signal: AbortSignal.abort() })).cancelled, true);
  assert.equal((await runner('get_view_statistics', {}, { isCurrent: () => false })).cancelled, true);
  assert.equal(called, 0);
  assert.equal(await runner('get_current_view_state'), null);
});

test('statistics ignore a snapshot that finishes after its caller was cancelled', async () => {
  let finish;
  const controller = new AbortController();
  const runner = createViewStatisticsRunner({ runAction: async () => null, workspace: { getViewSnapshot: () => new Promise((resolve) => { finish = resolve; }) } });
  const request = runner('get_view_statistics', {}, { signal: controller.signal });
  controller.abort();
  finish(snapshot());
  assert.equal((await request).cancelled, true);
});
