import test from 'node:test';
import assert from 'node:assert/strict';
import { initIntelligenceUi } from './intelligenceUi.js';
import { createActionGuard } from './actionGuard.js';
import { t, setLocale, getLocale } from '../i18n.js';
import en from '../locale/intelligence.en.js';
import zh from '../locale/intelligence.zh-CN.js';
import { readFile } from 'node:fs/promises';

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase(); this.children = []; this.listeners = new Map();
    this.attrs = new Map(); this.dataset = {}; this.value = ''; this.hidden = false;
    this.disabled = false; this.checked = false; this._text = '';
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((e) => e.textContent).join(' '); }
  set innerHTML(_value) { throw new Error('Unsafe HTML injection'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  addEventListener(name, callback) { this.listeners.set(name, [...(this.listeners.get(name) || []), callback]); }
  removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) || []).filter((c) => c !== callback)); }
  emit(name, event = {}) { if (!this.disabled) for (const callback of this.listeners.get(name) || []) callback({ preventDefault() {}, target: this, ...event }); }
  focus() { this.focused = true; }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const bounds = { west: -10, south: -10, east: 10, north: 10 };
const snapshot = (records = []) => ({ bounds, generatedAt: 300, layers: [
  { id: 'earthquakes', name: 'Quakes', enabled: true, status: 'ready', source: 'USGS', updatedAt: 100, records },
  { id: 'flights', name: 'Flights', enabled: false, status: 'disabled', source: null, updatedAt: null, records: [] },
] });
const record = (id) => ({ id, name: id, latitude: 0, longitude: 0, eventAt: 200 });

function descendants(element) { return [element, ...element.children.flatMap(descendants)]; }
async function fixture(extra = {}) {
  let current = snapshot([record('q1')]);
  let reads = 0;
  const sent = [];
  const actions = [];
  const timers = new Map();
  const hosts = Object.fromEntries(['ai-intelligence-panel', 'ai-watch-panel', 'ai-action-review', 'ai-undo'].map((id) => [id, new Element()]));
  const documentRef = Object.assign(new Element(), {
    visibilityState: 'visible',
    getElementById: (id) => hosts[id] ?? Object.values(hosts).flatMap(descendants).find((e) => e.id === id),
    createElement: (tag) => new Element(tag),
    defaultView: { setInterval: (callback, delay) => { timers.set(1, { callback, delay }); return 1; }, clearInterval: (id) => timers.delete(id) },
  });
  let ui;
  const guard = createActionGuard({
    runAction: async (name, args) => { actions.push({ name, args }); return { ok: true }; },
    captureState: () => ({}), restoreState: async () => ({ ok: true }),
    onChange: (state) => ui?.renderAction(state),
  });
  ui = initIntelligenceUi({
    documentRef, guard, getSnapshot: async () => { reads += 1; return current; },
    getViewSnapshot: async () => ({ ...current, scope: 'viewport', viewport: { available: true, width: 1000, height: 700 },
      layers: current.layers.map((layer) => ({ ...layer, count: layer.count ?? layer.records?.length ?? null })) }),
    sendText: async (value) => { sent.push(value); }, openConversation() {}, ...extra,
  });
  await settle();
  return { ui, guard, documentRef, hosts, timers, sent, actions, get reads() { return reads; },
    setSnapshot: (value) => { current = value; }, e: (id) => documentRef.getElementById(id),
    areaInput: () => descendants(hosts['ai-watch-panel']).find((e) => e.dataset.areaName),
    find: (attr) => descendants(hosts['ai-watch-panel']).find((e) => e.dataset[attr]),
  };
}

