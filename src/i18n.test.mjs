import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_LOCALE,
  LOCALE_CHANGE_EVENT,
  MESSAGE_CATALOG,
  SUPPORTED_LOCALES,
  createI18n,
  detectLocale,
  formatMessage,
  normalizeLocale,
  readLocale,
} from './i18n.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test('locale normalization accepts common English and Chinese aliases', () => {
  assert.equal(normalizeLocale('en'), 'en');
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale('english'), 'en');
  assert.equal(normalizeLocale('zh'), 'zh-CN');
  assert.equal(normalizeLocale('zh-CN'), 'zh-CN');
  assert.equal(normalizeLocale('中文'), 'zh-CN');
  assert.equal(normalizeLocale('unsupported'), DEFAULT_LOCALE);
  assert.deepEqual(SUPPORTED_LOCALES, ['en', 'zh-CN']);
});

test('readLocale safely falls back when storage is empty or unavailable', () => {
  assert.equal(readLocale(memoryStorage()), DEFAULT_LOCALE);
  assert.equal(readLocale(memoryStorage({ 'gev:locale:v1': 'zh' })), 'zh-CN');
  assert.equal(readLocale({ getItem() { throw new Error('blocked'); } }), DEFAULT_LOCALE);
  assert.equal(readLocale(null), DEFAULT_LOCALE);
});

test('browser locale detection prefers Simplified Chinese only when no preference is saved', () => {
  assert.equal(detectLocale({ language: 'zh-CN', languages: ['zh-CN', 'en-US'] }), 'zh-CN');
  assert.equal(detectLocale({ language: 'en-US', languages: ['en-US'] }), 'en');
  const i18n = createI18n({
    storage: memoryStorage(),
    navigatorLike: { language: 'zh-CN', languages: ['zh-CN'] },
  });
  assert.equal(i18n.getLocale(), 'zh-CN');
});

test('translation lookup falls back to English and interpolates values', () => {
  const i18n = createI18n({ locale: 'zh-CN', storage: memoryStorage() });
  assert.equal(i18n.t('app.subtitle'), '没有地方被遗漏');
  assert.equal(i18n.t('status.layersLoaded', { count: 3 }), '已加载 3 个数据图层');
  assert.equal(i18n.t('style.normal'), '标准');
  assert.equal(i18n.t('missing.key'), 'missing.key');
  assert.equal(formatMessage('Hello {name}', { name: 'Ada' }), 'Hello Ada');
  assert.equal(formatMessage('Value {missing}', {}), 'Value {missing}');
});

test('static speech mode options translate from their initial markup into both languages', () => {
  const markup = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const options = [...markup.matchAll(/<option\b[^>]*data-i18n="(ai\.speech\.mode\.[^"]+)"[^>]*>([^<]*)<\/option>/g)];
  assert.equal(options.length, 4);
  const i18n = createI18n({ locale: 'zh-CN', storage: memoryStorage() });
  for (const [, key, initialText] of options) {
    const option = { dataset: { i18n: key }, textContent: initialText };
    i18n.translateElement(option, 'zh-CN');
    assert.equal(option.textContent, MESSAGE_CATALOG['zh-CN'][key]);
    i18n.translateElement(option, 'en');
    assert.equal(option.textContent, MESSAGE_CATALOG.en[key]);
  }
});

