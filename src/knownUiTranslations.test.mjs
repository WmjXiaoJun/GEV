import assert from 'node:assert/strict';
import test from 'node:test';

import { MESSAGE_CATALOG } from './i18n.js';
import {
  createKnownMessageIndex,
  localizeKnownUiValue,
} from './knownUiTranslations.js';

const index = createKnownMessageIndex(MESSAGE_CATALOG);

test('known UI strings localize exactly while preserving surrounding whitespace', () => {
  const result = localizeKnownUiValue('  DIRECTORY BAND  ', {
    catalog: MESSAGE_CATALOG,
    index,
    locale: 'zh-CN',
  });

  assert.equal(result.value, '  目录频段  ');
  assert.equal(result.binding.key, 'radio.directoryBand');
  assert.deepEqual(result.binding.values, {});
});

test('known UI templates carry their values into the target locale', () => {
  const result = localizeKnownUiValue('Loaded 3 data layers', {
    catalog: MESSAGE_CATALOG,
    index,
    locale: 'zh-CN',
  });

  assert.equal(result.value, '已加载 3 个数据图层');
  assert.equal(result.binding.key, 'status.layersLoaded');
  assert.deepEqual(result.binding.values, { count: '3' });
});

test('a remembered binding makes translated runtime text reversible', () => {
  const chinese = localizeKnownUiValue('Radio off', {
    catalog: MESSAGE_CATALOG,
    index,
    locale: 'zh-CN',
  });
  const english = localizeKnownUiValue(chinese.value, {
    binding: chinese.binding,
    catalog: MESSAGE_CATALOG,
    index,
    locale: 'en',
  });

  assert.equal(english.value, 'Radio off');
  assert.equal(english.binding.key, 'radio.off');
});

test('unknown live data is never translated or kept under a stale binding', () => {
  const known = localizeKnownUiValue('UNKNOWN', {
    catalog: MESSAGE_CATALOG,
    index,
    locale: 'zh-CN',
  });
  const callsign = localizeKnownUiValue('UAL123', {
    binding: known.binding,
    catalog: MESSAGE_CATALOG,
    index,
    locale: 'zh-CN',
  });

  assert.equal(callsign.value, 'UAL123');
  assert.equal(callsign.binding, null);
});

test('a translated value can be recognized without prior DOM state', () => {
  const result = localizeKnownUiValue('正在配置查看器…', {
    catalog: MESSAGE_CATALOG,
    index,
    locale: 'en',
  });

  assert.equal(result.value, 'Configuring viewer…');
  assert.equal(result.binding.key, 'loader.configuringViewer');
});

test('known segments and template placeholders localize inside compound UI labels', () => {
  const catalog = {
    en: {
      military: 'MILITARY',
      live: 'LIVE TRACK',
      aligned: 'COURSE ALIGNED',
      expand: 'Expand {panel}',
      radio: 'Radio',
    },
    'zh-CN': {
      military: '军用',
      live: '实时跟踪',
      aligned: '航向已对齐',
      expand: '展开{panel}',
      radio: '无线电',
    },
  };
  const compoundIndex = createKnownMessageIndex(catalog);

  assert.equal(localizeKnownUiValue('MILITARY · LIVE TRACK · COURSE ALIGNED', {
    catalog,
    index: compoundIndex,
    locale: 'zh-CN',
  }).value, '军用 · 实时跟踪 · 航向已对齐');
  assert.equal(localizeKnownUiValue('Expand Radio', {
    catalog,
    index: compoundIndex,
    locale: 'zh-CN',
  }).value, '展开无线电');
});

test('dynamic operational surfaces have curated Chinese coverage', () => {
  const cases = new Map([
    ['CCTV ON', '监控开启'],
    ['NO STATION SELECTED', '未选择电台'],
    ['Live Flights', '实时航班'],
    ['SELECTED SPACE MISSION', '已选太空任务'],
    ['3 cameras loaded · click a camera to activate', '已加载 3 个摄像头 · 点击摄像头即可激活'],
    ['Cleared 3 data layers', '已清除 3 个数据图层'],
    [
      'Offline map: OSM unavailable; using local Natural Earth II (tile requests failed)',
      '离线地图：OSM 不可用；正在使用本地 Natural Earth II（图块请求失败）',
    ],
  ]);

  for (const [source, expected] of cases) {
    assert.equal(localizeKnownUiValue(source, {
      catalog: MESSAGE_CATALOG,
      index,
      locale: 'zh-CN',
    }).value, expected, source);
  }
});
