import test from 'node:test';
import assert from 'node:assert/strict';
import { buildViewBrief, normalizeBounds, pointInBounds, boundsCover } from './intelligence.js';

const bounds = { west: -10, south: -10, east: 10, north: 10 };
const record = (id, extra = {}) => ({ id, name: id, latitude: 0, longitude: 0, ...extra });
const layer = (extra = {}) => ({ id: 'events', name: 'Events', enabled: true, status: 'ready', source: 'USGS', updatedAt: 100, records: [], ...extra });
const brief = (layers, extra = {}) => buildViewBrief({ bounds, generatedAt: 200, layers, ...extra });

test('brief counts only visible records and distinguishes data time from brief time', () => {
  const result = brief([layer({ records: [record('a', { eventAt: 50 }), record('b', { longitude: 40 }), record('c', { simulated: true })] })]);
  assert.equal(result.generatedAt, 200);
  assert.equal(result.scope, 'loaded-data-only');
  assert.equal(result.totalCount, 2);
  assert.equal(result.simulatedCount, 1);
  assert.equal(result.layers[0].lastUpdated, 100);
  assert.equal(result.layers[0].sample[0].eventAt, 50);
  assert.equal(result.layers[0].sample[0].source, 'USGS');
  assert.equal(result.layers[0].sample[0].updatedAt, null);
  assert.deepEqual(result.rows, result.layers);
  assert.equal(JSON.parse(result.context).scope, 'loaded-data-only');
});

test('dateline bounds include both sides and edge points but exclude middle longitudes', () => {
  const cross = { west: 170, east: -170, south: -5, north: 5 };
  const result = brief([layer({ records: [record('a', { longitude: 175 }), record('b', { longitude: -175 }), record('c'), record('d', { longitude: 170, latitude: 5 })] })], { bounds: cross });
  assert.equal(result.totalCount, 3);
  assert.equal(pointInBounds(cross, 0, 180), true);
  assert.equal(pointInBounds(cross, 0, -180), true);
});

test('disabled, missing, stale, loading, and failed feeds cannot imply zero events', () => {
  for (const extra of [{ enabled: false }, { status: 'loading' }, { status: 'unknown' }, { status: 'error', error: 'network' }, { status: 'stale' }, { records: undefined }, { error: 'network' }]) {
    const result = brief([layer(extra)]);
    assert.equal(result.layers[0].count, null);
    assert.equal(result.totalCount, 0);
  }
  assert.equal(brief([layer({ status: 'empty' })]).layers[0].count, 0);
});

test('unknown source and timestamps stay null, invalid coordinates never count', () => {
  const result = brief([layer({ source: undefined, updatedAt: undefined, records: [record('a', { eventAt: 'invalid' }), record('b', { latitude: null }), record('c', { latitude: 100 }), record('d', { longitude: '1' })] })]);
  assert.equal(result.totalCount, 1);
  assert.equal(result.layers[0].source, null);
  assert.equal(result.layers[0].lastUpdated, null);
  assert.equal(result.layers[0].sample[0].eventAt, null);
});

test('record source and valid ISO timestamps survive normalization', () => {
  const result = brief([layer({ updatedAt: '2026-09-07T00:00:00Z', records: [record(1, { source: 'Other', updatedAt: '2026-09-06T00:00:00Z', eventAt: 0 })] })]);
  assert.equal(result.layers[0].lastUpdated, Date.parse('2026-09-07T00:00:00Z'));
  assert.equal(result.layers[0].sample[0].source, 'Other');
  assert.equal(result.layers[0].sample[0].id, '1');
  assert.equal(result.layers[0].sample[0].eventAt, 0);
});

test('brief is bounded and immutable with malformed and large inputs', () => {
  const original = { bounds, layers: Array.from({ length: 100 }, (_, i) => layer({ id: String(i), name: 'a'.repeat(1000), source: 's'.repeat(1000), records: Array.from({ length: 20 }, (_, j) => record(String(j), { name: 'n'.repeat(1000) })) })) };
  const before = structuredClone(original);
  const result = buildViewBrief(original);
  assert.ok(result.layers.length <= 32);
  assert.ok(result.layers[0].sample.length <= 5);
  assert.ok(result.context.length <= 14000);
  assert.equal(result.layers[0].truncated, true);
  assert.deepEqual(original, before);
  assert.equal(buildViewBrief(null).bounds, null);
  assert.equal(buildViewBrief({ layers: [null, {}, layer()] }).layers.at(-1).count, null);
});

test('explicit sample limit can expose twelve identities without changing defaults or counts', () => {
  const original = { bounds, layers: [layer({ records: Array.from({ length: 15 }, (_, id) => record(String(id))) })] };
  const before = structuredClone(original);
  assert.equal(buildViewBrief(original).layers[0].sample.length, 5);
  for (const [sampleLimit, expected] of [[1, 1], [6, 6], [12, 12], [99, 12], [0, 5], [-1, 5], [1.5, 5], ['12', 5], [NaN, 5]]) {
    const result = buildViewBrief(original, { sampleLimit });
    assert.equal(result.layers[0].sample.length, expected);
    assert.equal(result.layers[0].count, 15);
    assert.equal(JSON.parse(result.context).layers[0].sample.length, expected);
    assert.ok(result.context.length <= 14000);
  }
  assert.deepEqual(original, before);
});

