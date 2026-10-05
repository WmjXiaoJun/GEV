import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initVisionUi } from './visionUi.js';
import { getLocale, setLocale, t } from '../i18n.js';
import en from '../locale/vision.en.js';
import zh from '../locale/vision.zh-CN.js';

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase(); this.children = []; this.attrs = new Map();
    this.listeners = new Map(); this.value = ''; this.hidden = false; this.disabled = false; this._text = '';
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(' '); }
  set innerHTML(_) { throw new Error('Unsafe HTML'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  getAttribute(key) { return this.attrs.get(key) ?? null; }
  removeAttribute(key) { this.attrs.delete(key); }
  addEventListener(key, fn) { this.listeners.set(key, [...(this.listeners.get(key) || []), fn]); }
  removeEventListener(key, fn) { this.listeners.set(key, (this.listeners.get(key) || []).filter((value) => value !== fn)); }
  emit(key) { if (!this.disabled) for (const fn of this.listeners.get(key) || []) fn({ target: this }); }
}

const descendants = (node) => [node, ...node.children.flatMap(descendants)];
const image = 'data:image/png;base64,iVBORw0KGgo=';
const detection = { class: 'plane', confidence: 0.91, box: { x: 10, y: 20, width: 50, height: 20 }, polygon: [[10, 20], [60, 20], [60, 40], [10, 40]] };
const done = (extra = {}) => ({ status: 'done', image, capturedAt: 1000,
  result: { model: 'yolo26n-obb', task: 'obb', image: { width: 100, height: 60 }, detections: [detection] }, ...extra });
function fixture(options = {}) {
  const roots = { 'ai-vision-scan': new Element('button'), 'ai-vision-panel': new Element('details') };
  const documentRef = {
    createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    getElementById: (id) => roots[id] || Object.values(roots).flatMap(descendants).find((node) => node.id === id),
  };
  const ui = initVisionUi({ documentRef, ...options });
  return { ui, roots, e: (id) => documentRef.getElementById(id), nodes: () => descendants(roots['ai-vision-panel']) };
}

test('detector is initially collapsed and uses aerial detection with a conservative threshold', () => {
  const f = fixture();
  assert.equal(f.e('ai-vision-panel').hidden, true);
  assert.deepEqual(f.ui.getOptions(), { task: 'obb', confidence: 0.25 });
  assert.equal(f.e('ai-vision-scan').getAttribute('aria-label'), t('vision.scan'));
  f.ui.destroy();
});

test('scan reads normalized options and opens the panel without duplicate requests while busy', () => {
  const calls = []; const f = fixture({ onScan: (options) => calls.push(options) });
  f.e('ai-vision-task').value = 'detect'; f.e('ai-vision-confidence').value = '0.45';
  f.e('ai-vision-confidence').emit('input');
  assert.equal(f.e('ai-vision-confidence-value').textContent, '45%');
  f.e('ai-vision-scan').emit('click');
  f.ui.setBusy(true); f.e('ai-vision-scan').emit('click');
  assert.deepEqual(calls, [{ task: 'detect', confidence: 0.45 }]);
  assert.equal(f.e('ai-vision-panel').hidden, false);
  assert.equal(f.e('ai-vision-task').disabled, true);
  assert.equal(f.e('ai-vision-cancel').hidden, false);
  f.ui.setBusy(false); assert.equal(f.e('ai-vision-task').disabled, false);
  f.ui.destroy();
});

test('invalid option values are bounded and never forwarded to the service', () => {
  const f = fixture();
  f.e('ai-vision-task').value = 'arbitrary';
  for (const [value, expected] of [['nan', 0.25], ['', 0.25], ['1', 0.95], ['-1', 0.05]]) {
    f.e('ai-vision-confidence').value = value;
    assert.deepEqual(f.ui.getOptions(), { task: 'obb', confidence: expected });
  }
  f.ui.destroy();
});

test('snapshot and oriented detections render as bounded vector overlays with matching labels', () => {
  const f = fixture(); f.ui.render(done());
  assert.equal(f.e('ai-vision-panel').open, true);
  assert.equal(f.e('ai-vision-image').src, image);
  assert.equal(f.e('ai-vision-overlay').getAttribute('viewBox'), '0 0 100 60');
  const polygon = f.nodes().find((node) => node.tagName === 'POLYGON');
  assert.equal(polygon.getAttribute('points'), '10,20 60,20 60,40 10,40');
  assert.equal(f.nodes().find((node) => node.tagName === 'TEXT').textContent, '1');
  assert.match(f.e('ai-vision-detections').textContent, /91%/);
  assert.match(f.e('ai-vision-meta').textContent, /yolo26n-obb/);
  assert.match(f.e('ai-vision-breakdown').textContent, /1/);
  assert.equal(f.e('ai-vision-image').width, 100);
  assert.equal(f.e('ai-vision-image').height, 60);
  f.ui.destroy();
});

test('captured image can be enlarged and restored without leaving the detection panel', () => {
  const f = fixture();
  f.ui.render(done());
  const zoom = f.e('ai-vision-zoom');
  assert.equal(zoom.getAttribute('aria-label'), t('vision.zoomIn'));
  zoom.emit('click');
  assert.match(f.e('ai-vision-preview').className, /is-zoomed/);
  assert.equal(zoom.getAttribute('aria-label'), t('vision.zoomOut'));
  zoom.emit('click');
  assert.doesNotMatch(f.e('ai-vision-preview').className, /is-zoomed/);
  f.ui.destroy();
});

test('vision panel exposes a one-click current-view question for the LLM', () => {
  let asked = 0;
  const f = fixture({ onAsk: () => { asked += 1; } });
  f.ui.render(done());
  assert.equal(f.e('ai-vision-ask').disabled, false);
  f.e('ai-vision-ask').emit('click');
  assert.equal(asked, 1);
  f.ui.setBusy(true);
  assert.equal(f.e('ai-vision-ask').disabled, true);
  f.ui.destroy();
});

test('axis-aligned boxes render and clamp to the captured image', () => {
  const f = fixture(); const result = { ...done().result, task: 'detect', detections: [{ class: 'car', confidence: 0.7, box: { x: -10, y: -20, width: 130, height: 100 } }] };
  f.ui.render(done({ result }));
  const rectangle = f.nodes().find((node) => node.tagName === 'RECT');
  assert.equal(rectangle.getAttribute('x'), '0'); assert.equal(rectangle.getAttribute('y'), '0');
  assert.equal(rectangle.getAttribute('width'), '100'); assert.equal(rectangle.getAttribute('height'), '60');
  f.ui.destroy();
});

test('rotated polygon point objects from the local proxy keep the exact orientation', () => {
  const f = fixture();
  f.ui.render(done({ result: { ...done().result, detections: [{ ...detection,
    polygon: [{ x: 20, y: 10 }, { x: 60, y: 20 }, { x: 50, y: 40 }, { x: 10, y: 30 }],
  }] } }));
  assert.equal(f.nodes().find((node) => node.tagName === 'POLYGON')?.getAttribute('points'), '20,10 60,20 50,40 10,30');
  f.ui.destroy();
});

test('all 300 allowed detections are counted and truncated results are explicit lower bounds', () => {
  const f = fixture();
  for (const count of [201, 300, 301]) {
    f.ui.render(done({ result: { ...done().result, detections: Array.from({ length: count }, () => detection) } }));
    assert.equal(f.e('ai-vision-detections').children.length, Math.min(count, 300));
    const expected = count > 300 ? 'vision.countTruncated' : 'vision.count';
    assert.equal(f.e('ai-vision-status').textContent, t(expected, { count: Math.min(count, 300) }));
  }
  f.ui.render(done({ result: { ...done().result, truncated: true } }));
  assert.equal(f.e('ai-vision-status').textContent, t('vision.countTruncated', { count: 1 }));
  assert.equal(f.e('ai-vision-summary').textContent, t('vision.summaryTruncated', { count: 1 }));
  f.ui.destroy();
});

test('malformed geometry is not drawn and untrusted labels are rendered as text', () => {
  const f = fixture();
  f.ui.render(done({ result: { ...done().result, detections: [
    { ...detection, class: '<img src=x onerror=alert(1)>', polygon: null },
    { ...detection, polygon: [[NaN, 1], [2, 3], [4, 5]], box: { x: 3, y: 4, width: -2, height: -2 } },
    { ...detection, confidence: Infinity }, { ...detection, box: { x: 'x', y: 2, width: 3, height: 4 }, polygon: null },
  ] } }));
  assert.equal(f.e('ai-vision-overlay').children.length, 1);
  assert.ok(f.e('ai-vision-detections').textContent.includes('<img src=x onerror=alert(1)>'));
  f.ui.destroy();
});

test('invalid screenshot protocols or dimensions cannot create an image or geometry', () => {
  const f = fixture();
  for (const unsafeImage of ['https://evil.invalid/x.png', 'javascript:alert(1)', 'data:image/svg+xml;base64,aaa']) {
    f.ui.render(done({ image: unsafeImage }));
    assert.equal(f.e('ai-vision-preview').hidden, true);
    assert.equal(f.e('ai-vision-overlay').children.length, 0);
  }
  f.ui.render(done({ result: { ...done().result, image: { width: Infinity, height: 60 } } }));
  assert.equal(f.e('ai-vision-preview').hidden, true);
  f.ui.destroy();
});

test('empty results are uncertainty, not proof that an airport or target does not exist', () => {
  const f = fixture(); f.ui.render(done({ result: { ...done().result, detections: [] } }));
  assert.equal(f.e('ai-vision-status').textContent, t('vision.empty'));
  assert.equal(f.e('ai-vision-limit').textContent, t('vision.limit'));
  assert.equal(f.e('ai-vision-detections').children.length, 0);
  f.ui.destroy();
});

test('stale snapshots are marked without reopening a manually collapsed preview', () => {
  const f = fixture(); const state = done(); f.ui.render(state);
  f.e('ai-vision-panel').open = false; f.ui.render({ ...state, stale: true });
  assert.equal(f.e('ai-vision-panel').open, false);
  assert.equal(f.e('ai-vision-stale').hidden, false);
  assert.equal(f.e('ai-vision-stale').textContent, t('vision.stale'));
  assert.equal(f.e('ai-vision-overlay').children.length, 1);
  f.ui.destroy();
});

test('running and error states discard previous detections and expose safe errors', () => {
  const f = fixture(); f.ui.render(done()); f.ui.render({ status: 'running' });
  assert.equal(f.e('ai-vision-overlay').children.length, 0);
  assert.equal(f.e('ai-vision-status').textContent, t('vision.running'));
  for (const code of ['VISION_UNAVAILABLE', 'VISION_TIMEOUT', 'VISION_CAPTURE_UNAVAILABLE', 'VISION_IMAGE_TOO_LARGE', 'VISION_CANCELLED', 'private details', '__proto__']) {
    f.ui.render({ status: 'error', error: code });
    assert.equal(f.e('ai-vision-scan').disabled, false);
    assert.notEqual(f.e('ai-vision-status').textContent, code);
    assert.equal(f.e('ai-vision-overlay').children.length, 0);
  }
  f.ui.destroy();
});

test('every proxy error code has a safe localized message, including prototype-like values', () => {
  const f = fixture();
  const expected = { VISION_INVALID_REQUEST: 'invalidImage', VISION_REQUEST_TOO_LARGE: 'imageTooLarge',
    VISION_LOCAL_ONLY: 'localOnly', VISION_CONTENT_TYPE: 'invalidImage', VISION_RATE_LIMITED: 'rateLimited',
    VISION_INFERENCE_FAILED: 'generic', VISION_UPSTREAM_ERROR: 'unavailable', ['__proto__']: 'generic', constructor: 'generic' };
  for (const [error, key] of Object.entries(expected)) {
    f.ui.render({ status: 'error', error });
    assert.equal(f.e('ai-vision-status').textContent, t(`vision.error.${key}`));
  }
  f.ui.destroy();
});

test('unloadable image pixels cannot keep apparently successful object boxes', () => {
  const f = fixture(); f.ui.render(done()); f.e('ai-vision-image').emit('error');
  assert.equal(f.e('ai-vision-preview').hidden, true);
  assert.equal(f.e('ai-vision-overlay').children.length, 0);
  assert.equal(f.e('ai-vision-status').textContent, t('vision.error.invalidResponse'));
  f.ui.destroy();
});

test('both catalogs cover every detector class and control without untranslated keys', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  assert.equal(Object.keys(en).filter((key) => key.startsWith('vision.class.')).length, 95);
  for (const value of Object.values(zh)) assert.ok(value && typeof value === 'string');
});