test('setLocale persists, notifies subscribers, and dispatches a browser event', () => {
  const storage = memoryStorage();
  const events = [];
  const eventTarget = {
    dispatchEvent(event) {
      events.push(event);
      return true;
    },
  };
  const i18n = createI18n({ storage, eventTarget, initialLocale: 'en' });
  const changes = [];
  const unsubscribe = i18n.subscribe((change) => changes.push(change));

  assert.equal(i18n.setLocale('zh'), 'zh-CN');
  assert.equal(i18n.getLocale(), 'zh-CN');
  assert.equal(storage.getItem('gev:locale:v1'), 'zh-CN');
  assert.deepEqual(changes, [{ locale: 'zh-CN', previousLocale: 'en' }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, LOCALE_CHANGE_EVENT);
  assert.deepEqual(events[0].detail, { locale: 'zh-CN', previousLocale: 'en' });

  unsubscribe();
  i18n.setLocale('en');
  assert.equal(changes.length, 1);
});

test('setting the active locale again is idempotent and does not notify', () => {
  const changes = [];
  const i18n = createI18n({ storage: memoryStorage(), initialLocale: 'en' });
  i18n.subscribe((change) => changes.push(change));
  assert.equal(i18n.setLocale('en'), 'en');
  assert.deepEqual(changes, []);
});

test('translateDocument applies text and supported attribute keys without unsafe HTML', () => {
  const attrs = new Map();
  const makeElement = (dataset, textContent = 'old') => ({
    dataset,
    textContent,
    attrs,
    setAttribute(name, value) {
      this.attrs.set(name, value);
    },
    getAttribute(name) {
      return this.dataset[name] ?? null;
    },
  });
  const text = makeElement({ i18n: 'panel.dataLayers' }, 'DATA LAYERS');
  const placeholder = makeElement({ i18nPlaceholder: 'search.placeholder' });
  const title = makeElement({ i18nTitle: 'nav.reset' });
  const valueText = makeElement({ i18nAriaValuetext: 'radio.off' });
  const root = {
    querySelectorAll(selector) {
      assert.match(selector, /data-i18n/);
      return [text, placeholder, title, valueText];
    },
  };
  const i18n = createI18n({ storage: memoryStorage(), initialLocale: 'zh-CN' });

  i18n.translateDocument(root);
  assert.equal(text.textContent, i18n.t('panel.dataLayers'));
  assert.equal(placeholder.attrs.get('placeholder'), i18n.t('search.placeholder'));
  assert.equal(title.attrs.get('title'), i18n.t('nav.reset'));
  assert.equal(valueText.attrs.get('aria-valuetext'), i18n.t('radio.off'));
});

test('unbound runtime state is not overwritten by the document translator', () => {
  const dynamic = {
    dataset: {},
    textContent: 'BBC World Service',
    getAttribute: () => null,
  };
  const i18n = createI18n({ storage: memoryStorage(), initialLocale: 'zh-CN' });

  i18n.translateElement(dynamic);
  assert.equal(dynamic.textContent, 'BBC World Service');
});

test('static translation bindings do not overwrite newer runtime state', () => {
  const element = {
    dataset: { i18n: 'radio.off' },
    textContent: 'BBC World Service',
    getAttribute: () => null,
  };
  const i18n = createI18n({ storage: memoryStorage(), initialLocale: 'zh-CN' });

  i18n.translateElement(element);
  assert.equal(element.textContent, 'BBC World Service');
});

test('DOM locale initialization writes the html lang attribute when available', () => {
  const html = { lang: '' };
  const root = { documentElement: html, querySelectorAll: () => [] };
  const i18n = createI18n({ storage: memoryStorage(), initialLocale: 'zh-CN' });
  i18n.init(root);
  assert.equal(html.lang, 'zh-CN');
});

test('translation writes are idempotent to avoid MutationObserver feedback loops', () => {
  const i18n = createI18n({ storage: memoryStorage(), initialLocale: 'zh-CN' });
  const attributes = new Map([['title', i18n.t('nav.reset')]]);
  let text = i18n.t('panel.dataLayers');
  let textWrites = 0;
  let attributeWrites = 0;
  const element = {
    dataset: {
      i18n: 'panel.dataLayers',
      i18nTitle: 'nav.reset',
    },
    get textContent() {
      return text;
    },
    set textContent(value) {
      textWrites += 1;
      text = value;
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name, value) {
      attributeWrites += 1;
      attributes.set(name, value);
    },
  };

  i18n.translateElement(element);
  assert.equal(textWrites, 0);
  assert.equal(attributeWrites, 0);

  let langWrites = 0;
  const html = {
    lang: 'zh-CN',
    getAttribute: () => 'zh-CN',
    setAttribute() {
      langWrites += 1;
    },
  };
  i18n.translateDocument({ documentElement: html, querySelectorAll: () => [] });
  assert.equal(langWrites, 0);
});

test('static UI translation attributes reference complete English and Chinese catalogues', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const keys = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.ok(keys.length >= 50, 'the primary static surfaces must remain wired to i18n');
  for (const key of new Set(keys)) {
    assert.equal(typeof MESSAGE_CATALOG.en[key], 'string', `missing English message: ${key}`);
    assert.equal(typeof MESSAGE_CATALOG['zh-CN'][key], 'string', `missing Chinese message: ${key}`);
  }
  assert.deepEqual(
    Object.keys(MESSAGE_CATALOG.en).sort(),
    Object.keys(MESSAGE_CATALOG['zh-CN']).sort(),
    'locale catalogues must have identical keys',
  );
});

