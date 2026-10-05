import assert from 'node:assert/strict';
import test from 'node:test';

import { createI18n } from './i18n.js';
import { createKnownDomLocalizer, initLocaleUi } from './localeUi.js';

function makeManager(initial = 'en') {
  let locale = initial;
  const listeners = new Set();
  const calls = [];
  return {
    calls,
    getLocale: () => locale,
    init(root) { calls.push(['init', root]); },
    translateDocument(root, requestedLocale) { calls.push(['translate', root, requestedLocale]); },
    t(key) {
      const values = {
        'language.chinese': '中文',
        'language.english': 'English',
        'language.switchToChinese': '切换到中文',
        'language.switchToEnglish': '切换到英文',
      };
      return values[key] || key;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setLocale(next, options) {
      locale = next;
      calls.push(['setLocale', next, options]);
      for (const listener of listeners) listener({ locale: next });
      return next;
    },
  };
}

function makeToggle() {
  const listeners = new Map();
  const attributes = new Map();
  const labelAttributes = new Map();
  const label = {
    textContent: '',
    setAttribute: (name, value) => labelAttributes.set(name, value),
    getAttribute: (name) => labelAttributes.get(name) ?? null,
  };
  return {
    listeners,
    attributes,
    label,
    querySelector: () => label,
    setAttribute: (name, value) => attributes.set(name, value),
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name) => listeners.delete(name),
  };
}

test('locale UI initializes the page and toggles between Chinese and English', () => {
  const manager = makeManager('en');
  const toggle = makeToggle();
  const root = {
    getElementById: (id) => (id === 'language-toggle' ? toggle : null),
  };

  const ui = initLocaleUi({ root, manager, observe: false });
  assert.equal(toggle.label.textContent, '中文');
  assert.equal(toggle.label.getAttribute('data-i18n'), 'language.chinese');
  assert.equal(toggle.attributes.get('data-locale'), 'zh-CN');
  assert.equal(toggle.attributes.get('data-i18n-aria-label'), 'language.switchToChinese');
  assert.equal(toggle.attributes.get('data-i18n-title'), 'language.switchToChinese');
  assert.equal(toggle.attributes.get('aria-label'), '切换到中文');

  toggle.listeners.get('click')();
  assert.equal(manager.getLocale(), 'zh-CN');
  assert.equal(toggle.label.textContent, 'English');
  assert.equal(toggle.label.getAttribute('data-i18n'), 'language.english');
  assert.equal(toggle.attributes.get('data-locale'), 'en');
  assert.equal(toggle.attributes.get('data-i18n-aria-label'), 'language.switchToEnglish');
  assert.equal(toggle.attributes.get('data-i18n-title'), 'language.switchToEnglish');
  assert.equal(toggle.attributes.get('aria-label'), '切换到英文');

  ui.destroy();
  assert.equal(toggle.listeners.has('click'), false);
});

test('locale UI is safe without a document or toggle', () => {
  const manager = makeManager('zh-CN');
  const ui = initLocaleUi({ root: {}, manager, observe: false });
  assert.equal(ui.toggle, null);
  ui.destroy();
});

test('known runtime text and accessibility attributes translate without touching live data', () => {
  const manager = createI18n({ initialLocale: 'zh-CN', storage: null, eventTarget: null });
  const textNode = { nodeType: 3, nodeValue: 'Radio off', parentElement: null };
  const callsignNode = { nodeType: 3, nodeValue: 'UAL123', parentElement: null };
  const attributes = new Map([
    ['title', 'Reset view'],
    ['aria-label', 'Globe actions'],
  ]);
  const root = {
    nodeType: 1,
    childNodes: [textNode, callsignNode],
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
  };
  textNode.parentElement = root;
  callsignNode.parentElement = root;

  const localizer = createKnownDomLocalizer({ manager });
  localizer.translateTree(root);
  assert.equal(textNode.nodeValue, '无线电关闭');
  assert.equal(callsignNode.nodeValue, 'UAL123');
  assert.equal(attributes.get('title'), '重置视图');
  assert.equal(attributes.get('aria-label'), '地球操作');

  manager.setLocale('en', { persist: false, root: null });
  localizer.translateTree(root);
  assert.equal(textNode.nodeValue, 'Radio off');
  assert.equal(attributes.get('title'), 'Reset view');
});

test('runtime state remains translatable inside an element with a static data-i18n binding', () => {
  const manager = createI18n({ initialLocale: 'zh-CN', storage: null, eventTarget: null });
  const attributes = new Map([['data-i18n', 'common.enable']]);
  const root = {
    nodeType: 1,
    childNodes: [],
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
  };
  const stateNode = {
    nodeType: 3,
    nodeValue: 'DISABLE',
    parentElement: root,
  };
  root.childNodes.push(stateNode);

  createKnownDomLocalizer({ manager }).translateTree(root);

  assert.equal(stateNode.nodeValue, '停用');
});
