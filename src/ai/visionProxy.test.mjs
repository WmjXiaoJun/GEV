import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createVisionHandler, visionProxy, requestVision, localVisionHealth, validateVisionImage,
  sanitizeVisionResult, sanitizeBuildingSegResult, requestBuildingSegmentation, validateBuildingImage, validateBuildingSegImage,
  MAX_VISION_BODY_BYTES, MAX_VISION_IMAGE_BYTES, MAX_VISION_RESPONSE_BYTES } from './visionProxy.mjs';

const image = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')}`;
const detection = { class: 'plane', confidence: 0.91, box: { x: 0, y: 0, width: 10, height: 10 } };
const result = { model: 'yolo26n-obb.pt', task: 'obb', image: { width: 100, height: 100 },
  supportedClasses: ['plane'], detections: [detection] };

async function serve(t, options = {}) {
  const server = createServer(createVisionHandler({ detect: async () => result, getEnv: () => ({}), ...options }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (body = { image }, headers = {}, path = '/detect') => fetch(`${origin}${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
  });
  request.origin = origin;
  return request;
}

test('vision plugin installs without returning a Connect hook', () => {
  const paths = [];
  const middlewares = { use(path) { paths.push(path); return this; } };
  const plugin = visionProxy();
  assert.equal(plugin.configureServer({ middlewares }), undefined);
  assert.equal(plugin.configurePreviewServer({ middlewares }), undefined);
  assert.deepEqual(paths, ['/api/vision', '/api/vision']);
});

test('local image detection preserves only validated request and response fields', async (t) => {
  const forwarded = [];
  const request = await serve(t, { detect: async (value) => { forwarded.push(value); return {
    ...result, privatePath: 'private', image: { ...result.image, privatePath: 'private' },
    detections: [{ ...detection, privatePath: 'private', box: { ...detection.box, privatePath: 'private' } }],
  }; } });
  const response = await request({ image, confidence: 0.4, task: 'detect' });
  assert.equal(response.status, 200);
  assert.deepEqual(forwarded[0].body, { image, confidence: 0.4, task: 'detect' });
  assert.deepEqual(await response.json(), { ok: true, ...result });
});

test('noncanonical base64, MIME mismatch and type-coerced confidence fail before forwarding', async (t) => {
  let calls = 0;
  const request = await serve(t, { detect: async () => { calls += 1; return result; } });
  for (const body of [{ image: 'data:image/png;base64,====' }, { image: 'data:image/png;base64,YR==' },
    { image: 'data:image/jpeg;base64,YQ==' }, { image, confidence: '0.4' }, { image, confidence: null },
    { image, task: 'http://evil.test' }, { image, extra: true }, { image: 'https://evil.test/image.png' }]) {
    const response = await request(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).code, 'VISION_INVALID_REQUEST');
  }
  assert.equal(calls, 0);
});

test('invalid detection geometry is rejected without leaking upstream content', async (t) => {
  const request = await serve(t, { detect: async () => ({ ...result,
    detections: [{ ...detection, box: { x: -1, y: 0, width: 10, height: 10 }, secret: 'private' }],
  }) });
  const response = await request();
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'VISION_INVALID_RESPONSE');
});

test('quota limits inference and upstream details never reach users', async (t) => {
  const request = await serve(t, { rateLimit: 1, detect: async () => { throw new Error('private API key'); } });
  const first = await request();
  assert.equal(first.status, 503);
  assert.doesNotMatch(JSON.stringify(await first.json()), /private API key/);
  const second = await request();
  assert.equal(second.status, 429);
  assert.equal((await second.json()).code, 'VISION_RATE_LIMITED');
});

test('local-only admission refuses remote origin, forwarding headers, sharing and wrong content type', async (t) => {
  const request = await serve(t);
  for (const headers of [{ Origin: 'http://evil.test' }, { Origin: '' }, { 'X-Forwarded-For': '127.0.0.1' }]) {
    assert.equal((await request({ image }, headers)).status, 403);
  }
  assert.equal((await request({ image }, { 'Content-Type': 'text/plain' })).status, 415);
  const sharing = await serve(t, { getEnv: () => ({ PINOKIO_SHARE_LOCAL: '1' }) });
  assert.equal((await sharing()).status, 403);
});

test('input validates canonical PNG, JPEG and WebP signatures and exact byte limit', () => {
  const jpeg = `data:image/jpeg;base64,${Buffer.from([255, 216, 255]).toString('base64')}`;
  const webp = `data:image/webp;base64,${Buffer.from('RIFF0000WEBP').toString('base64')}`;
  for (const value of [image, jpeg, webp]) assert.deepEqual(validateVisionImage({ image: value }),
    { image: value, confidence: 0.25, task: 'obb' });
  for (const body of [null, [], {}, { image: 5 }, { image: '' }, { image: `${image}\n` },
    { image, confidence: -1 }, { image, confidence: 1 }, { image, task: null }]) {
    assert.throws(() => validateVisionImage(body), { code: 'VISION_INVALID_REQUEST' });
  }
  const maximum = Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(MAX_VISION_IMAGE_BYTES - 3)]);
  assert.equal(validateVisionImage({ image: `data:image/jpeg;base64,${maximum.toString('base64')}` }).task, 'obb');
  assert.throws(() => validateVisionImage({ image: `data:image/jpeg;base64,${Buffer.concat([maximum, Buffer.alloc(1)]).toString('base64')}` }),
    { code: 'VISION_REQUEST_TOO_LARGE' });
  assert.throws(() => validateVisionImage({ image: 'x'.repeat(MAX_VISION_BODY_BYTES + 1) }), { code: 'VISION_REQUEST_TOO_LARGE' });
});

test('response validator preserves safe rotated polygons and truncated-count metadata', () => {
  const polygon = [[1, 1], [9, 1], [9, 9], [1, 9]];
  const output = sanitizeVisionResult({ ...result, truncated: true, maxDetections: 300,
    detections: [{ ...detection, polygon }] });
  assert.deepEqual(output.detections[0].polygon, polygon);
  assert.equal(output.truncated, true);
  assert.equal(output.maxDetections, 300);
  assert.doesNotMatch(JSON.stringify(output), /secret|private/);
});

test('response validator rejects invalid shapes, dimensions, scores, classes and bounds', () => {
  for (const value of [null, [], { ...result, model: 'C:/private.pt' }, { ...result, task: 'exec' },
    { ...result, image: { width: 4097, height: 1 } }, { ...result, image: { width: 1.5, height: 0 } },
    { ...result, supportedClasses: ['<script>'] }, { ...result, detections: Array(301).fill(detection) },
    { ...result, truncated: 'true' }, { ...result, maxDetections: 9999 },
    ...[null, { ...detection, class: 'unlisted' }, { ...detection, confidence: NaN },
      { ...detection, confidence: 1.1 }, { ...detection, box: { x: 99, y: 0, width: 10, height: 1 } },
      { ...detection, box: { x: 0, y: 0, width: 0, height: 1 } },
      { ...detection, polygon: [] }, { ...detection, polygon: Array(4).fill({ x: 101, y: 1 }) },
    ].map((item) => ({ ...result, detections: [item] }))]) {
    assert.throws(() => sanitizeVisionResult(value), { code: 'VISION_INVALID_RESPONSE' });
  }
});

test('upstream uses fixed loopback, disallows redirects and bounds the response stream', async () => {
  const forwarded = [];
  const success = await requestVision({ body: { image }, fetchImpl: async (url, options) => {
    forwarded.push({ url, options });
    return Response.json({ ...result, secret: 'private' });
  } });
  assert.deepEqual(success, result);
  assert.equal(forwarded[0].url, 'http://127.0.0.1:8766/v1/detect');
  assert.equal(forwarded[0].options.redirect, 'error');
  assert.equal(JSON.parse(forwarded[0].options.body).task, 'obb');
  for (const response of [new Response('bad json'), new Response(null),
    new Response('{}', { headers: { 'content-length': String(MAX_VISION_RESPONSE_BYTES + 1) } }),
    new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(MAX_VISION_RESPONSE_BYTES));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    } }))]) {
    await assert.rejects(requestVision({ body: { image }, fetchImpl: async () => response }), { code: 'VISION_INVALID_RESPONSE' });
  }
});

test('upstream errors use only allowlisted codes and never include private messages', async () => {
  for (const [code, expected] of [['VISION_BUSY', 'VISION_BUSY'], ['VISION_UNAVAILABLE', 'VISION_UNAVAILABLE'],
    ['VISION_PRIVATE_SECRET', 'VISION_UPSTREAM_ERROR'], [null, 'VISION_UPSTREAM_ERROR']]) {
    await assert.rejects(requestVision({ body: { image }, fetchImpl: async () =>
      Response.json({ error: { code, message: 'private path' } }, { status: 503 }) }),
    (error) => error.code === expected && !error.message.includes('private path'));
  }
  await assert.rejects(requestVision({ body: { image }, fetchImpl: async () => { throw new Error('secret'); } }),
    { code: 'VISION_CONNECTION_ERROR' });
  await assert.rejects(requestVision({ body: { image }, signal: AbortSignal.abort() }), { code: 'VISION_CANCELLED' });
});

test('an oversized upstream body cannot stall rejection through its cancellation hook', async () => {
  let timer;
  const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cancellation stalled')), 100); });
  try {
    await assert.rejects(Promise.race([guard, requestVision({ body: { image }, fetchImpl: async () =>
      new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), {
        headers: { 'content-length': String(MAX_VISION_RESPONSE_BYTES + 1) },
      }) })]), { code: 'VISION_INVALID_RESPONSE' });
  } finally { clearTimeout(timer); }
});

const healthResult = { status: 'ok', model: 'yolo26n-obb.pt', version: '8.4.148', device: 'cpu',
  models: { obb: { model: 'yolo26n-obb.pt', installed: true, loaded: false } } };

test('health exposes approved metadata without paths, and unavailable service degrades safely', async () => {
  const output = await localVisionHealth({ fetchImpl: async (url) => {
    assert.equal(url, 'http://127.0.0.1:8766/health');
    return Response.json({ ...healthResult, privatePath: 'secret', models: {
      obb: { ...healthResult.models.obb, privatePath: 'secret' }, privatePath: 'secret',
    } });
  } });
  assert.deepEqual(output, healthResult);
  for (const payload of [null, { ...healthResult, model: '/private/model.pt' }, { ...healthResult, models: { obb: {} } }]) {
    assert.deepEqual(await localVisionHealth({ fetchImpl: async () => Response.json(payload) }), { status: 'failed', model: '', models: {} });
  }
  assert.deepEqual(await localVisionHealth({ fetchImpl: async () => { throw new Error('secret'); } }),
    { status: 'failed', model: '', models: {} });
});

test('health route, unknown paths and method restrictions are explicit', async (t) => {
  const request = await serve(t, { health: async () => healthResult });
  const health = await fetch(`${request.origin}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), healthResult);
  assert.equal((await fetch(`${request.origin}/detect`)).status, 405);
  assert.equal((await request({ image }, {}, '/health')).status, 405);
  assert.equal((await fetch(`${request.origin}/unknown`)).status, 404);
  const failed = await serve(t, { health: async () => ({ status: 'failed', private: 'secret' }) });
  assert.deepEqual(await (await fetch(`${failed.origin}/health`)).json(), { status: 'failed', model: '', models: {} });
});

