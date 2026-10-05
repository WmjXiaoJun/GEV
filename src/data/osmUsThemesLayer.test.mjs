import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  bboxChanged,
  createOsmUsRefreshPlan,
  normalizeOsmUsBbox,
  rectangleToOsmBbox,
  createOsmUsThemesLayer,
} from './osmUsThemesLayer.js';
import { getLocale, setLocale } from '../i18n.js';

function event() {
  const listeners = new Set();
  return { addEventListener(fn) { listeners.add(fn); return () => listeners.delete(fn); }, fire() { for (const fn of listeners) fn(); } };
}

function makeViewer() {
  const added = new Set();
  const moveStart = event();
  const moveEnd = event();
  const viewer = {
    camera: { moveStart, moveEnd, computeViewRectangle: () => ({ west: -1.705, east: -1.7048, south: 0.528, north: 0.5282 }) },
    scene: { globe: {}, canvas: {} },
    dataSources: { async add(source) { added.add(source); return source; }, remove(source) { return added.delete(source); } },
  };
  return { viewer, added, moveStart, moveEnd };
}

function harness(fetchTheme, options = {}) {
  const surface = makeViewer();
  const overlays = new Map();
  const handlers = [];
  const hits = [];
  const layer = createOsmUsThemesLayer({
    fetchTheme, debounceMs: 0,
    loadDataSource: options.loadDataSource || (async (geojson, loadOptions) => ({ show: false, entities: { values: [] }, geojson, options: loadOptions })),
    requestRender: () => {},
    overlayHost: {
      setEntries: (id, entries) => overlays.set(id, entries), clearSource: (id) => overlays.delete(id),
      hitTest: (x, y, options) => {
        hits.push({ x, y, options });
        const entry = x === 10 && y === 20 ? overlays.get(options.sourceId)?.[0] : null;
        return entry ? { sourceId: options.sourceId, entryId: entry.id, entry } : null;
      },
    },
    screenSpaceEventHandlerFactory: (canvas) => {
      const handler = { canvas, actions: new Map(), destroyCount: 0,
        setInputAction(action, type) { this.actions.set(type, action); },
        destroy() { this.destroyCount += 1; },
      };
      handlers.push(handler);
      return handler;
    },
  });
  return { layer, overlays, handlers, hits, ...surface };
}

const featureCollection = ({ name = 'Test', updatedAt = null } = {}) => ({ type: 'FeatureCollection', features: [{
  type: 'Feature', id: 'node-1', geometry: { type: 'Point', coordinates: [-97.69, 30.26] }, properties: { name },
}], metadata: { updatedAt } });

test('canvas clicks on OSM labels toggle details through source-scoped overlay hit testing', async () => {
  const previousLocale = getLocale();
  setLocale('zh-CN', { persist: false, notify: false, dispatch: false });
  const h = harness(async () => featureCollection(), {
    loadDataSource: async () => ({ show: false, entities: { values: [{
      id: 'node-1', position: Cesium.Cartesian3.fromDegrees(-97.69, 30.26),
      properties: { building: 'apartments', name: 'Example apartments' },
    }] } }),
  });
  try {
    h.layer.setParams({ themes: ['buildings'] });
    h.layer.init(h.viewer);
    h.layer.enable(h.viewer);
    await h.layer._refreshNow();
    assert.equal(h.handlers.length, 1, 'enabling OSM must install a canvas click handler');
    assert.equal(h.handlers[0].canvas, h.viewer.scene.canvas);
    const click = h.handlers[0].actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK);
    const entry = () => h.overlays.get('osm-us-themes:labels')[0];
    assert.equal(entry().variant, 'label');
    click({ position: { x: 10, y: 20 } });
    assert.equal(entry().variant, 'card');
    assert.ok(entry().details.includes('Example apartments'));
    assert.deepEqual(h.hits.at(-1), { x: 10, y: 20, options: { sourceId: 'osm-us-themes:labels' } });
    click({ position: { x: 500, y: 500 } });
    assert.equal(entry().variant, 'card', 'unrelated clicks must leave OSM details alone');
    click({ position: { x: 10, y: 20 } });
    assert.equal(entry().variant, 'label');
    h.layer.setParams({ labels: false });
    const hitCount = h.hits.length;
    click({ position: { x: 10, y: 20 } });
    assert.equal(h.hits.length, hitCount, 'hidden OSM labels must not intercept canvas clicks');
    h.layer.setParams({ labels: true });
    click({});
    assert.equal(h.hits.length, hitCount, 'malformed positions must not reach hit testing');
  } finally {
    h.layer.destroy();
    setLocale(previousLocale, { persist: false, notify: false, dispatch: false });
  }
});

