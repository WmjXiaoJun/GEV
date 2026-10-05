import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OSM_US_THEMES,
  buildOsmUsOverpassQuery,
  fetchOsmUsTheme,
  normalizeOsmUsBbox,
  parseOsmUsTheme,
} from './osmUsThemes.js';

test('keeps the original OSM themes first and appends water, green spaces, and public facilities', () => {
  assert.deepEqual(OSM_US_THEMES.map((theme) => theme.id), [
    'addresses', 'buildings', 'roads', 'settlements', 'water', 'green', 'pois',
  ]);
  assert.ok(OSM_US_THEMES.every((theme) => theme.publisher === 'OpenStreetMap contributors'));
});

test('water and green queries select local ways with bounded geometry and result counts', () => {
  const bbox = [30.25, -97.765, 30.275, -97.725];
  const water = buildOsmUsOverpassQuery('water', bbox, { limit: 99999 });
  const green = buildOsmUsOverpassQuery('green', bbox, { limit: 99999 });
  assert.match(water, /\["waterway"~"\^\(river\|stream\|canal\)\$"\]/);
  assert.match(water, /\["natural"="water"\]/);
  assert.match(green, /\["leisure"~"\^\(park\|garden\)\$"\]/);
  assert.match(green, /\["landuse"~"\^\(forest\|grass\|meadow\|recreation_ground\)\$"\]/);
  for (const query of [water, green]) {
    assert.doesNotMatch(query, /\brelation|\bnwr|\barea|\broute|\bboundary/);
    const selectors = query.split('\n').filter((line) => line.trim().startsWith('way'));
    assert.ok(selectors.length >= 2);
    assert.ok(selectors.every((line) => line.includes('(30.25,-97.765,30.275,-97.725)')));
    assert.ok(selectors.every((line) => line.includes('(if:length()<=20000)')));
    assert.match(query, /out body geom 600;/);
  }
});

test('public facilities query named categories and request bounded center points', () => {
  const query = buildOsmUsOverpassQuery('pois', [30.25, -97.765, 30.275, -97.725], { limit: 99999 });
  assert.match(query, /\["amenity"~"\^\(school\|college\|university\|hospital\|clinic\|police\|fire_station\|library\|bus_station\|ferry_terminal\)\$"\]/);
  assert.match(query, /\["railway"~"\^\(station\|halt\|tram_stop\)\$"\]/);
  assert.match(query, /\["highway"="bus_stop"\]/);
  assert.match(query, /out tags center 800;/);
  assert.doesNotMatch(query, /out body geom/);
});

test('optional themes reject oversized viewports and retain smaller caller limits', () => {
  for (const theme of ['water', 'green', 'pois']) {
    assert.throws(() => buildOsmUsOverpassQuery(theme, [30, -98, 30.5, -97.5]), /0\.2 degrees/);
    assert.match(buildOsmUsOverpassQuery(theme, [30, -98, 30.01, -97.99], { limit: 7 }), / 7;/);
  }
});

test('optional theme metadata preserves OSM attribution and follows its effective result cap', () => {
  for (const [id, label] of [['water', 'Water'], ['green', 'Green Spaces'], ['pois', 'Public Facilities']]) {
    const elements = Array.from({ length: 601 }, (_, index) => ({
      type: 'node', id: index + 1, lat: 30.26, lon: -97.74, tags: { name: `Feature ${index}` },
    }));
    const result = parseOsmUsTheme({ elements }, id);
    assert.equal(result.metadata.theme, id);
    assert.equal(result.metadata.label, label);
    assert.equal(result.metadata.publisher, 'OpenStreetMap contributors');
    assert.equal(result.metadata.attribution, '© OpenStreetMap contributors');
    assert.equal(result.metadata.license, 'ODbL');
    assert.equal(result.metadata.truncated, id !== 'pois');
    assert.equal(result.features.length, id === 'pois' ? 601 : 600);
  }
});

test('public facility way and relation centers become points with their names and source ids', () => {
  const result = parseOsmUsTheme({ elements: [
    { type: 'way', id: 20, center: { lat: 30.26, lon: -97.74 }, tags: { amenity: 'school', name: 'Example School' } },
    { type: 'relation', id: 30, center: { lat: 30.27, lon: -97.75 }, tags: { amenity: 'hospital', name: 'Example Hospital' } },
  ] }, 'pois');
  assert.equal(result.features.length, 2);
  assert.ok(result.features.every((feature) => feature.geometry.type === 'Point'));
  assert.equal(result.features.find((feature) => feature.id === 'way-20').properties.name, 'Example School');
  assert.equal(result.features.find((feature) => feature.id === 'relation-30').properties.name, 'Example Hospital');
});

test('validates and normalizes a bounded bbox', () => {
  assert.deepEqual(normalizeOsmUsBbox([30.1, -97.9, 30.5, -97.5]), [30.1, -97.9, 30.5, -97.5]);
  assert.throws(() => normalizeOsmUsBbox([0, 0, 10, 10]), /span/);
  assert.throws(() => normalizeOsmUsBbox([30, -97, 29, -96]), /invalid/);
});

test('builds theme-specific Overpass query with a capped limit', () => {
  const query = buildOsmUsOverpassQuery('roads', [30.1, -97.9, 30.5, -97.5], { limit: 99999 });
  assert.match(query, /way\["highway"\]\["name"\]/);
  assert.match(query, /out body geom 3000;/);
  assert.throws(() => buildOsmUsOverpassQuery('unknown', [0, 0, 1, 1]), /Unknown OSM theme/);
});