test('cancel invokes the controller and clear removes captured pixels and collapses preview', () => {
  let cancelled = 0; const f = fixture({ onCancel: () => { cancelled += 1; } });
  f.ui.render({ status: 'running' }); f.e('ai-vision-cancel').emit('click');
  assert.equal(cancelled, 1); f.ui.render(done()); f.ui.clear();
  assert.equal(f.e('ai-vision-panel').hidden, true);
  assert.equal(f.e('ai-vision-image').getAttribute('src'), null);
  assert.equal(f.e('ai-vision-overlay').children.length, 0);
  f.ui.destroy();
});

test('locale changes retranslate status, controls and object labels', () => {
  const previous = getLocale(); const f = fixture();
  try {
    f.ui.render(done()); setLocale('zh-CN', { persist: false });
    assert.equal(f.e('ai-vision-scan').title, '识别当前画面');
    assert.ok(f.e('ai-vision-detections').textContent.includes('飞机'));
    assert.ok(f.e('ai-vision-limit').textContent.includes('机场边界'));
    setLocale('en', { persist: false });
    assert.equal(f.e('ai-vision-scan').title, 'Detect current view');
    assert.ok(f.e('ai-vision-detections').textContent.includes('Plane'));
  } finally { f.ui.destroy(); setLocale(previous, { persist: false }); }
});

