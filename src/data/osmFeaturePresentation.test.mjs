import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { buildOsmOverlayEntries, styleOsmSource, OSM_THEME_COLORS } from './osmFeaturePresentation.js';

function source() {
  const entities = new Cesium.EntityCollection();
  entities.add({ id: 'building-1', properties: { building: 'school', name: 'School', 'name:zh': '实验学校' },
    polygon: { hierarchy: Cesium.Cartesian3.fromDegreesArray([116.4, 39.9, 116.401, 39.9, 116.401, 39.901, 116.4, 39.9]) } });
  entities.add({ id: 'building-2', properties: { building: 'apartments', name: 'Foreign apartments' },
    position: Cesium.Cartesian3.fromDegrees(116.402, 39.902), billboard: {} });
  return { entities };
}

test('buildings have a strong fill and a ground-clamped outline with a stable polygon label anchor', () => {
  const data = source();
  const records = styleOsmSource(data, { id: 'buildings' });
  const building = data.entities.getById('building-1');
  assert.ok(building.polygon.material.color.getValue().alpha >= 0.48);
  assert.equal(building.polygon.material.color.getValue().withAlpha(1).toCssHexString(), OSM_THEME_COLORS.buildings);
  assert.ok(data.entities.values.some((entity) => entity.polyline?.clampToGround?.getValue()));
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => Number.isFinite(record.longitude) && Number.isFinite(record.latitude)));
  assert.equal(data.entities.getById('building-2').billboard, undefined);
});

test('OSM labels are Chinese, bounded, collision-managed and retain source details on selection', () => {
  const records = styleOsmSource(source(), { id: 'buildings' });
  const selected = [];
  const entries = buildOsmOverlayEntries(records, { locale: 'zh-CN', onSelect: (record) => selected.push(record) });
  assert.ok(entries.some((entry) => entry.title === '实验学校'));
  assert.ok(entries.some((entry) => entry.title === '公寓楼'));
  assert.ok(entries.every((entry) => entry.collisionGroup === 'ambient-label' && entry.interactive));
  entries[0].activate();
  assert.equal(selected.length, 1);
  const many = Array.from({ length: 1000 }, (_, index) => ({ ...records[index % 2], id: String(index) }));
  assert.ok(buildOsmOverlayEntries(many, { locale: 'zh-CN' }).length <= 120);
});

test('label detail is opt-in and English names stay out of Chinese map titles', () => {
  const records = styleOsmSource(source(), { id: 'buildings' });
  const chinese = buildOsmOverlayEntries(records, { locale: 'zh-CN', selectedId: 'building-2' });
  const selected = chinese.find((entry) => entry.id === 'building-2');
  assert.ok(selected.details.some((line) => line.includes('Foreign apartments')));
  assert.ok(chinese.filter((entry) => !entry.selected).every((entry) => entry.details.length === 0));
  const english = buildOsmOverlayEntries(records, { locale: 'en' });
  assert.ok(english.some((entry) => entry.title === 'Foreign apartments'));
});