test('building route validates and sanitizes model polygons independently of YOLO', async (t) => {
  let forwarded;
  const request = await serve(t, { buildings: async (value) => {
    forwarded = value;
    return { ok: true, task: 'buildings', model: 'vision-building', image: { width: 100, height: 100 },
      polygons: [{ points: [[10, 10], [90, 10], [90, 90], [10, 90]], confidence: 0.8 }], truncated: false };
  } });
  const response = await request({ image }, {}, '/buildings');
  assert.equal(response.status, 200);
  assert.equal(forwarded.body.image, image);
  assert.deepEqual((await response.json()).polygons[0].points, [[10, 10], [90, 10], [90, 90], [10, 90]]);
});

test('building segmentation accepts variable length polygons and forwards the fixed task', async () => {
  const segmentation = { model: 'yolov8n-building-seg.pt', task: 'buildings-seg', image: { width: 100, height: 80 },
    supportedClasses: ['building'], detections: [{ class: 'building', confidence: 0.87,
      box: { x: 10, y: 10, width: 60, height: 40 }, polygon: [[10, 10], [70, 10], [75, 30], [60, 50], [10, 40]] }] };
  let forwarded;
  const result = await requestBuildingSegmentation({ body: { image, confidence: 0.4 }, fetchImpl: async (url, options) => {
    forwarded = { url, options };
    return Response.json(segmentation);
  } });
  assert.equal(forwarded.url, 'http://127.0.0.1:8766/v1/detect');
  assert.equal(JSON.parse(forwarded.options.body).task, 'buildings-seg');
  assert.deepEqual(result, { ok: true, task: 'buildings-seg', model: segmentation.model, image: segmentation.image,
    polygons: [{ points: segmentation.detections[0].polygon, confidence: 0.87 }], truncated: false,
    segmentationModel: segmentation.model, detectedCount: 1 });
});