test('OSM canvas handlers are unique and cleaned up on viewer replacement, disable, and destroy', async () => {
  const h = harness(async () => featureCollection());
  h.layer.init(h.viewer);
  h.layer.enable(h.viewer);
  await h.layer._refreshNow();
  h.layer.enable(h.viewer);
  assert.equal(h.handlers.length, 1, 'repeated enable must not duplicate click listeners');
  const oldClick = h.handlers[0].actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK);
  const next = makeViewer();
  h.layer.enable(next.viewer);
  await h.layer._refreshNow();
  assert.equal(h.handlers[0].destroyCount, 1);
  assert.equal(h.handlers.length, 2);
  assert.equal(h.handlers[1].canvas, next.viewer.scene.canvas);
  oldClick({ position: { x: 10, y: 20 } });
  assert.equal(h.hits.length, 0, 'callbacks from a replaced viewer must be inert');
  const currentClick = h.handlers[1].actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK);
  h.layer.disable();
  assert.equal(h.handlers[1].destroyCount, 1);
  currentClick({ position: { x: 10, y: 20 } });
  assert.equal(h.hits.length, 0, 'callbacks after disable must be inert');
  h.layer.enable(next.viewer);
  await h.layer._refreshNow();
  assert.equal(h.handlers.length, 3);
  h.layer.destroy();
  assert.equal(h.handlers[2].destroyCount, 1);
  assert.equal(h.layer.enable(next.viewer), false);
  assert.equal(h.handlers.length, 3);
});

test('real layer lifecycle exposes loading, visible per-theme results, and retry after failure', async () => {
  let fail = true;
  const h = harness(async () => { if (fail) throw new DOMException('Timed out', 'AbortError'); return featureCollection(); });
  await h.layer.init(h.viewer);
  await h.layer.enable(h.viewer);
  await h.layer._refreshNow();
  assert.ok(h.layer.getStats().error, 'a timeout must not become an empty success');
  assert.equal(h.layer.getStats().count, 0);
  fail = false;
  await h.layer._refreshNow();
  assert.equal(h.layer.getStats().error, null);
  assert.equal(h.layer.getStats().count, 4);
  assert.equal(h.added.size, 4);
  assert.ok([...h.added].every((source) => source.show));
  assert.equal(new Set([...h.added].map((source) => source.options.stroke.toCssColorString())).size, 4);
  assert.equal(new Set(h.layer.getAnalystRecords().map((record) => record.id)).size, 4);
  assert.ok(h.layer.getAnalystRecords().every((record) => record.updatedAt === null));
  assert.equal(h.layer.getRowControls().chips.filter((chip) => chip.id.startsWith('theme-')).length, 7);
  h.layer.disable();
  assert.equal(h.added.size, 0);
  assert.deepEqual(h.layer.getAnalystRecords(), []);
});

test('moving away during a request cancels it and cannot publish late features', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const signals = [];
  const h = harness(async (_theme, _bbox, { signal }) => { signals.push(signal); await pending; return featureCollection(); });
  await h.layer.init(h.viewer);
  const enabling = h.layer.enable(h.viewer);
  assert.equal(h.layer.getStats().loading, true);
  const settled = h.layer._refreshNow();
  h.moveStart.fire();
  release();
  await Promise.all([enabling, settled]);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(h.added.size, 0);
  assert.equal(h.layer.getStats().count, 0);
  h.layer.disable();
});

test('replacing the viewer cancels the old camera run, binds the new camera, and cannot publish stale results', async () => {
  let releaseOld;
  const oldPending = new Promise((resolve) => { releaseOld = resolve; });
  const oldSignals = [];
  let oldViewer = true;
  const h = harness(async (_theme, _bbox, { signal }) => {
    if (oldViewer) {
      oldSignals.push(signal);
      await oldPending;
      return featureCollection({ name: 'Old view' });
    }
    return featureCollection({ name: 'New view' });
  });
  const next = makeViewer();
  h.layer.init(h.viewer);
  h.layer.enable(h.viewer);
  oldViewer = false;
  h.layer.enable(next.viewer);
  const replacement = h.layer._refreshNow();
  assert.ok(oldSignals.every((signal) => signal.aborted));
  await replacement;
  releaseOld();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.added.size, 0);
  assert.equal(next.added.size, 4);
  assert.ok(h.layer.getAnalystRecords().every((record) => record.properties.name === 'New view'));
  next.moveStart.fire();
  assert.equal(next.added.size, 0);
  h.layer.disable();
});

test('preserves the upstream OSM timestamp in stats and analyst records and reports runtime data as dynamic', async () => {
  const updatedAt = '2026-09-15T12:34:56Z';
  const h = harness(async () => featureCollection({ updatedAt }));
  h.layer.init(h.viewer);
  h.layer.enable(h.viewer);
  await h.layer._refreshNow();
  const stats = h.layer.getStats();
  assert.equal(stats.sourceUpdatedAt, updatedAt);
  assert.equal(stats.isStatic, false);
  assert.ok(h.layer.getAnalystRecords().every((record) => record.updatedAt === updatedAt && record.sourceUpdatedAt === updatedAt));
  h.layer.disable();
});

