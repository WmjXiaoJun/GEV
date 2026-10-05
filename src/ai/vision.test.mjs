import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewportVision, detectViewportImage, summarizeVision } from './vision.js';
import { LLM_TOOLS, validToolCall } from './tools.js';
import { createActionGuard } from './actionGuard.js';
import { sanitizeVisionResult } from './visionProxy.mjs';

const image = 'data:image/jpeg;base64,YQ==';
const detection = { class: 'plane', confidence: 0.91, box: { x: 10, y: 10, width: 20, height: 30 } };
const result = { ok: true, model: 'yolo26n-obb.pt', task: 'obb', image: { width: 100, height: 80 }, supportedClasses: ['plane', 'ship'], detections: [detection], truncated: false };

test('LLMs may request bounded visual detection without map confirmation or undo changes', async () => {
  const detectionTool = LLM_TOOLS.find((entry) => entry.name === 'detect_viewport');
  assert.match(detectionTool.description, /识别建筑/);
  assert.match(detectionTool.description, /automatically draws/);
  for (const args of [{}, { task: 'obb', confidence: 0.25 }, { task: 'detect', confidence: 0.9 }]) {
    assert.equal(validToolCall({ id: 'vision', name: 'detect_viewport', arguments: args }), true);
  }
  for (const args of [{ task: 'shell' }, { confidence: -1 }, { image: 'untrusted' }, { confidence: '0.5' }]) {
    assert.equal(validToolCall({ id: 'vision', name: 'detect_viewport', arguments: args }), false);
  }
  const calls = [];
  const guard = createActionGuard({ runAction: async (name) => { calls.push(name); return { ok: true }; }, captureState: () => { throw new Error('must not snapshot'); } });
  assert.equal((await guard.runAction('detect_viewport', {})).ok, true);
  assert.deepEqual(calls, ['detect_viewport']);
  assert.equal(guard.getState().canUndo, false);
  guard.destroy();
});

test('detection requests use only the local endpoint and explicitly select the aerial task', async () => {
  let sent;
  const detected = await detectViewportImage(image, { task: 'obb', confidence: 0.35, fetchImpl: async (url, options) => {
    sent = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify(result));
  } });
  assert.equal(detected.available, true);
  assert.deepEqual(sent, { url: '/api/vision/detect', body: { image, confidence: 0.35, task: 'obb' } });
});

test('nonempty YOLO OBB polygons survive the proxy-to-browser boundary unchanged', async () => {
  const polygon = [[10, 10], [30, 10], [30, 40], [10, 40]];
  const servicePayload = { ...result, detections: [{ ...detection, polygon }] };
  const sanitized = sanitizeVisionResult(servicePayload);
  const detected = await detectViewportImage(image, {
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, ...sanitized })),
  });
  assert.equal(detected.available, true);
  assert.deepEqual(detected.detections[0].polygon, polygon);
  assert.equal(summarizeVision(detected).count, 1);
});

test('invalid images, settings, malformed responses and network failures cannot become observations', async () => {
  let calls = 0;
  for (const args of [{ image: 'https://private.test/img' }, { task: 'shell' }, { confidence: '0.5' }]) {
    const output = await detectViewportImage(args.image ?? image, { ...args, fetchImpl: async () => { calls++; } });
    assert.equal(output.available, false);
  }
  assert.equal(calls, 0);
  for (const payload of [{ ok: true }, { ...result, detections: [{ ...detection, confidence: 4 }] }, { ...result, detections: [{ ...detection, box: { x: -1, y: 0, width: 10, height: 10 } }] }]) {
    const output = await detectViewportImage(image, { fetchImpl: async () => new Response(JSON.stringify(payload)) });
    assert.equal(output.available, false);
  }
  const error = await detectViewportImage(image, { fetchImpl: async () => { throw new Error('secret'); } });
  assert.equal(error.code, 'VISION_CONNECTION_ERROR');
  assert.doesNotMatch(JSON.stringify(error), /secret/);
});

test('empty detections preserve capability limits; summaries have bounded samples and never contain image data', () => {
  const empty = summarizeVision({ ...result, available: true, detections: [] });
  assert.equal(empty.count, 0);
  assert.equal(empty.absenceIsEvidence, false);
  assert.match(empty.limitations, /airport|runway/);
  assert.match(empty.limitations, /building class/);
  const full = summarizeVision({ ...result, available: true, detections: Array.from({ length: 100 }, () => detection) });
  assert.equal(full.count, 100);
  assert.equal(full.breakdown.plane, 100);
  assert.equal(full.averageConfidence, 0.91);
  assert.equal(full.highConfidenceCount, 100);
  assert.equal(full.detections.length, 12);
  assert.equal(full.omittedCount, 88);
  assert.doesNotMatch(JSON.stringify(full), /base64|data:image/);
  assert.equal(summarizeVision({ available: false, code: 'VISION_UNAVAILABLE' }).code, 'VISION_UNAVAILABLE');
});

test('coordinator runs on demand, invalidates moved views, and shares no screenshots with LLM context', async () => {
  let key = 'first';
  let captures = 0;
  const changes = [];
  const vision = createViewportVision({
    capture: async () => { captures++; return { image, capturedAt: 1000, viewKey: key }; },
    getViewKey: () => key, now: () => 1000, onChange: (state) => changes.push(state),
    fetchImpl: async () => new Response(JSON.stringify(result)),
  });
  assert.equal(captures, 0);
  const summary = await vision.run({ task: 'obb' });
  assert.equal(summary.ok, true);
  assert.equal(vision.getContext().count, 1);
  assert.doesNotMatch(JSON.stringify(vision.getContext()), /base64/);
  assert.deepEqual(changes.map((state) => state.status), ['running', 'done']);
  key = 'moved';
  assert.equal(vision.getContext().available, false);
  vision.clear();
  assert.equal(vision.getContext().available, false);
  vision.destroy();
  assert.equal((await vision.run({})).ok, false);
});

test('cancelled and stale detection responses never become current evidence', async () => {
  for (const cancel of [true, false]) {
    let key = 'first';
    let resolve;
    const vision = createViewportVision({ capture: async () => ({ image, capturedAt: 1000, viewKey: key }), getViewKey: () => key,
      now: () => 1000, fetchImpl: () => new Promise((done) => { resolve = done; }) });
    const pending = vision.run({});
    await new Promise((done) => setImmediate(done));
    if (cancel) vision.cancel(); else key = 'changed';
    resolve(new Response(JSON.stringify(result)));
    assert.equal((await pending).ok, false);
    assert.equal(vision.getContext().available, false);
    vision.destroy();
  }
});