test('converts nodes, ways, and closed building ways to GeoJSON without treating points as lines', () => {
  const result = parseOsmUsTheme({ elements: [
    { type: 'node', id: 1, lat: 30.2, lon: -97.7, tags: { place: 'town', name: 'Example' } },
    { type: 'way', id: 2, geometry: [{ lat: 30.2, lon: -97.7 }, { lat: 30.21, lon: -97.7 }], tags: { highway: 'residential' } },
    { type: 'way', id: 3, geometry: [
      { lat: 30.2, lon: -97.7 }, { lat: 30.2, lon: -97.69 },
      { lat: 30.21, lon: -97.69 }, { lat: 30.2, lon: -97.7 },
    ], tags: { building: 'yes' } },
  ] }, 'buildings');
  assert.equal(result.features.find((feature) => feature.id === 'node-1').geometry.type, 'Point');
  assert.equal(result.features.find((feature) => feature.id === 'way-2').geometry.type, 'LineString');
  const building = result.features.find((feature) => feature.id === 'way-3');
  assert.equal(building.geometry.type, 'Polygon');
  assert.equal(building.properties.publisher, 'OpenStreetMap contributors');
  assert.equal(result.metadata.license, 'ODbL');
});

test('preserves distinct outer rings and inner holes in a building multipolygon', () => {
  const result = parseOsmUsTheme({ elements: [
    { type: 'node', id: 1, lat: 30, lon: -98 }, { type: 'node', id: 2, lat: 30, lon: -97 },
    { type: 'node', id: 3, lat: 31, lon: -97 }, { type: 'node', id: 4, lat: 31, lon: -98 },
    { type: 'node', id: 5, lat: 30.2, lon: -97.8 }, { type: 'node', id: 6, lat: 30.2, lon: -97.6 },
    { type: 'node', id: 7, lat: 30.4, lon: -97.6 }, { type: 'node', id: 8, lat: 30.4, lon: -97.8 },
    { type: 'node', id: 9, lat: 32, lon: -98 }, { type: 'node', id: 10, lat: 32, lon: -97 },
    { type: 'node', id: 11, lat: 33, lon: -97 }, { type: 'node', id: 12, lat: 33, lon: -98 },
    { type: 'way', id: 20, nodes: [1, 2, 3, 4, 1] },
    { type: 'way', id: 21, nodes: [5, 6, 7, 8, 5] },
    { type: 'way', id: 22, nodes: [9, 10, 11, 12, 9] },
    { type: 'relation', id: 30, tags: { type: 'multipolygon', building: 'yes' }, members: [
      { type: 'way', ref: 20, role: 'outer' }, { type: 'way', ref: 21, role: 'inner' }, { type: 'way', ref: 22, role: 'outer' },
    ] },
  ] }, 'buildings');
  const feature = result.features.find((candidate) => candidate.id === 'relation-30');
  assert.equal(feature.geometry.type, 'MultiPolygon');
  assert.equal(feature.geometry.coordinates.length, 2);
  assert.deepEqual(feature.geometry.coordinates.map((polygon) => polygon.length).sort(), [1, 2]);
});

test('drops invalid coordinates instead of manufacturing a GeoJSON feature', () => {
  const result = parseOsmUsTheme({ elements: [
    { type: 'node', id: 1, lat: 91, lon: -97, tags: { place: 'town' } },
    { type: 'node', id: 2, lat: 30, lon: Number.NaN, tags: { place: 'town' } },
  ] }, 'settlements');
  assert.deepEqual(result.features, []);
});

test('retains upstream timestamp and reports an output limit hit without inventing source metadata', () => {
  const result = parseOsmUsTheme({
    osm3s: { timestamp_osm_base: '2026-09-15T00:00:00Z' },
    elements: [{ type: 'node', id: 7, lat: 30.2, lon: -97.7, tags: { place: 'city' } }],
  }, 'settlements', { limit: 1 });
  assert.deepEqual(result.metadata, {
    theme: 'settlements', label: 'Settlements', publisher: 'OpenStreetMap contributors', license: 'ODbL',
    attribution: '© OpenStreetMap contributors', attributionUrl: 'https://www.openstreetmap.org/copyright',
    updatedAt: '2026-09-15T00:00:00Z', truncated: true,
  });
});

test('fetches through the same-origin proxy and returns themed GeoJSON', async () => {
  const calls = [];
  const result = await fetchOsmUsTheme('settlements', [30, -98, 30.5, -97.5], {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, async json() { return { elements: [{ type: 'node', id: 7, lat: 30.2, lon: -97.7, tags: { place: 'city' } }] }; } };
    },
  });
  assert.equal(calls[0].url, '/api/overpass');
  assert.equal(calls[0].options.method, 'POST');
  assert.match(calls[0].options.body, /^data=/);
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].properties.theme, 'settlements');
});

test('does not send a request when its signal is already cancelled', async () => {
  const controller = new AbortController();
  controller.abort(new Error('superseded'));
  let calls = 0;
  await assert.rejects(() => fetchOsmUsTheme('settlements', [30, -98, 30.5, -97.5], {
    signal: controller.signal,
    fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({ elements: [] }) }; },
  }), /superseded|Abort/);
  assert.equal(calls, 0);
});

test('aborts a slow proxy request at its bounded timeout', async () => {
  await assert.rejects(() => fetchOsmUsTheme('settlements', [30, -98, 30.5, -97.5], {
    timeoutMs: 10,
    fetchImpl: async (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  }), /Abort|aborted/i);
});

test('rejects an Overpass body-level failure remark instead of accepting it as empty data', async () => {
  await assert.rejects(() => fetchOsmUsTheme('settlements', [30, -98, 30.5, -97.5], {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ remark: 'runtime error: Query timed out', elements: [] }) }),
  }), /Overpass.*runtime error/i);
});