test('queues one forced refresh behind an active request for the same camera bounds', async () => {
  let releaseFirst;
  const firstBatch = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const h = harness(async () => {
    calls += 1;
    if (calls <= 4) await firstBatch;
    return featureCollection();
  });
  h.layer.init(h.viewer);
  h.layer.enable(h.viewer);
  const forced = h.layer._refreshNow({ force: true });
  releaseFirst();
  await forced;
  assert.equal(calls, 8);
  h.layer.disable();
});

test('styles positioned point entities with the per-theme ground point color', async () => {
  const entities = [];
  const h = harness(async () => featureCollection(), {
    loadDataSource: async (geojson, options) => {
      const entity = { position: {}, billboard: { stale: true } };
      entities.push(entity);
      return { show: false, entities: { values: [entity] }, geojson, options };
    },
  });
  h.layer.init(h.viewer);
  h.layer.enable(h.viewer);
  await h.layer._refreshNow();
  assert.equal(entities.length, 4);
  assert.ok(entities.every((entity) => entity.billboard === undefined && entity.point?.color));
  assert.deepEqual(entities.map((entity) => entity.point.color.getValue().toCssColorString()).sort(), [
    'rgb(255,255,255)', 'rgb(255,194,71)', 'rgb(255,115,172)', 'rgb(185,230,255)',
  ].sort());
  h.layer.disable();
});

test('extra themes are opt-in, theme toggles fetch only missing data, and labels hide independently', async () => {
  const calls = [];
  const h = harness(async (theme) => { calls.push(theme); return featureCollection(); });
  h.layer.init(h.viewer);
  h.layer.enable(h.viewer);
  await h.layer._refreshNow();
  assert.deepEqual(calls.sort(), ['addresses', 'buildings', 'roads', 'settlements']);
  assert.equal(h.layer.getParams().labels, true);
  h.layer.setParams({ themes: ['buildings', 'water'] });
  await h.layer._refreshNow();
  assert.equal(calls.filter((theme) => theme === 'water').length, 1);
  assert.equal(calls.filter((theme) => theme === 'buildings').length, 1);
  assert.equal(h.added.size, 2);
  h.layer.setParams({ labels: false });
  assert.equal(h.overlays.size, 0);
  assert.equal(h.added.size, 2);
  h.layer.disable();
});

test('OSM theme queries use at most two concurrent upstream requests', async () => {
  let active = 0;
  let peak = 0;
  const h = harness(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return featureCollection();
  });
  h.layer.init(h.viewer);
  h.layer.enable(h.viewer);
  await h.layer._refreshNow();
  assert.ok(peak <= 2);
  assert.equal(h.layer.getStats().count, 4);
  h.layer.disable();
});

test('out-of-range camera clears old features and does not query an invented bbox', async () => {
  let calls = 0;
  const h = harness(async () => { calls += 1; return featureCollection(); });
  await h.layer.init(h.viewer);
  await h.layer.enable(h.viewer);
  await h.layer._refreshNow();
  assert.equal(h.added.size, 4);
  const before = calls;
  h.viewer.camera.computeViewRectangle = () => ({ west: -3, east: 3, south: -1, north: 1 });
  await h.layer._refreshNow({ force: true });
  assert.equal(calls, before);
  assert.equal(h.added.size, 0);
  assert.equal(h.layer.getStats().status, 'zoom-in');
  h.layer.disable();
});

test('refresh plan fetches first view and skips unchanged views', () => {
  const bbox = [30.1, -97.9, 30.5, -97.5];
  assert.equal(createOsmUsRefreshPlan(null, bbox).shouldFetch, true);
  assert.equal(createOsmUsRefreshPlan(bbox, [...bbox]).shouldFetch, false);
  assert.equal(createOsmUsRefreshPlan(bbox, [...bbox], { force: true }).shouldFetch, true);
  assert.equal(bboxChanged(bbox, [30.2, -97.9, 30.5, -97.5]), true);
});

test('refresh plan rejects oversized or malformed viewport bounds', () => {
  assert.throws(() => createOsmUsRefreshPlan(null, [0, 0, 10, 1]), /span/);
  assert.throws(() => createOsmUsRefreshPlan(null, [1, 0, 0, 1]), /invalid/);
});

test('rectangle conversion returns south-west-north-east degrees', () => {
  const rectangle = { west: -1.7, south: 0.5, east: -1.62, north: 0.58 };
  const bbox = rectangleToOsmBbox(rectangle);
  assert.deepEqual(bbox, [
    28.64789, -97.402825, 33.231552, -92.819163,
  ]);
});

test('normalization helper remains the shared bbox contract', () => {
  assert.deepEqual(normalizeOsmUsBbox([30.1, -97.9, 30.5, -97.5]), [30.1, -97.9, 30.5, -97.5]);
});