test('brief renders bounds, real sources, timestamps, loaded-only scope and unknown values safely', async () => {
  const f = await fixture();
  try {
    const text = f.hosts['ai-intelligence-panel'].textContent;
    assert.ok(text.includes('USGS'));
    assert.ok(text.includes(t('intel.layer.earthquakes')));
    assert.ok(text.includes('q1'));
    assert.ok(text.includes(t('intel.viewportOnly')));
    assert.ok(text.includes(t('intel.unknown')));
    assert.ok(text.includes('-10.0000'));
    assert.equal(f.e('intel-refresh').disabled, false);
    f.setSnapshot(snapshot([record('<img src=x onerror=alert(1)>')]));
    await f.ui.refresh();
    assert.ok(f.hosts['ai-intelligence-panel'].textContent.includes('<img src=x onerror=alert(1)>'));
  } finally { f.ui.destroy(); }
});

test('viewport records expose search, pagination, export and guarded locate controls', async () => {
  const f = await fixture({ getViewSnapshot: () => ({ ...snapshot(Array.from({ length: 28 }, (_, i) => record(`q${i}`))), scope: 'viewport', viewport: { available: true, width: 1000, height: 700 }, layers: [{ ...snapshot().layers[0], records: Array.from({ length: 28 }, (_, i) => record(`q${i}`)), count: 28 }] }) });
  try {
    assert.ok(f.e('intel-record-search'));
    assert.ok(f.e('intel-record-export'));
    assert.equal(f.e('intel-record-next').disabled, false);
    f.e('intel-record-search').value = 'q27';
    f.e('intel-record-search').emit('input');
    const row = descendants(f.hosts['ai-intelligence-panel']).find((node) => node.dataset.recordId === 'q27');
    assert.ok(row);
    row.emit('click');
    assert.equal(f.guard.getState().pending.name, 'fly_to_location');
  } finally { f.ui.destroy(); }
});

test('brief uses viewport records while watch areas retain geographic records', async () => {
  const f = await fixture({ getViewSnapshot: () => ({ ...snapshot([record('viewport-only')]), scope: 'viewport',
    viewport: { available: true, width: 1000, height: 700 }, layers: [{ ...snapshot().layers[0], records: [record('viewport-only')], count: 9 }] }) });
  try {
    const text = f.hosts['ai-intelligence-panel'].textContent;
    assert.ok(text.includes('viewport-only'));
    assert.equal(text.includes('q1'), false);
    f.e('intel-watch-name').value = 'Region';
    f.e('intel-watch-add').emit('click');
    await settle();
    f.setSnapshot(snapshot([record('q1'), record('q2')]));
    await f.ui.refresh();
    assert.ok(f.hosts['ai-watch-panel'].textContent.includes('q2'));
    assert.equal(f.hosts['ai-intelligence-panel'].textContent.includes('q2'), false);
  } finally { f.ui.destroy(); }
});

test('missing viewport reader cannot show geographic records or a confident zero', async () => {
  const f = await fixture({ getViewSnapshot: undefined });
  try {
    const text = f.hosts['ai-intelligence-panel'].textContent;
    assert.ok(text.includes(t('intel.unavailable')));
    assert.equal(text.includes('q1'), false);
    assert.equal(f.e('intel-watch-add').disabled, false);
  } finally { f.ui.destroy(); }
});

test('viewport breakdown renders source categories and explicit unknown usage safely', async () => {
  const f = await fixture({ getViewSnapshot: () => ({ ...snapshot(), scope: 'viewport', viewport: { available: true, width: 1000, height: 700 }, layers: [{
    ...snapshot().layers[0], count: 15, breakdown: {
      category: { values: [{ value: '<img onerror=bad>', count: 10 }], unknownCount: 3, otherCount: 2 },
      usage: { values: [], unknownCount: 15, otherCount: 0 },
    },
  }] }) });
  try {
    const text = f.hosts['ai-intelligence-panel'].textContent;
    for (const expected of [t('intel.breakdown.category'), '<img onerror=bad>: 10', `${t('intel.unknown')}: 15`, `${t('intel.other')}: 2`]) assert.ok(text.includes(expected), expected);
    const previous = getLocale();
    try {
      setLocale('zh-CN', { persist: false });
      assert.equal(t('ai.action.get_view_statistics'), '统计当前视口数据');
      assert.equal(t('intel.breakdown.usage'), '来源标注用途');
    } finally { setLocale(previous, { persist: false }); }
  } finally { f.ui.destroy(); }
});