test('static accessible copy has exact bilingual locale bindings', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const localizableAttributes = [
    'aria-label',
    'aria-description',
    'aria-valuetext',
    'placeholder',
    'title',
  ];
  let checked = 0;

  for (const tagMatch of html.matchAll(/<[A-Za-z][^>]*>/gs)) {
    const tag = tagMatch[0];
    const line = html.slice(0, tagMatch.index).split(/\r?\n/).length;
    for (const attribute of localizableAttributes) {
      const value = tag.match(new RegExp(`(?:^|\\s)${attribute}="([^"]*)"`))?.[1];
      if (value === undefined) continue;
      const key = tag.match(new RegExp(`data-i18n-${attribute}="([^"]+)"`))?.[1];
      assert.ok(key, `${attribute} on index.html:${line} must have a locale binding`);
      assert.equal(
        MESSAGE_CATALOG.en[key],
        value,
        `${attribute} on index.html:${line} must match its English locale message`,
      );
      assert.equal(
        typeof MESSAGE_CATALOG['zh-CN'][key],
        'string',
        `${attribute} on index.html:${line} must have a Chinese locale message`,
      );
      checked += 1;
    }
  }

  assert.ok(checked >= 100, 'the static accessibility audit must cover the primary UI');
});

test('runtime translation calls reference keys present in both locale catalogues', () => {
  const modules = [
    './main.js',
    './hud.js',
    './keySetup.js',
    './firstRunExperience.js',
    './scenes/director.js',
    './voice/gevRealtime.js',
    './data/manager.js',
    './data/militaryAwareness.js',
    './data/rocketLaunches.js',
  ];
  const keys = modules.flatMap((relativePath) => {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    return [...source.matchAll(/\bt\('([A-Za-z][A-Za-z0-9_.-]*)'/g)]
      .map((match) => match[1]);
  });

  assert.ok(keys.length > 20, 'runtime modules must keep meaningful direct i18n coverage');
  for (const key of new Set(keys)) {
    assert.equal(typeof MESSAGE_CATALOG.en[key], 'string', `missing runtime English message: ${key}`);
    assert.equal(
      typeof MESSAGE_CATALOG['zh-CN'][key],
      'string',
      `missing runtime Chinese message: ${key}`,
    );
  }
});

test('data status and mission runtime surfaces have complete bilingual messages', () => {
  const requiredKeys = [
    'feed.nominal',
    'feed.loading',
    'feed.degraded',
    'feed.stale',
    'feed.fallback',
    'feed.unavailable',
    'data.layerStateLabel',
    'context.preparingLaunchSite',
    'context.liftoff',
    'context.ascentReplay',
    'context.ascentEstimate',
    'context.orbitReplay',
    'context.replayPaused',
    'context.launchStandby',
    'context.recovered',
    'context.lost',
    'context.recoveryAttempt',
    'context.noRecoveryData',
    'context.noMissionsInWindow',
    'context.unspecified',
    'context.unspecifiedOperator',
    'context.dateUnavailable',
    'context.positionUnavailable',
    'context.distanceDownrange',
    'context.flightNumber',
    'context.reused',
    'context.noStageRecoveryData',
    'context.flightVesselWindow',
    'context.contextReady',
    'context.globalContextOff',
    'context.selectObservedMappedSubject',
    'context.enableObservedMappedProximity',
    'hud.summaryLabel',
    'hud.awaitingTelemetry',
  ];

  for (const key of requiredKeys) {
    assert.equal(typeof MESSAGE_CATALOG.en[key], 'string', `missing English message: ${key}`);
    assert.equal(
      typeof MESSAGE_CATALOG['zh-CN'][key],
      'string',
      `missing Chinese message: ${key}`,
    );
    assert.notEqual(
      MESSAGE_CATALOG['zh-CN'][key],
      MESSAGE_CATALOG.en[key],
      `Chinese message must be localized: ${key}`,
    );
  }
});

test('static cockpit, CCTV, Radio, and Display bindings have bilingual messages', () => {
  const requiredKeys = [
    'cockpit.aircraftCockpitView',
    'cockpit.visionStyle',
    'cockpit.previousVisionStyle',
    'cockpit.previousVisionTitle',
    'cockpit.nextVisionStyle',
    'cockpit.nextVisionTitle',
    'cockpit.currentAircraftHeading',
    'cockpit.contactSummary',
    'cockpit.contactNavigation',
    'cockpit.briefingCarousel',
    'cockpit.briefingControls',
    'cockpit.liveSignals',
    'cockpit.regionalNews',
    'cockpit.localInfo',
    'cctv.camera',
    'cctv.cameraPose',
    'cctv.dragCameraHint',
    'cctv.headingHint',
    'cctv.pitchHint',
    'cctv.fovHint',
    'cctv.rangeHint',
    'cctv.heightHint',
    'cctv.northHint',
    'cctv.eastHint',
    'context.openCompactRadioControls',
    'context.compactRadioControls',
    'context.openDetailedRadioControls',
    'context.closeCompactRadioControls',
    'context.compactRadioVolume',
    'radio.previousFiltered',
    'radio.playSelected',
    'radio.nextFiltered',
    'cockpit.expandDisplayOptions',
    'cockpit.displayOptions',
    'cockpit.expandRadioControls',
    'cockpit.compactRadioControls',
    'cockpit.radioVolume',
    'hud.label',
    'hud.toggleTitle',
    'detection.label',
    'detection.toggleTitle',
    'detection.density',
    'detection.fade',
    'detection.outside',
    'scope.label',
    'scope.feather',
    'scope.toggleTitle',
    'scope.featherTitle',
    'panel.cleanUi',
    'panel.exitCleanView',
    'panel.cleanUiTitle',
    'panel.exitCleanViewTitle',
    'cctv.feedFrame',
  ];
  for (const key of requiredKeys) {
    assert.equal(typeof MESSAGE_CATALOG.en[key], 'string', `missing English message: ${key}`);
    assert.equal(typeof MESSAGE_CATALOG['zh-CN'][key], 'string', `missing Chinese message: ${key}`);
  }
  assert.equal(MESSAGE_CATALOG['zh-CN']['style.normal'], '标准');
  assert.equal(MESSAGE_CATALOG['zh-CN']['app.title'], '情报视图');
});

test('browser title and both visible brand surfaces use the localized system name', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/data-i18n="app\.title"/g) || []).length, 3);
  assert.match(html, /<title[^>]*data-i18n="app\.title"[^>]*>GOD'S EYE VIEW<\/title>/);
  assert.match(html, /<h1>[\s\S]*?<span[^>]*data-i18n="app\.title"[^>]*>GOD'S EYE VIEW<\/span>[\s\S]*?<\/h1>/);
  assert.match(html, /<h2[^>]*>[\s\S]*?<span[^>]*data-i18n="app\.title"[^>]*>GOD'S EYE VIEW<\/span>[\s\S]*?<\/h2>/);
});