test('context is hard-capped even with maximum-length metadata and errors', () => {
  const result = brief(Array.from({ length: 32 }, (_, i) => layer({
    id: `${i}${'i'.repeat(80)}`, name: 'n'.repeat(160), source: 's'.repeat(120),
    records: [record('r'.repeat(160), { name: 'x'.repeat(160), source: 'z'.repeat(120), type: 't'.repeat(60) })],
  })));
  assert.ok(result.context.length <= 14000);
  assert.equal(JSON.parse(result.context).layers.length, 32);
  assert.equal(result.layers.length, 32);
});

test('oversized compact identities are reduced gradually without removing layer counts or breakdowns', () => {
  const layers = Array.from({ length: 8 }, (_, index) => viewportLayer({
    id: `layer-${index}`, count: 12,
    records: Array.from({ length: 12 }, (_, number) => record(`${index}-${number}-${'i'.repeat(160)}`, { name: `Name ${number} ${'n'.repeat(160)}` })),
  }));
  const result = buildViewBrief(viewportSnapshot(layers), { sampleLimit: 12 });
  const context = JSON.parse(result.context);
  assert.ok(result.context.length <= 14000);
  assert.equal(context.layers.length, 8);
  assert.equal(context.totalCount, 96);
  for (const detail of context.layers) {
    assert.equal(detail.count, 12);
    assert.ok(detail.sample.length > 0);
    assert.ok(detail.sample.length < 12);
    assert.equal(detail.breakdown.usage.unknownCount, 12);
    assert.equal(detail.sample[0].name.length, 160);
  }
});

test('upstream truncation is retained and count remains a lower bound of loaded records', () => {
  const result = brief([layer({ records: [record('a')], truncated: true })]);
  assert.equal(result.layers[0].truncated, true);
  assert.equal(result.layers[0].count, 1);
  assert.equal(result.layers[0].countIsLowerBound, true);
});

test('bounds validation rejects invalid or inverted latitude and coverage honors dateline', () => {
  for (const input of [null, {}, { ...bounds, west: 181 }, { ...bounds, south: 11 }, { ...bounds, north: NaN }, { ...bounds, east: null }]) assert.equal(normalizeBounds(input), null);
  assert.equal(pointInBounds(null, 0, 0), false);
  assert.equal(boundsCover({ west: -180, east: 180, south: -90, north: 90 }, bounds), true);
  assert.equal(boundsCover(bounds, { ...bounds, east: 11 }), false);
  assert.equal(boundsCover({ west: 160, east: -160, south: -20, north: 20 }, { west: 170, east: -170, south: -10, north: 10 }), true);
  assert.equal(boundsCover({ west: -170, east: 170, south: -20, north: 20 }, { west: 175, east: -175, south: -10, north: 10 }), false);
  assert.equal(boundsCover(null, bounds), false);
});

const viewportSnapshot = (layers) => ({
  bounds, scope: 'viewport', viewport: { available: true }, generatedAt: 200, layers,
});
const viewportLayer = (extra = {}) => layer({ count: 0, simulatedCount: 0, countIsLowerBound: false, ...extra });

test('viewport totals remain unavailable when no layer can be counted, while observed empty stays zero', () => {
  for (const status of ['unsupported', 'unknown', 'error', 'loading', 'stale']) {
    const result = buildViewBrief(viewportSnapshot([viewportLayer({ status })]));
    assert.equal(result.totalCount, null);
    assert.equal(result.simulatedCount, null);
    assert.equal(result.partialCoverage, true);
    assert.equal(result.totalCountIsLowerBound, false);
    assert.equal(JSON.parse(result.context).totalCount, null);
  }
  const empty = buildViewBrief(viewportSnapshot([viewportLayer()]));
  assert.equal(empty.totalCount, 0);
  assert.equal(empty.partialCoverage, false);
  assert.equal(empty.totalCountIsLowerBound, false);
  const noLayers = buildViewBrief(viewportSnapshot([]));
  assert.equal(noLayers.totalCount, null);
  assert.equal(noLayers.partialCoverage, false);
});

test('viewport aggregate advertises partial coverage for missing enabled layers and source lower bounds', () => {
  for (const extraLayers of [
    [viewportLayer({ id: 'missing', status: 'unsupported' })],
    [viewportLayer({ id: 'partial', count: 3, countIsLowerBound: true })],
  ]) {
    const result = buildViewBrief(viewportSnapshot([viewportLayer({ count: 5 }), ...extraLayers]));
    assert.equal(result.totalCount, extraLayers[0].status === 'unsupported' ? 5 : 8);
    assert.equal(result.partialCoverage, true);
    assert.equal(result.totalCountIsLowerBound, true);
    assert.equal(JSON.parse(result.context).totalCountIsLowerBound, true);
  }
  const disabled = buildViewBrief(viewportSnapshot([viewportLayer({ count: 5 }), viewportLayer({ id: 'off', enabled: false })]));
  assert.equal(disabled.totalCount, 5);
  assert.equal(disabled.partialCoverage, false);
  assert.equal(disabled.totalCountIsLowerBound, false);
});

test('viewport aggregate remains partial when enabled layers exceed the bounded summary capacity', () => {
  const result = buildViewBrief(viewportSnapshot(Array.from({ length: 33 }, (_, id) => viewportLayer({ id: String(id), count: 1 }))));
  assert.equal(result.layers.length, 32);
  assert.equal(result.totalCount, 32);
  assert.equal(result.partialCoverage, true);
  assert.equal(result.totalCountIsLowerBound, true);
});