test('overview distinguishes unknown totals, partial lower bounds and confirmed zero', async () => {
  const totalText = (f) => descendants(f.hosts['ai-intelligence-panel'])
    .find((node) => node.className === 'intel-summary').children
    .find((row) => row.children[0].textContent === t('intel.total')).children[1].textContent;
  const f = await fixture();
  try {
    f.setSnapshot({ ...snapshot(), layers: [{ ...snapshot().layers[0], status: 'unsupported', count: null }] });
    await f.ui.refresh();
    assert.equal(totalText(f), t('intel.unavailable'));
    f.setSnapshot({ ...snapshot(), layers: [{ ...snapshot().layers[0], count: 9 },
      { ...snapshot().layers[1], enabled: true, status: 'error', count: null }] });
    await f.ui.refresh();
    assert.equal(totalText(f), '>=9');
    assert.ok(f.hosts['ai-intelligence-panel'].textContent.includes(t('intel.partialCoverage')));
    f.setSnapshot({ ...snapshot(), layers: [{ ...snapshot().layers[0], count: 0, records: [] }] });
    await f.ui.refresh();
    assert.equal(totalText(f), '0');
    assert.equal(f.hosts['ai-intelligence-panel'].textContent.includes(t('intel.partialCoverage')), false);
    f.setSnapshot({ ...snapshot(), layers: [{ ...snapshot().layers[0], count: 5, countIsLowerBound: true }] });
    await f.ui.refresh();
    assert.equal(totalText(f), '>=5');
  } finally { f.ui.destroy(); }
});

test('AI interpretation sends a localized request and disables duplicate clicks while working', async () => {
  let release;
  const sent = [];
  const f = await fixture({ sendText: (value, options) => { sent.push({ value, options }); return new Promise((resolve) => { release = resolve; }); } });
  try {
    f.e('intel-interpret').emit('click');
    f.e('intel-interpret').emit('click');
    await settle();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { value: t('intel.briefPrompt'), options: { intent: 'brief' } });
    assert.equal(f.e('intel-interpret').disabled, true);
    release();
    await settle();
    assert.equal(f.e('intel-interpret').disabled, false);
  } finally { f.ui.destroy(); }
});

test('saving watches establishes a baseline, detects new IDs and can mark them read', async () => {
  const f = await fixture();
  try {
    f.e('intel-watch-name').value = 'Harbor';
    f.e('intel-watch-add').emit('click');
    await settle();
    assert.equal(f.areaInput().value, 'Harbor');
    assert.equal(f.e('intel-unread').textContent, '0');
    f.setSnapshot(snapshot([record('q1'), record('q2')]));
    await f.ui.refresh();
    assert.equal(f.e('intel-unread').textContent, '1');
    assert.ok(f.hosts['ai-watch-panel'].textContent.includes('q2'));
    assert.ok(f.hosts['ai-watch-panel'].textContent.includes('USGS'));
    f.e('intel-mark-read').emit('click');
    assert.equal(f.e('intel-unread').textContent, '0');
    assert.equal(f.e('intel-mark-read').disabled, true);
  } finally { f.ui.destroy(); }
});