test('scan errors are handled and destroyed UI cannot invoke callbacks', async () => {
  let calls = 0; const f = fixture({ onScan: async () => { calls += 1; throw new Error('secret'); } });
  f.e('ai-vision-scan').emit('click'); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.e('ai-vision-status').textContent, t('vision.error.generic'));
  f.ui.destroy(); f.e('ai-vision-scan').emit('click'); f.ui.render(done());
  assert.equal(calls, 1); assert.equal(f.e('ai-vision-panel').hidden, true);
});

test('absent hosts retain an inert compatible interface', () => {
  const ui = initVisionUi({ documentRef: null });
  assert.deepEqual(ui.getOptions(), { task: 'obb', confidence: 0.25 });
  ui.render(done()); ui.setBusy(true); ui.clear(); ui.destroy();
});

test('HTML includes localized scan entry and hidden compact preview before chat history', async () => {
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="ai-vision-scan"[^>]*data-i18n-aria-label="vision.scan"/);
  assert.match(html, /<details id="ai-vision-panel"[^>]*hidden/);
  assert.ok(html.indexOf('id="ai-vision-panel"') < html.indexOf('id="ai-messages"'));
  const css = await readFile(new URL('./vision.css', import.meta.url), 'utf8');
  assert.match(css, /max-height:/); assert.match(css, /overflow-y: auto/);
});