test('validated building segmentation requests can be passed through the adapter twice', () => {
  assert.deepEqual(validateBuildingSegImage({ image, confidence: 0.4, task: 'buildings-seg' }),
    { image, confidence: 0.4, task: 'buildings-seg' });
  assert.throws(() => validateBuildingSegImage({ image, confidence: 0.4, task: 'obb' }), { code: 'BUILDINGS_SEG_INVALID_REQUEST' });
});

test('building segmentation never relabels non-building classes', () => {
  const output = sanitizeBuildingSegResult({ model: 'yolov8n-building-seg.pt', task: 'buildings-seg', image: { width: 100, height: 80 },
    supportedClasses: ['person', 'building'], detections: [
      { class: 'person', confidence: 0.99, box: { x: 1, y: 1, width: 10, height: 10 }, polygon: [[1, 1], [11, 1], [11, 11]] },
      { class: 'building', confidence: 0.8, box: { x: 10, y: 10, width: 60, height: 40 }, polygon: [[10, 10], [70, 10], [70, 40]] },
    ] });
  assert.equal(output.polygons.length, 1);
});

test('building segmentation sanitizer accepts the adapter envelope without double parsing', () => {
  const output = sanitizeBuildingSegResult({ ok: true, task: 'buildings-seg', model: 'yolov8n-building-seg.pt',
    image: { width: 100, height: 80 }, polygons: [{ points: [[10, 10], [70, 10], [70, 40]], confidence: 0.8 }] });
  assert.deepEqual(output.polygons[0].points, [[10, 10], [70, 10], [70, 40]]);
});