test('watch rename, pause, locate through confirmation and deletion are functional', async () => {
  const f = await fixture();
  try {
    f.e('intel-watch-name').value = 'Area';
    f.e('intel-watch-add').emit('click');
    await settle();
    f.areaInput().value = 'Renamed';
    f.areaInput().emit('change');
    assert.equal(f.areaInput().value, 'Renamed');
    const paused = f.find('areaPaused');
    paused.checked = true;
    paused.emit('change');
    assert.equal(f.find('areaPaused').checked, true);
    f.find('areaLocate').emit('click');
    assert.equal(f.actions.length, 0);
    assert.equal(f.guard.getState().pending.name, 'fly_to_location');
    assert.equal(f.hosts['ai-action-review'].hidden, false);
    f.e('intel-action-confirm').emit('click');
    await settle();
    assert.equal(f.actions.length, 1);
    assert.equal(f.actions[0].args.latitude, 0);
    assert.equal(f.e('ai-undo').disabled, false);
    f.e('ai-undo').emit('click');
    await settle();
    assert.equal(f.e('ai-undo').disabled, true);
    f.find('areaRemove').emit('click');
    assert.equal(f.areaInput(), undefined);
  } finally { f.ui.destroy(); }
});

test('rejecting preview leaves map unchanged and raw parameters render as plain text', async () => {
  const f = await fixture();
  try {
    const waiting = f.guard.runAction('fly_to_location', { query: '<img src=x>' });
    assert.ok(f.hosts['ai-action-review'].textContent.includes('<img src=x>'));
    f.e('intel-action-reject').emit('click');
    assert.equal((await waiting).cancelled, true);
    assert.equal(f.actions.length, 0);
    assert.equal(f.hosts['ai-action-review'].hidden, true);
  } finally { f.ui.destroy(); }
});

test('action preview displays localized countdown without replacing focused controls on ticks', async () => {
  const previous = getLocale();
  const f = await fixture();
  try {
    setLocale('zh-CN', { persist: false });
    const pending = { name: 'zoom_to_globe', arguments: {}, remainingSeconds: 3 };
    f.ui.renderAction({ pending });
    const countdown = f.e('intel-action-countdown');
    assert.ok(countdown, 'countdown is visible in the action preview');
    assert.equal(countdown.textContent, '3 秒后自动执行');
    assert.equal(countdown.getAttribute('role'), 'status');
    const reject = f.e('intel-action-reject');
    const confirm = f.e('intel-action-confirm');
    reject.focus();
    for (const seconds of [2, 1]) {
      f.ui.renderAction({ pending: { ...pending, remainingSeconds: seconds } });
      assert.equal(f.e('intel-action-countdown'), countdown);
      assert.equal(countdown.textContent, `${seconds} 秒后自动执行`);
      assert.equal(f.e('intel-action-reject'), reject);
      assert.equal(f.e('intel-action-confirm'), confirm);
    }
    setLocale('en', { persist: false });
    assert.equal(f.e('intel-action-countdown').textContent, 'Auto-executing in 1s');
    assert.equal(f.e('intel-action-reject').textContent.includes('Reject'), true);
    f.ui.renderAction({ pending: null, executing: true });
    assert.equal(f.e('intel-action-countdown'), undefined);
    assert.ok(f.hosts['ai-action-review'].textContent.includes(t('intel.executing')));
  } finally { f.ui.destroy(); setLocale(previous, { persist: false }); }
});

test('polling observes only visible documents and destroy cleans timer and listeners', async () => {
  const f = await fixture();
  const timer = f.timers.get(1);
  assert.equal(timer.delay, 10000);
  const before = f.reads;
  f.documentRef.visibilityState = 'hidden';
  timer.callback();
  await settle();
  assert.equal(f.reads, before);
  f.documentRef.visibilityState = 'visible';
  timer.callback();
  await settle();
  assert.equal(f.reads, before + 1);
  f.ui.destroy();
  assert.equal(f.timers.size, 0);
  const stopped = f.reads;
  f.documentRef.emit('visibilitychange');
  f.e('intel-refresh').emit('click');
  await settle();
  assert.equal(f.reads, stopped);
});

test('snapshot and AI errors surface messages without leaking internals or stale save data', async () => {
  const f = await fixture({ getSnapshot: async () => { throw new Error('private path'); }, sendText: async () => { throw new Error('private API key'); } });
  try {
    assert.ok(f.e('intel-brief-status').textContent.includes(t('intel.refreshError')));
    assert.equal(f.e('intel-watch-add').disabled, true);
    assert.equal(f.hosts['ai-intelligence-panel'].textContent.includes('private path'), false);
    f.e('intel-interpret').emit('click');
    await settle();
    assert.equal(f.hosts['ai-intelligence-panel'].textContent.includes('private API key'), false);
  } finally { f.ui.destroy(); }
});

