import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { requestBuildingPolygons, BUILDING_POLYGON_PROMPT } from './buildingModel.mjs';

const config = (provider = 'openai') => ({ provider, model: 'vision-building', baseUrl: provider === 'gemini'
  ? 'https://generativelanguage.googleapis.com/v1beta' : provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://example.test/v1', apiKey: 'test-key' });
let image;
test('setup image', async () => {
  const bytes = await sharp({ create: { width: 100, height: 50, channels: 3, background: { r: 120, g: 130, b: 140 } } }).png().toBuffer();
  image = `data:image/png;base64,${bytes.toString('base64')}`;
});

test('refinement request includes YOLO candidates and ordered-vertex constraints', async () => {
  let seen;
  await requestBuildingPolygons({ image, config: config(), candidates: [{
    points: [[10, 5], [30, 5], [30, 20], [10, 20]], confidence: 0.82,
  }], fetchImpl: async (_url, options) => {
    seen = JSON.parse(options.body);
    return response({ choices: [{ message: { content: polygonJson() } }] });
  } });
  const text = seen.messages[0].content[0].text;
  assert.match(text, /YOLO/);
  assert.match(text, /top-left|left corner/i);
  assert.match(text, /clockwise/i);
  assert.match(text, /10/);
});

const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
const polygonJson = (fence = false) => `${fence ? '```json\n' : ''}{"polygons":[{"points":[[100,100],[300,100],[300,400],[100,400]],"confidence":0.88}],"truncated":false}${fence ? '\n```' : ''}`;

test('OpenAI-compatible request sends an image and scales normalized polygons to source pixels', async () => {
  let seen;
  const result = await requestBuildingPolygons({ image, config: config(), fetchImpl: async (url, options) => {
    seen = { url, body: JSON.parse(options.body), headers: options.headers };
    return response({ choices: [{ message: { content: polygonJson() } }] });
  } });
  assert.equal(seen.url, 'https://example.test/v1/chat/completions');
  assert.equal(seen.body.model, 'vision-building');
  assert.match(seen.body.messages[0].content[0].text, /严格 JSON/);
  assert.match(seen.body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(seen.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(result.image, { width: 100, height: 50 });
  assert.deepEqual(result.polygons[0].points, [[10, 5], [30, 5], [30, 20], [10, 20]]);
  assert.equal(result.polygons[0].confidence, 0.88);
});

test('Anthropic and Gemini multimodal payloads are accepted', async () => {
  for (const provider of ['anthropic', 'gemini']) {
    let body;
    const payload = provider === 'anthropic' ? { content: [{ type: 'text', text: polygonJson(true) }] }
      : { candidates: [{ content: { parts: [{ text: polygonJson(true) }] } }] };
    const result = await requestBuildingPolygons({ image, config: config(provider), fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body); return response(payload);
    } });
    assert.equal(result.polygons.length, 1);
    if (provider === 'anthropic') assert.equal(body.messages[0].content[1].type, 'image');
    else assert.ok(body.contents[0].parts[1].inline_data.data);
  }
});

test('invalid image and malformed model JSON are rejected with stable codes', async () => {
  await assert.rejects(requestBuildingPolygons({ image: 'data:image/png;base64,YQ==', config: config(), fetchImpl: async () => response({}) }), { code: 'BUILDINGS_INVALID_IMAGE' });
  await assert.rejects(requestBuildingPolygons({ image, config: config(), fetchImpl: async () => response({ choices: [{ message: { content: '{broken' } }] }) }), { code: 'BUILDINGS_INVALID_RESPONSE' });
  await assert.rejects(requestBuildingPolygons({ image, config: config(), fetchImpl: async () => response({ choices: [{ message: { content: JSON.stringify({ polygons: [{ points: [[0, 0], [1000, 0]], confidence: null }] }) } }] }) }), { code: 'BUILDINGS_INVALID_RESPONSE' });
});

test('cancellation and timeout abort the upstream request', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestBuildingPolygons({ image, config: config(), signal: controller.signal, fetchImpl: async (_url, options) => { options.signal.throwIfAborted(); } }), { code: 'BUILDINGS_CANCELLED' });
  await assert.rejects(requestBuildingPolygons({ image, config: config(), timeoutMs: 10, fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }) }), { code: 'BUILDINGS_TIMEOUT' });
});

