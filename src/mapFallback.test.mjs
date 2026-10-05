import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOfflineImageryProvider,
  formatMapFallbackStatus,
  NATURAL_EARTH_II_PATH,
  OFFLINE_FALLBACK_STACK_ID,
  resolveNaturalEarthIiUrl,
} from './mapFallback.js';
import { getLocale, setLocale } from './i18n.js';

test('formatMapFallbackStatus reports the local Natural Earth II fallback truthfully', () => {
  const originalLocale = getLocale();
  try {
    setLocale('en');
    assert.equal(
      formatMapFallbackStatus({ stackLabel: 'Esri Satellite', reason: 'tile requests failed' }),
      'Offline map: Esri Satellite unavailable; using local Natural Earth II (tile requests failed)',
    );
    assert.equal(
      formatMapFallbackStatus({ stackLabel: 'OSM' }),
      'Offline map: OSM unavailable; using local Natural Earth II',
    );
  } finally {
    setLocale(originalLocale);
  }
});

test('formatMapFallbackStatus follows the active locale for user-visible fallback messages', () => {
  const originalLocale = getLocale();
  try {
    setLocale('zh-CN');
    assert.equal(
      formatMapFallbackStatus({ stackLabel: 'OSM', reason: 'tile requests failed' }),
      '离线地图：OSM 不可用；正在使用本地 Natural Earth II（图块请求失败）',
    );
  } finally {
    setLocale(originalLocale);
  }
});

test('resolveNaturalEarthIiUrl uses Cesium buildModuleUrl for the bundled offline imagery', () => {
  const calls = [];
  const url = resolveNaturalEarthIiUrl({
    buildModuleUrl(path) {
      calls.push(path);
      return `/cesium/${path}`;
    },
  });

  assert.equal(url, `/cesium/${NATURAL_EARTH_II_PATH}`);
  assert.deepEqual(calls, [NATURAL_EARTH_II_PATH]);
});

test('createOfflineImageryProvider builds a TileMapService provider from the bundled imagery path', async () => {
  const calls = [];
  const fakeProvider = { kind: 'natural-earth-ii' };
  const Cesium = {
    buildModuleUrl(path) {
      calls.push(['buildModuleUrl', path]);
      return `/cesium/${path}`;
    },
    TileMapServiceImageryProvider: {
      async fromUrl(url, options) {
        calls.push(['fromUrl', url, options]);
        return fakeProvider;
      },
    },
  };

  const resolution = await createOfflineImageryProvider(Cesium, {
    credit: 'Offline raster',
  });

  assert.deepEqual(resolution, {
    provider: fakeProvider,
    effectiveStackId: OFFLINE_FALLBACK_STACK_ID,
    fallbackMessage: null,
    sourceUrl: `/cesium/${NATURAL_EARTH_II_PATH}`,
  });
  assert.deepEqual(calls, [
    ['buildModuleUrl', NATURAL_EARTH_II_PATH],
    ['fromUrl', `/cesium/${NATURAL_EARTH_II_PATH}`, { credit: 'Offline raster' }],
  ]);
});
