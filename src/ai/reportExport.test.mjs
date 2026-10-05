import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotToCsv, snapshotToGeoJson, comparisonToGeoJson, snapshotToJson, reportToHtml, createReportExports } from './reportExport.js';

const snapshot = { scope: 'viewport', generatedAt: 0, bounds: { west: -1, east: 1, south: -1, north: 1 }, layers: [{ id: 'flights', name: 'Flights', status: 'ready', enabled: true, records: [{ id: '1', name: 'A, <test>', type: 'aircraft', latitude: 0, longitude: 0, source: 'feed', simulated: false }] }] };

test('CSV has stable headers and escapes spreadsheet values', () => {
  const csv = snapshotToCsv({ ...snapshot, layers: [{ ...snapshot.layers[0], records: [{ ...snapshot.layers[0].records[0], name: '=HYPERLINK("https://evil.invalid")' }] }] });
  assert.match(csv, /^layerId,layerName,id,name,type,latitude,longitude/);
  assert.match(csv, /'=HYPERLINK/);
});

test('GeoJSON exports only valid located records', () => {
  const geo = snapshotToGeoJson({ ...snapshot, layers: [{ ...snapshot.layers[0], records: [...snapshot.layers[0].records, { id: 'bad', latitude: 99, longitude: 0 }] }] });
  assert.equal(geo.type, 'FeatureCollection'); assert.equal(geo.features.length, 1); assert.deepEqual(geo.features[0].geometry.coordinates, [0, 0]);
});

test('comparison GeoJSON maps added, removed and moved targets', () => {
  const geo = comparisonToGeoJson({ beforeAt: 1, afterAt: 2, layers: [{ layerId: 'targets', layerName: 'Targets', added: [{ id: 'a', latitude: 1, longitude: 2 }], removed: [{ id: 'b', latitude: 3, longitude: 4 }] }], moved: [{ id: 'c', from: { latitude: 0, longitude: 0 }, to: { latitude: 1, longitude: 1 }, distanceM: 100 }] });
  assert.equal(geo.features.length, 3); assert.equal(geo.features[2].geometry.type, 'LineString'); assert.equal(geo.features[2].properties.change, 'moved');
});

test('JSON is normalized and HTML safely escapes title and record text', () => {
  const json = snapshotToJson(snapshot); assert.equal(JSON.parse(json).scope, 'viewport');
  const html = reportToHtml({ snapshot, title: '<Report>' }); assert.match(html, /&lt;Report&gt;/); assert.doesNotMatch(html, /<Report>/); assert.match(html, /window.print/);
});

test('createReportExports supplies browser-ready MIME types', () => {
  const exports = createReportExports(snapshot);
  assert.equal(exports.csv.mimeType, 'text/csv;charset=utf-8'); assert.equal(exports.geojson.extension, 'geojson'); assert.ok(exports.html.content.startsWith('<!doctype html>'));
});

test('CSV preserves negative coordinates as numbers', () => {
  const csv = snapshotToCsv({ ...snapshot, layers: [{ ...snapshot.layers[0], records: [{ ...snapshot.layers[0].records[0], longitude: -95 }] }] });
  assert.match(csv, /,0,-95,/);
});

test('HTML validates counts and preserves epoch timestamps', () => {
  const html = reportToHtml({ snapshot, comparison: { addedCount: '<img src=x onerror=alert(1)>' } });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /1970-01-01T00:00:00.000Z/);
});

test('comparison GeoJSON tolerates malformed collections and excludes unknown secrets', () => {
  const geo = comparisonToGeoJson({ layers: [{ added: {}, removed: 'nope' }], moved: [{ from: { latitude: 1, longitude: 2 }, to: { latitude: 3, longitude: 4 }, id: { apiKey: 'private-value' } }] });
  assert.doesNotMatch(JSON.stringify(geo), /private-value/);
});
