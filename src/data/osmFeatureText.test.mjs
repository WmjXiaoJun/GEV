import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOsmFeatureText } from './osmFeatureText.js';

test('prefers Chinese OSM names in the documented order', () => {
  const result = resolveOsmFeatureText({
    tags: {
      name: 'Central Hospital',
      'name:zh': '中心医院',
      'name:zh-Hans': '中央医院',
      amenity: 'hospital',
    },
  });

  assert.deepEqual(result, {
    title: '中心医院',
    details: ['医院', 'Central Hospital'],
    rawName: 'Central Hospital',
    hasChineseName: true,
    category: '医院',
  });
});

test('accepts common Chinese-name variants and a Chinese primary name', () => {
  const hans = resolveOsmFeatureText({ tags: { 'name:zh-Hans-CN': '河滨公园', leisure: 'park', name: 'Riverside Park' } });
  const primary = resolveOsmFeatureText({ tags: { name: '海港图书馆', amenity: 'library' } });

  assert.equal(hans.title, '河滨公园');
  assert.equal(hans.hasChineseName, true);
  assert.equal(primary.title, '海港图书馆');
  assert.equal(primary.category, '图书馆');
});

test('uses an accurate Chinese category and preserves the un-translated original name', () => {
  const result = resolveOsmFeatureText({ tags: { name: 'North Loop', highway: 'primary' } });

  assert.deepEqual(result, {
    title: '主干道',
    details: ['North Loop'],
    rawName: 'North Loop',
    hasChineseName: false,
    category: '主干道',
  });
});

test('formats house numbers without duplicating the Chinese number unit', () => {
  const options = { theme: 'addresses' };
  const first = resolveOsmFeatureText({ tags: { 'addr:housenumber': '12', 'addr:street': 'Market Street' } }, options);
  const second = resolveOsmFeatureText({ tags: { 'addr:housenumber': '12号', 'addr:street': 'Market Street' } }, options);

  assert.equal(first.title, '门牌 12号');
  assert.equal(second.title, '门牌 12号');
  assert.deepEqual(first.details, ['Market Street']);
});

test('uses English category strings when locale is English', () => {
  const result = resolveOsmFeatureText({ tags: { building: 'apartments', name: 'Tower 9' } }, { locale: 'en', theme: 'buildings' });

  assert.deepEqual(result, {
    title: 'Tower 9',
    details: ['Apartment building'],
    rawName: 'Tower 9',
    hasChineseName: false,
    category: 'Apartment building',
  });
});

test('uses the controlled category in Chinese but the raw OSM name in English', () => {
  const props = { tags: { name: 'Riverside Clinic', amenity: 'clinic' } };

  assert.deepEqual(resolveOsmFeatureText(props), {
    title: '诊所', details: ['Riverside Clinic'], rawName: 'Riverside Clinic',
    hasChineseName: false, category: '诊所',
  });
  assert.equal(resolveOsmFeatureText(props, { locale: 'en' }).title, 'Riverside Clinic');
});

test('recognizes school and hospital building categories when amenity tags are absent', () => {
  const school = resolveOsmFeatureText({ tags: { building: 'school' } });
  const hospital = resolveOsmFeatureText({ tags: { building: 'hospital' } });

  assert.equal(school.category, '学校');
  assert.equal(hospital.category, '医院');
});

test('uses distinct detailed categories and only treats addresses as address-theme features', () => {
  assert.equal(resolveOsmFeatureText({ tags: { building: 'apartments' } }).category, '公寓楼');
  assert.equal(resolveOsmFeatureText({ tags: { amenity: 'kindergarten' } }).category, '幼儿园');
  assert.equal(resolveOsmFeatureText({ tags: { amenity: 'university' } }).category, '大学');
  assert.equal(resolveOsmFeatureText({ tags: { highway: 'bus_stop' } }).category, '公交站');
  assert.equal(resolveOsmFeatureText({ tags: { public_transport: 'platform' } }).category, '站台');
  assert.equal(resolveOsmFeatureText({ tags: { landuse: 'forest' } }).category, '绿地');
  assert.equal(resolveOsmFeatureText({ tags: {}, 'addr:housenumber': '7' }, { theme: 'buildings' }).title, '建筑');
  assert.equal(resolveOsmFeatureText({ tags: {}, 'addr:housenumber': '7' }, { theme: 'addresses' }).title, '门牌 7号');
  assert.equal(resolveOsmFeatureText({}, { theme: 'water' }).category, '水系');
  assert.equal(resolveOsmFeatureText({}, { theme: 'green' }).category, '绿地');
});

test('returns inert bounded text for hostile external values', () => {
  const result = resolveOsmFeatureText({
    tags: { name: '<img src=x onerror=alert(1)>\u0000' + 'x'.repeat(180), amenity: 'school' },
  });

  assert.equal(result.title, '学校');
  assert.equal(result.details.length, 1);
  assert.ok(result.details[0].startsWith('<img src=x onerror=alert(1)>'));
  assert.ok(result.details[0].length <= 120);
  assert.ok(!result.details[0].includes('\u0000'));
  assert.ok(!Object.values(result).some((value) => typeof value === 'string' && value.includes('<span')));
});