test('invalid names and unavailable views do not create watches', async () => {
  const f = await fixture();
  try {
    f.e('intel-watch-name').value = ' ';
    f.e('intel-watch-add').emit('click');
    await settle();
    assert.ok(f.e('intel-watch-status').textContent.includes(t('intel.invalidWatch')));
    assert.equal(f.areaInput(), undefined);
    f.setSnapshot({ layers: [] });
    await f.ui.refresh();
    assert.equal(f.e('intel-watch-add').disabled, true);
  } finally { f.ui.destroy(); }
});

test('all intelligence strings have English and Chinese counterparts and locale updates preserve drafts', async () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  assert.ok(Object.keys(en).every((key) => key.startsWith('intel.')));
  const previous = getLocale();
  const f = await fixture();
  try {
    f.e('intel-watch-name').value = 'draft';
    setLocale('zh-CN');
    assert.equal(f.e('intel-watch-name').value, 'draft');
    assert.equal(f.e('intel-watch-name').placeholder, t('intel.areaName'));
    setLocale('en');
    assert.equal(f.e('intel-watch-name').value, 'draft');
  } finally { f.ui.destroy(); setLocale(previous); }
});

test('snapshot comparison reports moved viewport targets and asks workspace to draw the diff', async () => {
  let current = snapshot([record('stay'), { ...record('moving'), latitude: 0, longitude: 0 }]);
  const drawn = [];
  const f = await fixture({
    getSnapshot: async () => current,
    getViewSnapshot: async () => ({ ...current, scope: 'viewport', viewport: { available: true, width: 1000, height: 700 }, layers: current.layers.map((layer) => ({ ...layer, count: layer.records.length })) }),
    drawComparison: async (comparison) => { drawn.push(comparison); },
  });
  try {
    f.e('intel-snapshot-capture').emit('click');
    await new Promise((resolve) => setTimeout(resolve, 20));
    current = snapshot([record('stay'), { ...record('moving'), latitude: 0.01, longitude: 0 }]);
    f.e('intel-snapshot-compare').emit('click');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(drawn.length, 1);
    assert.equal(drawn[0].movedCount, 1);
    assert.ok(f.e('intel-brief-status').textContent.includes('moving'));
  } finally { f.ui.destroy(); }
});

test('missing hosts are a safe no-op and refresh recovers after a synchronous snapshot failure', async () => {
  const noop = initIntelligenceUi({ documentRef: { getElementById: () => null } });
  assert.equal(await noop.refresh(), null);
  noop.renderAction({});
  noop.destroy();
  let fail = true;
  const f = await fixture({ getSnapshot: () => { if (fail) throw new Error('private'); return snapshot(); } });
  try {
    fail = false;
    assert.ok(await f.ui.refresh());
    assert.equal(f.e('intel-watch-add').disabled, false);
  } finally { f.ui.destroy(); }
});

test('concurrent refresh requests share one read and a destroyed UI ignores late snapshots', async () => {
  let release;
  let calls = 0;
  const f = await fixture({ getSnapshot: () => { calls += 1; return new Promise((resolve) => { release = resolve; }); } });
  const first = f.ui.refresh();
  assert.equal(first, f.ui.refresh());
  assert.equal(calls, 1);
  f.ui.destroy();
  release(snapshot());
  assert.equal(await first, null);
  assert.equal(await f.ui.refresh(), null);
});