test('model configuration is required before network access', async () => {
  let called = false;
  await assert.rejects(requestBuildingPolygons({ image, config: { provider: 'openai', model: '', baseUrl: '', apiKey: '' }, fetchImpl: async () => { called = true; } }), { code: 'BUILDINGS_NOT_CONFIGURED' });
  assert.equal(called, false);
  assert.ok(BUILDING_POLYGON_PROMPT.includes('建筑'));
});

const imageOfSize = async (width, height) => sharp({ create: {
  width, height, channels: 3, background: { r: 120, g: 130, b: 140 },
} }).png().toBuffer();
const modelResponse = (polygons = [], truncated = false) => response({ choices: [{
  message: { content: JSON.stringify({ polygons, truncated }) },
}] });
const square = (min = 200, max = 300) => ({ points: [[min, min], [max, min], [max, max], [min, max]], confidence: 0.9 });
const requestPrompt = (options) => JSON.parse(options.body).messages[0].content[0].text;
const promptCandidates = (prompt) => JSON.parse(prompt.split('YOLO-seg candidates (normalized 0..1000): ')[1]);

test('candidate guidance is complementary, normalized, and canonically ordered without losing roof corners', async () => {
  let prompt;
  const complex = Array.from({ length: 256 }, (_, index) => {
    const angle = index * Math.PI * 2 / 256;
    return [50 + 10 * Math.cos(angle), 25 + 10 * Math.sin(angle)];
  });
  await requestBuildingPolygons({ image, config: config(), candidates: [
    { points: complex, confidence: 0.7 },
    { points: [[30, 20], [30, 5], [10, 5], [10, 20]], confidence: 0.8 },
  ], fetchImpl: async (_url, options) => { prompt = requestPrompt(options); return modelResponse(); } });
  assert.match(prompt, /不完整|non-exhaustive/);
  assert.match(prompt, /漏检|missed/);
  assert.doesNotMatch(prompt, /只修正/);
  const candidates = promptCandidates(prompt);
  assert.equal(candidates[0].points.length, 256);
  const firstScore = candidates[0].points[0][0] + candidates[0].points[0][1];
  assert.ok(candidates[0].points.every(([x, y]) => firstScore <= x + y));
  assert.ok(candidates[0].points.every(([x, y]) => x >= 0 && x <= 1000 && y >= 0 && y <= 1000));
  const area2 = candidates[0].points.reduce((sum, point, index, points) => {
    const next = points[(index + 1) % points.length];
    return sum + point[0] * next[1] - point[1] * next[0];
  }, 0);
  assert.ok(area2 > 0);
  assert.equal(candidates[1].points.length, 4);
});

test('zero YOLO candidates still generates independent image polygons', async () => {
  let calls = 0;
  const result = await requestBuildingPolygons({ image, config: config(), candidates: [], fetchImpl: async (_url, options) => {
    calls += 1;
    assert.match(requestPrompt(options), /漏检|missed/);
    return modelResponse([square()]);
  } });
  assert.equal(calls, 1);
  assert.equal(result.polygons.length, 1);
  assert.deepEqual(result.polygons[0].points, [[20, 10], [30, 10], [30, 15], [20, 15]]);
});

test('candidate input and result can contain 300 distinct buildings', async () => {
  const polygons = Array.from({ length: 300 }, (_, i) => square(1 + i, 2 + i));
  await requestBuildingPolygons({ image, config: config(), candidates: polygons, fetchImpl: async (_url, options) => {
    assert.equal(promptCandidates(requestPrompt(options)).length, 300);
    return modelResponse();
  } });
  const result = await requestBuildingPolygons({ image, config: config(), fetchImpl: async () => modelResponse(polygons) });
  assert.equal(result.polygons.length, 300);
});
