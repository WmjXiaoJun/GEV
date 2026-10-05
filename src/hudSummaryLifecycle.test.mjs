import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'mgrs' ? { url: 'gev-hud-test:mgrs', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === 'gev-hud-test:mgrs'
      ? { format: 'module', source: 'export const forward = () => "MGRS";', shortCircuit: true }
      : next(url, context);
  },
});
const { IntelHUD } = await import('./hud.js');

function harness(t, fetchImpl) {
  const previousWindow = globalThis.window;
  const deadlines = [];
  globalThis.window = {
    setTimeout(callback, delay) { deadlines.push({ callback, delay }); return deadlines.length; },
    clearTimeout() {},
  };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  t.mock.method(globalThis, 'fetch', fetchImpl);
  const painted = [];
  const hud = Object.assign(Object.create(IntelHUD.prototype), {
    viewer: { camera: { moveEnd: { removeEventListener() {} } } },
    _latestMetrics: {}, _summaryDirty: true, _summaryRequest: null,
    _lastSummarySignature: '', _summaryRevision: 0,
    _composeSummary: () => 'fallback',
    _summaryContext: async () => ({ placeLabels: ['Austin'] }),
    _setSummaryText: (text) => painted.push(text),
  });
  return { hud, painted, deadlines };
}

const abortingFetch = (_url, { signal }) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
});
const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test('HUD allows the provider deadline and retries a genuine timeout in the same view', async (t) => {
  const { hud, painted, deadlines } = harness(t, abortingFetch);
  const pending = hud._updateSummary();
  await nextTick();
  assert.equal(deadlines[0].delay, 50_000);
  deadlines[0].callback();
  await pending;
  assert.equal(hud._summaryDirty, true);
  assert.equal(hud._lastSummarySignature, null);
  assert.deepEqual(painted, ['fallback']);
  assert.equal(hud._summaryRequest, null);
});

test('a new view cancels stale summaries and is not repainted by their abort handler', async (t) => {
  let count = 0;
  const { hud, painted } = harness(t, (url, options) => {
    count += 1;
    return count === 1 ? abortingFetch(url, options)
      : Promise.resolve({ ok: true, status: 200, json: async () => ({ summary: 'new view' }) });
  });
  const stale = hud._updateSummary();
  await nextTick();
  const oldController = hud._summaryRequest;
  hud._markSummaryDirty();
  hud._summaryContext = async () => ({ placeLabels: ['Beijing'] });
  const current = hud._updateSummary();
  assert.equal(oldController.signal.aborted, true);
  await Promise.all([stale, current]);
  assert.deepEqual(painted, ['new view']);
  assert.equal(hud._summaryDirty, false);
  assert.equal(hud._lastSummarySignature, JSON.stringify({ placeLabels: ['Beijing'] }));
});

test('a deliberate abort without a timeout does not rearm retries', async (t) => {
  const { hud, painted } = harness(t, abortingFetch);
  const pending = hud._updateSummary();
  await nextTick();
  const signature = hud._lastSummarySignature;
  hud._summaryRequest.abort();
  await pending;
  assert.equal(hud._summaryDirty, false);
  assert.equal(hud._lastSummarySignature, signature);
  assert.deepEqual(painted, []);
});

test('destroying the HUD cancels its request without repainting or reviving retries', async (t) => {
  const { hud, painted } = harness(t, abortingFetch);
  const pending = hud._updateSummary();
  await nextTick();
  hud.destroy();
  await pending;
  assert.equal(hud._summaryDirty, false);
  assert.deepEqual(painted, []);
});

test('destroying during context collection never starts a late request', async (t) => {
  let requests = 0;
  let releaseContext;
  const { hud, painted } = harness(t, async () => { requests += 1; });
  hud._summaryContext = () => new Promise((resolve) => { releaseContext = resolve; });
  const pending = hud._updateSummary();
  hud.destroy();
  releaseContext({ placeLabels: ['Austin'] });
  await pending;
  await hud._updateSummary(true, true);
  assert.equal(requests, 0);
  assert.deepEqual(painted, []);
});