test('truncated records, unavailable layers, simulations and unknown values remain explicit', async () => {
  const f = await fixture();
  try {
    f.setSnapshot({ ...snapshot(), layers: [{ id: 'custom', name: 'Custom', enabled: true, status: 'ready', source: null, updatedAt: null, truncated: true, countIsLowerBound: true,
      records: Array.from({ length: 6 }, (_, i) => ({ ...record(`s${i}`), name: null, eventAt: null, simulated: true })),
    }, { id: 'unknown', name: 'Unknown layer', enabled: true, status: 'mystery', records: [] }, { id: 'failed', name: 'Failed', enabled: true, status: 'ready', error: 'private detail', records: [] }] });
    await f.ui.refresh();
    const text = f.hosts['ai-intelligence-panel'].textContent;
    assert.ok(text.includes('>=6'));
    assert.ok(text.includes(t('intel.simulated')));
    assert.ok(text.includes(t('intel.status.unknown')));
    assert.ok(text.includes(t('intel.status.error')));
    assert.equal(text.includes('private detail'), false);
  } finally { f.ui.destroy(); }
});

test('preview parameters translate booleans, styles, layers and local place identifiers', async () => {
  const f = await fixture();
  try {
    f.ui.renderAction({ pending: { name: 'set_layer_visibility', arguments: { enabled: true, layerId: 'flights', locationId: 'london', style: 'thermal' } } });
    const text = f.hosts['ai-action-review'].textContent;
    for (const key of ['intel.value.true', 'intel.layer.flights', 'intel.location.london', 'intel.value.thermal']) assert.ok(text.includes(t(key)));
    for (const [error, key] of [['Map action could not be undone', 'intel.undoError'], ['Map state could not be saved', 'intel.snapshotError'], ['private server secret', 'intel.actionError']]) {
      f.ui.renderAction({ pending: null, error });
      assert.ok(f.hosts['ai-action-review'].textContent.includes(t(key)));
      assert.equal(f.hosts['ai-action-review'].textContent.includes('private server secret'), false);
    }
  } finally { f.ui.destroy(); }
});

test('locating a dateline area centers the crossing and handles runner errors', async () => {
  let captured;
  const f = await fixture({ guard: { getState: () => ({}), runAction: async (_name, args) => { captured = args; throw new Error('private endpoint'); } } });
  try {
    f.setSnapshot({ ...snapshot(), bounds: { west: 170, east: -170, south: -5, north: 5 } });
    await f.ui.refresh();
    f.e('intel-watch-name').value = 'Date line';
    f.e('intel-watch-add').emit('click');
    await settle();
    f.find('areaLocate').emit('click');
    await settle();
    assert.equal(captured.longitude, -180);
    assert.equal(captured.latitude, 0);
    assert.ok(f.e('intel-watch-status').textContent.includes(t('intel.operationError')));
  } finally { f.ui.destroy(); }
});

test('watch limit is visible, unchanged polls preserve active area rename drafts', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 11; i += 1) {
      f.e('intel-watch-name').value = `Area ${i}`;
      f.e('intel-watch-add').emit('click');
      await settle();
    }
    assert.ok(f.e('intel-watch-status').textContent.includes(t('intel.watchLimit')));
    f.areaInput().value = 'Unsaved rename';
    await f.ui.refresh();
    assert.equal(f.areaInput().value, 'Unsaved rename');
  } finally { f.ui.destroy(); }
});

test('completed actions offer global undo without switching back to conversation', async () => {
  const f = await fixture();
  try {
    const waiting = f.guard.runAction('zoom_to_globe', {});
    await f.guard.confirm();
    await waiting;
    assert.equal(f.hosts['ai-action-review'].hidden, false);
    assert.equal(f.e('intel-action-undo').disabled, false);
    f.e('intel-action-undo').emit('click');
    await settle();
    assert.equal(f.guard.getState().canUndo, false);
    assert.equal(f.hosts['ai-action-review'].hidden, true);
  } finally { f.ui.destroy(); }
});