test('building segmentation route is local-only and returns bounded polygon schema', async (t) => {
  const segmentation = { model: 'yolov8n-building-seg.pt', task: 'buildings-seg', image: { width: 100, height: 80 },
    supportedClasses: ['building'], detections: [{ class: 'building', confidence: 0.87,
      box: { x: 10, y: 10, width: 60, height: 40 }, polygon: [[10, 10], [70, 10], [75, 30], [60, 50], [10, 40]] }] };
  const request = await serve(t, { buildingsSeg: async () => segmentation });
  const response = await request({ image }, {}, '/buildings-seg');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).polygons[0].points, segmentation.detections[0].polygon);
  assert.equal((await request({ image }, { Origin: 'http://evil.test' }, '/buildings-seg')).status, 403);
});

test('building segmentation rejects degenerate or oversized variable polygons', () => {
  const base = { ok: true, task: 'buildings-seg', model: 'building-seg', image: { width: 100, height: 80 }, polygons: [], truncated: false };
  for (const polygon of [
    { points: [[0, 0], [1, 1]], confidence: 0.5 },
    { points: [[0, 0], [101, 1], [1, 2]], confidence: 0.5 },
    { points: Array.from({ length: 257 }, (_, i) => [i % 100, Math.floor(i / 100)]), confidence: 0.5 },
  ]) assert.throws(() => sanitizeBuildingSegResult({ ...base, polygons: [polygon] }), { code: 'BUILDINGS_SEG_INVALID_RESPONSE' });
});

test('building image validation accepts bounded candidate polygons for refinement', () => {
  const candidates = [{ points: [[1, 2], [30, 2], [30, 20], [1, 20]], confidence: 0.8 }];
  assert.deepEqual(validateBuildingImage({ image, confidence: 0.4, candidates }), { image, confidence: 0.4, candidates });
  assert.throws(() => validateBuildingImage({ image, candidates: [{ points: [[-1, 0], [1, 0], [1, 1]] }] }), { code: 'BUILDINGS_INVALID_REQUEST' });
});

test('building route reports missing model configuration in a stable code', async (t) => {
  const request = await serve(t, { getEnv: () => ({}) });
  const response = await request({ image }, {}, '/buildings');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'BUILDINGS_NOT_CONFIGURED');
});

