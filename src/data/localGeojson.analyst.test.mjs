import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { createLocalGeoJsonLayer, LOCAL_OVERLAY_COHORT_LIMIT } from './localGeojson.js';

function point(id, properties = {}, lon = 116.4, lat = 39.9) {
  return { type: 'Feature', id, properties, geometry: { type: 'Point', coordinates: [lon, lat] } };
}

function polygon(id, properties = {}) {
  return {
    type: 'Feature', id, properties,
    geometry: {
      type: 'Polygon',
      coordinates: [[[116.39, 39.89], [116.41, 39.89], [116.41, 39.91], [116.39, 39.89]]],
    },
  };
}

async function harness(t, features, options = {}) {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalPin = Cesium.PinBuilder.prototype.fromColor;
  const preRender = new Cesium.Event();
  const dataSources = [];
  const published = [];
  // Only marker painting is stubbed; GeoJSON parsing and coordinates are real Cesium.
  Cesium.PinBuilder.prototype.fromColor = () => 'data:image/png;base64,';
  globalThis.window = { dispatchEvent() {} };
  globalThis.fetch = async () => ({ ok: true, text: async () => features.map(JSON.stringify).join('\n') });
  const viewer = {
    dataSources: {
      add(source) { dataSources.push(source); return source; },
      remove(source) { return dataSources.includes(source); },
    },
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(116.4, 39.9, 100_000),
      frustum: { fov: Math.PI / 3 },
      moveEnd: new Cesium.Event(),
    },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      preRender,
      sampleHeightSupported: false,
      requestRender() {},
    },
  };
  const layer = createLocalGeoJsonLayer({
    id: 'local-datacenters', name: 'Datacenters', url: '/fixture.geojsonl', color: '#00ffff',
    overlayHost: {
      setVisible() {}, clearSource() {}, setEntries(entries) { published.push(entries); },
    },
    projectToWindow: () => ({ x: 400, y: 300 }),
    screenSpaceEventHandlerFactory: () => ({ setInputAction() {}, destroy() {} }),
    ...options,
  });
  t.after(() => {
    layer.destroy(viewer);
    globalThis.fetch = originalFetch;
    Cesium.PinBuilder.prototype.fromColor = originalPin;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  await layer.enable(viewer);
  assert.equal(layer.getStats().error, null, 'fixture must load before analyst assertions');
  return { layer, viewer, dataSources, published, preRender };
}

test('local analyst records expose source attributes and real point coordinates', async (t) => {
  const { layer } = await harness(t, [point('feature-id', {
    osm_id: 42, type: 'data_center',
    tags: { name: 'Beijing DC', operator: 'Example Telecom', 'addr:country': 'CN', usage: 'enterprise' },
  })]);
  const [record] = layer.getAnalystRecords();
  assert.deepEqual(record, {
    id: '42', lat: 39.9, lon: 116.4, name: 'Beijing DC', operator: 'Example Telecom',
    country: 'CN', category: 'data_center', usage: 'enterprise', source: 'OpenStreetMap',
    updatedAt: null, sourceUpdatedAt: null, loadedAt: layer.getStats().lastUpdate,
  });
  assert.equal(Object.getPrototypeOf(record), Object.prototype);
});

test('polygon records use the loaded surface anchor, not the changing stem tip', async (t) => {
  const { layer, dataSources, preRender } = await harness(t, [polygon('dam-1', {
    name: 'Test Dam', source: 'hydro', tags: { waterway: 'dam', operator: 'Water Co' },
  })], { id: 'local-dams' });
  const [before] = layer.getAnalystRecords();
  const entity = dataSources[0].entities.values[0];
  const expected = entity.__localBaseCarto;
  assert.equal(before.id, 'dam-1');
  assert.ok(Math.abs(before.lat - Cesium.Math.toDegrees(expected.latitude)) < 0.000001);
  assert.ok(Math.abs(before.lon - Cesium.Math.toDegrees(expected.longitude)) < 0.000001);
  assert.equal(before.category, 'dam');
  assert.equal(before.source, 'OpenStreetMap', 'energy source is not data provenance');
  preRender.raiseEvent();
  assert.deepEqual(layer.getAnalystRecords(), [before]);
});

test('missing metadata stays unknown without inferring usage or operator from a brand', async (t) => {
  const { layer } = await harness(t, [point(0, { tags: { name: 'Amazon Web Services' } })]);
  const [record] = layer.getAnalystRecords();
  assert.equal(record.id, '0');
  for (const key of ['operator', 'country', 'category', 'usage', 'updatedAt', 'sourceUpdatedAt']) {
    assert.equal(record[key], null, key);
  }
});

test('source update timestamps are distinct from the local load time', async (t) => {
  const timestamp = '2024-01-02T03:04:05Z';
  const { layer } = await harness(t, [
    point('dated', { timestamp }),
    point('invalid-date', { timestamp: 'unknown' }),
  ]);
  const [dated, undated] = layer.getAnalystRecords();
  assert.equal(dated.sourceUpdatedAt, Date.parse(timestamp));
  assert.equal(dated.updatedAt, Date.parse(timestamp));
  assert.equal(dated.loadedAt, layer.getStats().lastUpdate);
  assert.notEqual(dated.sourceUpdatedAt, dated.loadedAt);
  assert.equal(undated.sourceUpdatedAt, null);
});

test('local layer stats expose authoritative provenance and distinguish asset load time', async (t) => {
  const { layer } = await harness(t, [point('dc-1')], { source: 'Local' });
  assert.equal(layer.getStats().source, 'OpenStreetMap');
  assert.equal(layer.getStats().isStatic, true);
  assert.equal(layer.getStats().loadedAt, layer.getStats().lastUpdate);
  assert.equal(layer.getStats().sourceUpdatedAt, null);
});

test('analyst records include all loaded features despite hidden entities and a bounded overlay cohort', async (t) => {
  const total = LOCAL_OVERLAY_COHORT_LIMIT + 10;
  const { layer, dataSources, preRender, published } = await harness(t,
    Array.from({ length: total }, (_, index) => point(`dc-${index}`, { tags: { name: `DC ${index}` } })),
  );
  preRender.raiseEvent();
  assert.ok(published.at(-1).length < total);
  for (const entity of dataSources[0].entities.values) entity.show = false;
  assert.equal(layer.getAnalystRecords(500001).length, total);
});

test('analyst records remain available when visual labels are disabled', async (t) => {
  const { layer } = await harness(t, [point('dc-1')], { labels: false });
  assert.equal(layer.getAnalystRecords().length, 1);
});

test('disabled and destroyed local layers expose no analyst records', async (t) => {
  const { layer, viewer } = await harness(t, [point('dc-1')]);
  layer.disable(viewer);
  assert.deepEqual(layer.getAnalystRecords(), []);
  await layer.enable(viewer);
  assert.equal(layer.getAnalystRecords().length, 1);
  layer.destroy(viewer);
  assert.deepEqual(layer.getAnalystRecords(), []);
  await layer.enable(viewer);
  assert.deepEqual(layer.getAnalystRecords(), []);
});

test('requested limits are bounded and do not impose the visual 160-record cap', async (t) => {
  const { layer } = await harness(t, Array.from({ length: 2002 }, (_, index) => point(`dc-${index}`)));
  assert.equal(layer.getAnalystRecords().length, 2000);
  assert.equal(layer.getAnalystRecords(500001).length, 2002);
  assert.equal(layer.getAnalystRecords(2.9).length, 2);
  assert.equal(layer.getAnalystRecords(0).length, 0);
  assert.equal(layer.getAnalystRecords(-2).length, 0);
  assert.equal(layer.getAnalystRecords(Number.NaN).length, 2000);
  assert.equal(layer.getAnalystRecords(Infinity).length, 2000);
});

test('analyst records copy only bounded scalar metadata without exposing or mutating entities', async (t) => {
  const { layer, dataSources } = await harness(t, [point('dc-1', {
    secret: 'do not export', privatePayload: { password: 'do not export' },
    name: `  ${'n'.repeat(300)}  `,
    tags: { operator: { invalid: true }, country: ['CN'], usage: '\n colocation\t\u0000 ' },
  })]);
  const sourceBefore = dataSources[0].entities.values[0].properties.getValue(Cesium.JulianDate.now());
  const first = layer.getAnalystRecords();
  assert.ok(first[0].name.length <= 200);
  assert.equal(first[0].operator, null);
  assert.equal(first[0].country, null);
  assert.equal(first[0].usage, 'colocation');
  assert.equal('privatePayload' in first[0], false);
  assert.equal('entity' in first[0], false);
  first[0].name = 'changed by consumer';
  first.push({ id: 'injected' });
  const second = layer.getAnalystRecords();
  assert.equal(second.length, 1);
  assert.notEqual(second[0].name, first[0].name);
  assert.deepEqual(dataSources[0].entities.values[0].properties.getValue(Cesium.JulianDate.now()), sourceBefore);
});

for (const dataset of ['datacenters', 'dams']) {
  test(`bundled ${dataset} expose every anchored feature and known source metadata`, async (t) => {
    const features = readFileSync(new URL(`./local_data/${dataset}/${dataset}.geojsonl`, import.meta.url), 'utf8')
      .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    const { layer, dataSources } = await harness(t, features, { id: `local-${dataset}` });
    const records = layer.getAnalystRecords(500001);
    const anchored = dataSources[0].entities.values.filter((entity) => entity.__localBaseCarto);
    assert.equal(records.length, anchored.length);
    assert.equal(layer.getStats().analystRecordCount, anchored.length);
    assert.equal(layer.getStats().unlocatedRecordCount, layer.getStats().count - anchored.length);
    if (dataset === 'datacenters') assert.equal(records.length, layer.getStats().count);
    assert.ok(records.length > LOCAL_OVERLAY_COHORT_LIMIT);
    assert.equal(records[0].id, String(features[0].properties.osm_id));
    assert.equal(records[0].operator, features[0].properties.tags.operator);
    assert.equal(records[0].source, 'OpenStreetMap');
    assert.equal(records[0].usage, null);
    assert.equal(records[0].sourceUpdatedAt, null);
    assert.ok(records.every((record) => Number.isFinite(record.lat) && Number.isFinite(record.lon)));
    t.diagnostic(`${dataset}: ${records.length} loaded records available for geographic filtering`);
  });
}