test('clearing observations keeps saved watch areas and deduplication baselines', async () => {
  const f = await fixture();
  try {
    f.e('intel-watch-name').value = 'Area';
    f.e('intel-watch-add').emit('click');
    await settle();
    f.setSnapshot(snapshot([record('q1'), record('q2')]));
    await f.ui.refresh();
    assert.equal(f.e('intel-clear-alerts').disabled, false);
    f.e('intel-clear-alerts').emit('click');
    assert.equal(f.e('intel-unread').textContent, '0');
    assert.equal(f.e('intel-clear-alerts').disabled, true);
    assert.equal(f.areaInput().value, 'Area');
    await f.ui.refresh();
    assert.equal(f.e('intel-unread').textContent, '0');
  } finally { f.ui.destroy(); }
});

test('double-saving a watch while collecting the same snapshot creates one area', async () => {
  const f = await fixture();
  try {
    f.e('intel-watch-name').value = 'Single';
    f.e('intel-watch-add').emit('click');
    f.e('intel-watch-add').emit('click');
    await settle();
    const count = descendants(f.hosts['ai-watch-panel']).filter((e) => e.dataset.areaName).length;
    assert.equal(count, 1);
    assert.equal(f.e('intel-watch-status').textContent, '');
  } finally { f.ui.destroy(); }
});

test('four compact tabs retain readable labels and equal stable width at mobile sizes', async () => {
  const css = await readFile(new URL('./intelligence.css', import.meta.url), 'utf8');
  assert.match(css, /\.ai-assistant \.ai-tabs\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.ok(en['intel.tabConversation'].length <= 8);
  assert.ok(en['intel.tabSettings'].length <= 8);
});

test('watch name has an explicit save button and Enter commits changes without waiting for blur', async () => {
  const f = await fixture();
  try {
    f.e('intel-watch-name').value = 'Original';
    f.e('intel-watch-add').emit('click');
    await settle();
    assert.equal(f.find('areaSaveName')?.disabled, true);
    f.areaInput().value = 'Saved by button';
    f.areaInput().emit('input');
    assert.equal(f.find('areaSaveName').disabled, false);
    assert.equal(f.find('areaSaveName').title, t('intel.saveName'));
    f.find('areaSaveName').emit('click');
    assert.equal(f.areaInput().getAttribute('aria-label'), `${t('intel.rename')}: Saved by button`);
    assert.equal(f.find('areaSaveName').disabled, true);
    await f.ui.refresh();
    assert.equal(f.areaInput().value, 'Saved by button');
    f.areaInput().value = 'Saved by Enter';
    f.areaInput().emit('input');
    let prevented = false;
    f.areaInput().emit('keydown', { key: 'Enter', preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(f.areaInput().getAttribute('aria-label'), `${t('intel.rename')}: Saved by Enter`);
    assert.equal(f.find('areaSaveName').disabled, true);
  } finally { f.ui.destroy(); }
});

test('empty and unchanged names disable save while invalid blur preserves the draft', async () => {
  const f = await fixture();
  try {
    f.e('intel-watch-name').value = 'Original';
    f.e('intel-watch-add').emit('click');
    await settle();
    f.areaInput().value = ' Original ';
    f.areaInput().emit('input');
    assert.equal(f.find('areaSaveName')?.disabled, true);
    f.areaInput().value = ' ';
    f.areaInput().emit('input');
    assert.equal(f.find('areaSaveName').disabled, true);
    const input = f.areaInput();
    input.emit('change');
    assert.equal(f.areaInput(), input);
    assert.equal(input.value, ' ');
    assert.equal(input.getAttribute('aria-label'), `${t('intel.rename')}: Original`);
    assert.ok(f.e('intel-watch-status').textContent.includes(t('intel.invalidWatch')));
    input.value = 'Composition';
    input.emit('input');
    input.emit('keydown', { key: 'Enter', isComposing: true });
    assert.equal(input.getAttribute('aria-label'), `${t('intel.rename')}: Original`);
    input.emit('keydown', { key: 'Tab' });
    assert.equal(input.getAttribute('aria-label'), `${t('intel.rename')}: Original`);
  } finally { f.ui.destroy(); }
});