test('dense detailed YOLO candidates reach the complementary model without a 64-point rejection', () => {
  const points = Array.from({ length: 128 }, (_, i) => [50 + 20 * Math.cos(i * Math.PI / 64), 40 + 20 * Math.sin(i * Math.PI / 64)]);
  const candidates = Array.from({ length: 200 }, () => ({ points, confidence: 0.8 }));
  const result = validateBuildingImage({ image, candidates });
  assert.equal(result.candidates.length, 200);
  assert.equal(result.candidates[0].points.length, 128);
  assert.equal(validateBuildingImage({ image, candidates: Array(301).fill(candidates[0]) }).candidates.length, 301);
  assert.throws(() => validateBuildingImage({ image, candidates: Array(501).fill(candidates[0]) }), { code: 'BUILDINGS_INVALID_REQUEST' });
  assert.throws(() => validateBuildingImage({ image, candidates: [{ points: Array(257).fill([2, 3]) }] }), { code: 'BUILDINGS_INVALID_REQUEST' });
});

test('single-flight prevents overlapping detections, releases afterward, and does not block health', async (t) => {
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const request = await serve(t, { detect: async () => { entered(); return pending; }, health: async () => healthResult });
  const first = request();
  await started;
  assert.equal((await request()).status, 429);
  assert.equal((await fetch(`${request.origin}/health`)).status, 200);
  release(result);
  assert.equal((await first).status, 200);
  assert.equal((await request()).status, 200);
});

test('inference deadline aborts work and returns an actionable timeout', async (t) => {
  let signal;
  const request = await serve(t, { timeoutMs: 15, detect: async (input) => { signal = input.signal; return new Promise(() => {}); } });
  const response = await request();
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'VISION_TIMEOUT');
  assert.equal(signal.aborted, true);
});

test('quota renews after a minute and health has its own budget', async (t) => {
  let now = 0;
  const request = await serve(t, { now: () => now, rateLimit: 1, healthRateLimit: 1, health: async () => healthResult });
  assert.equal((await request()).status, 200);
  assert.equal((await request()).status, 429);
  assert.equal((await fetch(`${request.origin}/health`)).status, 200);
  assert.equal((await fetch(`${request.origin}/health`)).status, 429);
  now = 60_000;
  assert.equal((await request()).status, 200);
});

function rawRequest(origin, { headers = {}, body = '', finish = true, onRequest } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}/detect`, { method: 'POST', headers: {
      Origin: origin, 'Content-Type': 'application/json', ...headers,
    } }, (response) => {
      let chunks = [];
      response.on('data', (chunk) => { chunks = [...chunks, chunk]; });
      response.on('end', () => resolve({ status: response.statusCode, payload: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    request.on('error', reject);
    request.write(body);
    if (finish) request.end();
    onRequest?.(request);
  });
}

test('request byte limits stop both declared and chunked bodies and reject malformed JSON', async (t) => {
  const request = await serve(t);
  const oversized = await rawRequest(request.origin, { headers: { 'Content-Length': String(MAX_VISION_BODY_BYTES + 1) }, body: 'x', finish: false });
  assert.equal(oversized.status, 413);
  const chunked = await rawRequest(request.origin, { body: 'x'.repeat(MAX_VISION_BODY_BYTES + 1) });
  assert.equal(chunked.status, 413);
  assert.equal((await rawRequest(request.origin, { body: '{' })).status, 400);
  assert.equal((await rawRequest(request.origin, { headers: { Host: 'evil.test' }, body: '{}' })).status, 403);
  assert.equal((await rawRequest(request.origin, { headers: { 'Content-Type': 'application/jsonp' }, body: JSON.stringify({ image }) })).status, 415);
});

test('request deadline covers stalled uploads, and disconnect aborts active inference', async (t) => {
  const stalled = await serve(t, { timeoutMs: 15 });
  assert.equal((await rawRequest(stalled.origin, { body: '{', finish: false })).status, 504);
  let entered;
  let signal;
  const started = new Promise((resolve) => { entered = resolve; });
  const request = await serve(t, { detect: async (input) => { signal = input.signal; entered(); return new Promise(() => {}); } });
  const controller = new AbortController();
  const pending = fetch(`${request.origin}/detect`, { method: 'POST', signal: controller.signal,
    headers: { Origin: request.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ image }) });
  await started;
  controller.abort();
  await assert.rejects(pending);
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(signal.reason.code, 'VISION_CANCELLED');
});
