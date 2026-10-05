import test from 'node:test';
import assert from 'node:assert/strict';
import { aiSettingsAreDirty, buildAiSettingsPayload, buildSearchSettingsPayload, compressBuildingCandidates, fuseBuildingPolygons, initAiAssistant } from './assistantUi.js';
import { getLocale, setLocale, t } from '../i18n.js';

const config = Object.freeze({
  provider: 'openai', model: 'model-one', baseUrl: 'https://one.test/v1', configured: true,
  voice: { provider: 'openai', configured: true },
  providers: [
    { id: 'openai', label: 'OpenAI', defaultModel: 'model-one', baseUrl: 'https://one.test/v1', keyEnv: 'OPENAI_API_KEY', keyConfigured: true },
    { id: 'deepseek', label: 'DeepSeek', defaultModel: 'deepseek-chat', baseUrl: 'https://two.test/v1', keyEnv: 'DEEPSEEK_API_KEY', keyConfigured: false },
    { id: 'ollama', label: 'Ollama', defaultModel: 'llama3.1:8b', baseUrl: 'http://localhost:11434/v1', keyEnv: 'OLLAMA_API_KEY', keyConfigured: false, keyOptional: true },
  ],
});

test('building prompt candidates keep every roof while compacting dense masks', () => {
  const points = Array.from({ length: 128 }, (_, index) => [50 + 20 * Math.cos(index * Math.PI / 64), 40 + 20 * Math.sin(index * Math.PI / 64)]);
  const input = [{ points, confidence: 0.81 }, { points: [[1, 2], [5, 2], [5, 6]], confidence: 0.4 }];
  const output = compressBuildingCandidates(input);
  assert.equal(output.length, input.length);
  assert.equal(output[0].points.length, 32);
  assert.equal(output[1].points.length, 3);
  assert.equal(input[0].points.length, 128);
  assert.equal(output[0].confidence, 0.81);
});

test('building fusion keeps unmatched YOLO masks and rejects a coarse or mismatched VLM polygon', () => {
  const segmentation = { ok: true, task: 'buildings-seg', model: 'yolo', image: { width: 200, height: 200 }, polygons: [
    { points: [[10, 10], [30, 10], [50, 10], [70, 10], [70, 30], [70, 50], [70, 70], [50, 70], [30, 70], [10, 70], [10, 50], [10, 30]], confidence: 0.9 },
    { points: [[110, 110], [160, 110], [160, 160], [110, 160]], confidence: 0.8 },
  ] };
  const refinement = { ok: true, task: 'buildings', model: 'vlm', image: segmentation.image, polygons: [
    // Same region but too coarse to replace the detailed first mask.
    { points: [[10, 10], [70, 10], [70, 70], [10, 70]], confidence: 0.7 },
    // Does not overlap either candidate.
    { points: [[5, 150], [35, 150], [35, 180], [5, 180]], confidence: 0.6 },
  ] };
  const fused = fuseBuildingPolygons(segmentation, refinement);
  assert.equal(fused.refinedCount, 0);
  assert.equal(fused.rejectedRefinements, 2);
  assert.equal(fused.polygons.length, 2);
  assert.equal(fused.polygons[0].points.length, 12);
  assert.deepEqual(fused.polygons[1].points, segmentation.polygons[1].points);
});

test('building fusion accepts a spatially aligned refinement and preserves other candidates', () => {
  const segmentation = { ok: true, task: 'buildings-seg', model: 'yolo', image: { width: 100, height: 100 }, polygons: [
    { points: [[5, 5], [25, 5], [25, 25], [5, 25]], confidence: 0.8 },
    { points: [[60, 60], [90, 60], [90, 90], [60, 90]], confidence: 0.7 },
  ] };
  const refinement = { ok: true, task: 'buildings', model: 'vlm', image: segmentation.image, polygons: [
    { points: [[6, 6], [24, 6], [24, 24], [6, 24]], confidence: 0.9 },
  ] };
  const fused = fuseBuildingPolygons(segmentation, refinement);
  assert.equal(fused.refinedCount, 1);
  assert.equal(fused.polygons[0].confidence, 0.9);
  assert.deepEqual(fused.polygons[1].points, segmentation.polygons[1].points);
});

test('settings preserve saved keys when the password is blank', () => {
  const payload = buildAiSettingsPayload(config, { ...config, apiKey: '  ' });
  assert.deepEqual(payload, {
    GEV_LLM_PROVIDER: 'openai', GEV_LLM_MODEL: 'model-one', GEV_LLM_BASE_URL: 'https://one.test/v1',
  });
  assert.equal(Object.hasOwn(payload, 'OPENAI_API_KEY'), false);
});

test('complementary building fusion adds missing roofs and deduplicates overlapping proposals', () => {
  const roof = (x, y, confidence = 0.9) => ({ points: [[x,y],[x+20,y],[x+20,y+20],[x,y+20]], confidence });
  const segmentation = { ok: true, task: 'buildings-seg', model: 'yolo', image: { width: 200, height: 200 }, polygons: [roof(10,10)] };
  const refinement = { ok: true, task: 'buildings', model: 'vlm', image: segmentation.image,
    polygons: [roof(11,11), roof(100,100), roof(101,101), roof(160,160,0.4)] };
  const before = JSON.stringify([segmentation, refinement]);
  const fused = fuseBuildingPolygons(segmentation, refinement);
  assert.equal(fused.polygons.length, 2);
  assert.equal(fused.supplementedCount, 1);
  assert.equal(fused.refinedCount, 1);
  assert.equal(JSON.stringify([segmentation, refinement]), before);
});

test('a missed roof inside a concave building bbox is recovered without merging the two buildings', () => {
  const segmentation = { ok: true, model: 'yolo', image: { width: 150, height: 150 }, polygons: [
    { points: [[10,10],[100,10],[100,30],[30,30],[30,80],[100,80],[100,100],[10,100]], confidence: 0.9 },
  ] };
  const missing = { points: [[50,45],[75,45],[75,65],[50,65]], confidence: 0.9 };
  const fused = fuseBuildingPolygons(segmentation, { ok: true, model: 'vlm', image: segmentation.image, polygons: [missing] });
  assert.equal(fused.refinedCount, 0);
  assert.equal(fused.supplementedCount, 1);
  assert.deepEqual(fused.polygons[0], segmentation.polygons[0]);
  assert.deepEqual(fused.polygons[1].points, missing.points);
});

test('zero YOLO candidates still trigger independent image-based building recovery', async () => {
  let drawn;
  const missing = { points: [[5,5],[25,5],[25,25],[5,25]], confidence: 0.9 };
  const f = await fixture({
    '/api/vision/buildings-seg': { ok: true, task: 'buildings-seg', model: 'yolo', image: { width: 100, height: 100 }, polygons: [] },
    '/api/vision/buildings': { ok: true, task: 'buildings', model: 'vlm', image: { width: 100, height: 100 }, polygons: [missing] },
  }, {}, { workspace: {
    captureImage: async () => ({ image: 'data:image/jpeg;base64,YQ==', viewKey: 'v1' }), getViewKey: () => 'v1',
    drawBuildingPolygons: async (result) => { drawn = result; return { ok: true, polygons: result.polygons }; },
  } });
  try {
    const result = await f.ui.runMapAction('detect_buildings', {});
    assert.ok(f.requests.some(({ path }) => path === '/api/vision/buildings'));
    assert.equal(result.detectedCount, 0);
    assert.equal(result.supplementedCount, 1);
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.drawnCount, 1);
    assert.deepEqual(drawn.polygons[0].points, missing.points);
  } finally { f.ui.destroy(); }
});

test('settings route credentials only to the selected registry provider', () => {
  const payload = buildAiSettingsPayload(config, { provider: 'deepseek', model: ' ds ', baseUrl: ' https://two.test/v1 ', apiKey: ' mock-test-only ' });
  assert.deepEqual(payload, {
    GEV_LLM_PROVIDER: 'deepseek', GEV_LLM_MODEL: 'ds', GEV_LLM_BASE_URL: 'https://two.test/v1', DEEPSEEK_API_KEY: 'mock-test-only',
  });
  assert.throws(() => buildAiSettingsPayload(config, { provider: 'unknown', apiKey: 'x' }), /Unknown provider/);
});

test('search settings route Firecrawl credentials without affecting legacy model payloads', () => {
  assert.deepEqual(buildSearchSettingsPayload({}), {});
  assert.deepEqual(buildSearchSettingsPayload({
    provider: 'firecrawl', baseUrl: ' https://api.firecrawl.dev/v2 ', apiKey: ' fire-test-key ',
  }), {
    AGENT_PRO_SEARCH_ENABLED: '0', FIRECRAWL_BASE_URL: 'https://api.firecrawl.dev/v2', FIRECRAWL_API_KEY: 'fire-test-key',
  });
  assert.deepEqual(buildSearchSettingsPayload({ provider: 'firecrawl', baseUrl: '', apiKey: ' ' }), {});
});

test('search settings route Agent Pro endpoint and local header without Firecrawl credentials', () => {
  assert.deepEqual(buildSearchSettingsPayload({
    provider: 'agent-pro', baseUrl: ' http://127.0.0.1:6637/api/search ', apiKey: ' local-secret ',
  }), {
    AGENT_PRO_SEARCH_ENABLED: '1',
    AGENT_PRO_SEARCH_URL: 'http://127.0.0.1:6637/api/search',
    AGENT_PRO_LOCAL_HEADER: 'local-secret',
  });
});

test('switching search back to Firecrawl disables Agent Pro and preserves blank-key semantics', () => {
  assert.deepEqual(buildSearchSettingsPayload({
    provider: 'firecrawl', baseUrl: ' https://api.firecrawl.dev/v2 ', apiKey: ' ',
  }), {
    AGENT_PRO_SEARCH_ENABLED: '0',
    FIRECRAWL_BASE_URL: 'https://api.firecrawl.dev/v2',
  });
});

test('search settings dirty detection ignores absent and blank legacy search configuration', () => {
  const searchConfig = { ...config, search: { provider: 'firecrawl', enabled: false, baseUrl: '', keyConfigured: false } };
  assert.equal(aiSettingsAreDirty(searchConfig, { ...searchConfig, search: { provider: 'firecrawl', baseUrl: '', apiKey: '' } }), false);
  assert.equal(aiSettingsAreDirty(searchConfig, { ...searchConfig, search: { provider: 'firecrawl', baseUrl: 'https://api.firecrawl.dev/v2', apiKey: '' } }), true);
  assert.equal(aiSettingsAreDirty(searchConfig, { ...searchConfig, search: { provider: 'firecrawl', baseUrl: '', apiKey: 'new-key' } }), true);
});

test('dirty detection gates tests for every editable configuration field', () => {
  assert.equal(aiSettingsAreDirty(config, config), false);
  assert.equal(aiSettingsAreDirty(null, {}), false);
  assert.equal(aiSettingsAreDirty(config, { ...config, model: ' model-one ', apiKey: ' ' }), false);
  for (const [name, value] of [['provider', 'deepseek'], ['model', 'other'], ['baseUrl', 'https://other.test/v1'], ['apiKey', 'new-test-key']]) {
    assert.equal(aiSettingsAreDirty(config, { ...config, [name]: value }), true, name);
  }
});

test('speech settings save only the visible mode fields and preserve blank credentials', () => {
  const hidden = { model: 'stale-model', baseUrl: 'https://stale.test/v1', apiKey: 'stale-test-key' };
  for (const provider of ['browser', 'realtime']) {
    const payload = buildAiSettingsPayload(config, { ...config, speech: { ...hidden, provider } });
    assert.equal(payload.GEV_STT_PROVIDER, provider);
    assert.equal(Object.hasOwn(payload, 'GEV_STT_MODEL'), false);
    assert.equal(Object.hasOwn(payload, 'GEV_STT_BASE_URL'), false);
    assert.equal(Object.hasOwn(payload, 'GEV_STT_API_KEY'), false);
  }
  const current = buildAiSettingsPayload(config, { ...config, speech: { ...hidden, provider: 'current' } });
  assert.equal(current.GEV_STT_MODEL, 'stale-model');
  assert.equal(Object.hasOwn(current, 'GEV_STT_API_KEY'), false);
  const custom = buildAiSettingsPayload(config, { ...config, speech: { provider: 'custom', model: ' whisper-1 ', baseUrl: ' https://asr.test/v1 ', apiKey: ' ' } });
  assert.equal(custom.GEV_STT_MODEL, 'whisper-1');
  assert.equal(custom.GEV_STT_BASE_URL, 'https://asr.test/v1');
  assert.equal(Object.hasOwn(custom, 'GEV_STT_API_KEY'), false);
  assert.throws(() => buildAiSettingsPayload(config, { ...config, provider: 'deepseek', speech: { provider: 'current' } }), /transcription/i);
});

test('speech dirty detection ignores hidden fields but tracks active mode settings', () => {
  const saved = { ...config, speech: { provider: 'browser', model: 'whisper-1', baseUrl: '', keyConfigured: false } };
  assert.equal(aiSettingsAreDirty(saved, { ...config, speech: { provider: 'browser', model: 'hidden', apiKey: 'hidden' } }), false);
  assert.equal(aiSettingsAreDirty(saved, { ...config, speech: { provider: 'custom', model: 'whisper-1', baseUrl: 'https://asr.test/v1' } }), true);
  const custom = { ...saved, speech: { provider: 'custom', model: 'whisper-1', baseUrl: 'https://asr.test/v1' } };
  assert.equal(aiSettingsAreDirty(custom, { ...custom, speech: { ...custom.speech, apiKey: 'new-test-key' } }), true);
});

test('voiceprint threshold is persisted and participates in dirty detection', () => {
  const saved = { ...config, speech: {
    provider: 'custom', model: 'local-whisper-small', baseUrl: 'http://127.0.0.1:8765/v1',
    voiceprint: { enabled: true, mode: 'enforce', profile: 'owner', threshold: 0.25 },
  } };
  const unchanged = { ...saved, speech: { ...saved.speech, voiceprint: { ...saved.speech.voiceprint, threshold: 0.25 } } };
  assert.equal(aiSettingsAreDirty(saved, unchanged), false);
  const changed = { ...saved, speech: { ...saved.speech, voiceprint: { ...saved.speech.voiceprint, threshold: 0.41 } } };
  assert.equal(aiSettingsAreDirty(saved, changed), true);
  const payload = buildAiSettingsPayload(saved, changed);
  assert.equal(payload.VOICEPRINT_THRESHOLD, '0.41');
});

function fakeElement() {
  const listeners = new Map();
  const attrs = new Map();
  let inputValue = '';
  return {
    get value() { return inputValue; },
    set value(value) { inputValue = value; if (value === '') this.files = []; },
    textContent: '', dataset: {}, children: [], files: [], open: false,
    hidden: false, disabled: false, scrollTop: 0, scrollHeight: 100, style: {},
    get options() { return this.children; },
    addEventListener(name, callback) { listeners.set(name, [...(listeners.get(name) || []), callback]); },
    removeEventListener(name, callback) { listeners.set(name, (listeners.get(name) || []).filter((entry) => entry !== callback)); },
    emit(name, event = {}) { for (const callback of listeners.get(name) || []) callback({ preventDefault() {}, stopPropagation() {}, ...event }); },
    setAttribute(name, value) { attrs.set(name, value); },
    removeAttribute(name) { attrs.delete(name); },
    getAttribute(name) { return attrs.get(name) ?? null; },
    append(...children) { this.children = [...this.children, ...children]; },
    replaceChildren(...children) { this.children = children; },
    querySelectorAll() { return []; },
    reportValidity() { return true; },
    focus() { this.focused = true; },
    show() { this.open = true; this.modal = false; },
    showModal() { this.open = true; this.modal = true; },
    close() { this.open = false; this.emit('close'); },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('normal chat does not capture images; an LLM detection call uses local vision and returns bounded evidence', async () => {
  let captures = 0;
  let overlays = 0;
  let chats = 0;
  const f = await fixture({
    '/api/ai/chat': () => (++chats === 2
      ? { text: '', toolCalls: [{ id: 'see', name: 'detect_viewport', arguments: { task: 'obb' } }] }
      : { text: '收到', toolCalls: [] }),
    '/api/vision/detect': { ok: true, model: 'yolo26n-obb.pt', task: 'obb', image: { width: 100, height: 100 },
      supportedClasses: ['plane'], detections: [{ class: 'plane', confidence: 0.9, box: { x: 2, y: 2, width: 5, height: 5 } }] },
  }, {}, { workspace: {
    captureImage: async () => { captures++; return { image: 'data:image/jpeg;base64,YQ==', capturedAt: Date.now(), viewKey: 'v1' }; },
    drawVisionDetections: async (result, image) => { overlays += result.detections.length; assert.deepEqual(image, result.image); return { ok: true, drawn: result.detections.length }; },
    getViewKey: () => 'v1', getViewSnapshot: () => ({}),
    captureState: () => { throw new Error('detect must not mutate'); },
  } });
  try {
    await f.ui.sendText('你好');
    assert.equal(captures, 0);
    await f.ui.sendText('识别当前画面');
    assert.equal(captures, 1);
    assert.equal(overlays, 1);
    const payloads = f.requests.filter((r) => r.path === '/api/ai/chat').map((r) => JSON.parse(r.options.body));
    assert.doesNotMatch(JSON.stringify(payloads), /data:image|base64/);
    const tool = payloads.at(-1).messages.find((m) => m.name === 'detect_viewport');
    assert.equal(JSON.parse(tool.content).count, 1);
    assert.equal(f.e('action-review').hidden, true);
  } finally { f.ui.destroy(); }
});

test('建筑识别调用建筑轮廓接口、自动绘制并只回传摘要', async () => {
  let chats = 0; let captures = 0; let drawn;
  const f = await fixture({
    '/api/ai/chat': () => (++chats === 1
      ? { text: '', toolCalls: [{ id: 'build', name: 'detect_buildings', arguments: { confidence: 0.35 } }] }
      : { text: '建筑轮廓已绘制。', toolCalls: [] }),
    '/api/vision/buildings-seg': { ok: true, task: 'buildings-seg', model: 'yolov8n-building-seg.pt', image: { width: 100, height: 100 },
      polygons: [{ points: [[10, 10], [40, 10], [40, 40], [10, 40]], confidence: 0.81 }] },
    '/api/vision/buildings': { ok: true, task: 'buildings', model: 'experimental-building', image: { width: 100, height: 100 },
      polygons: [{ points: [[10, 10], [40, 10], [40, 40], [10, 40]], confidence: 0.81 }] },
  }, {}, { workspace: {
    captureImage: async () => { captures += 1; return { image: 'data:image/jpeg;base64,YQ==', viewKey: 'v1' }; },
    getViewKey: () => 'v1', getViewSnapshot: () => ({}), captureState: () => ({}),
    drawBuildingPolygons: async (result, image, options) => { drawn = { result, image, options }; return { ok: true, polygons: result.polygons }; },
  } });
  try {
    await f.ui.sendText('识别建筑');
    assert.equal(captures, 1);
    assert.equal(drawn.result.polygons.length, 1);
    assert.equal(drawn.image.width, 100);
    const segmentation = f.requests.find((r) => r.path === '/api/vision/buildings-seg');
    assert.ok(segmentation);
    const refinement = f.requests.find((r) => r.path === '/api/vision/buildings');
    assert.deepEqual(JSON.parse(refinement.options.body).candidates, [{ points: [[10, 10], [40, 10], [40, 40], [10, 40]], confidence: 0.81 }]);
    const body = JSON.parse(f.requests.filter((r) => r.path === '/api/ai/chat').at(-1).options.body);
    const result = JSON.parse(body.messages.find((m) => m.name === 'detect_buildings').content);
    if (false) assert.deepEqual(result, { ok: true, task: 'buildings', model: 'experimental-building', image: { width: 100, height: 100 },
      detectedCount: 1, drawnCount: 1, rejectedCount: 0, truncated: false, mapDrawn: true,
      message: '已识别 1 个候选建筑，绘制 1 个' });
    assert.doesNotMatch(JSON.stringify(result), /points/);
    assert.equal(result.ok, true);
    assert.equal(result.segmentationModel, 'yolov8n-building-seg.pt');
    assert.equal(result.refinementModel, 'experimental-building');
    assert.equal(result.detectedCount, 1);
    assert.equal(result.refinedCount, 1);
    assert.equal(result.drawnCount, 1);
    assert.equal(result.fallbackUsed, false);
    assert.equal(result.uncertainty, 'medium');
  } finally { f.ui.destroy(); }
});

test('建筑识别在视角变化后丢弃结果且不绘制', async () => {
  let chats = 0; let draws = 0; let view = 'v1';
  const f = await fixture({
    '/api/ai/chat': () => (++chats === 1
      ? { text: '', toolCalls: [{ id: 'build', name: 'detect_buildings', arguments: {} }] }
      : { text: '结果已丢弃。', toolCalls: [] }),
    '/api/vision/buildings-seg': { ok: true, task: 'buildings-seg', model: 'yolov8n-building-seg.pt', image: { width: 20, height: 20 }, polygons: [{ points: [[1, 1], [10, 1], [10, 10]], confidence: null }] },
    '/api/vision/buildings': { ok: true, task: 'buildings', model: 'm', image: { width: 20, height: 20 }, polygons: [{ points: [[1, 1], [10, 1], [10, 10]], confidence: null }] },
  }, {}, { workspace: {
    captureImage: async () => ({ image: 'data:image/jpeg;base64,YQ==', viewKey: 'v1' }),
    getViewKey: () => view, getViewSnapshot: () => ({}), captureState: () => ({}),
    drawBuildingPolygons: async () => { draws += 1; return { ok: true, polygons: [] }; },
  } });
  try {
    view = 'v2';
    await f.ui.sendText('识别建筑');
    assert.equal(draws, 0);
    const body = JSON.parse(f.requests.filter((r) => r.path === '/api/ai/chat').at(-1).options.body);
    const result = JSON.parse(body.messages.find((m) => m.name === 'detect_buildings').content);
    assert.equal(result.error, 'BUILDINGS_VIEW_CHANGED');
    assert.match(result.message, /视角/);
  } finally { f.ui.destroy(); }
});

test('建筑模型未配置时保留安全错误码并提供中文提示', async () => {
  let chats = 0;
  const f = await fixture({
    '/api/ai/chat': () => (++chats === 1
      ? { text: '', toolCalls: [{ id: 'build', name: 'detect_buildings', arguments: {} }] }
      : { text: '模型尚未配置。', toolCalls: [] }),
    '/api/vision/buildings': { status: 503, ok: false, code: 'BUILDINGS_NOT_CONFIGURED', error: '未配置建筑轮廓模型' },
  }, {}, { workspace: {
    captureImage: async () => ({ image: 'data:image/jpeg;base64,YQ==', viewKey: 'v1' }),
    getViewKey: () => 'v1', getViewSnapshot: () => ({}), captureState: () => ({}),
  } });
  try {
    await f.ui.sendText('识别建筑');
    const body = JSON.parse(f.requests.filter((r) => r.path === '/api/ai/chat').at(-1).options.body);
    const result = JSON.parse(body.messages.find((m) => m.name === 'detect_buildings').content);
    if (false) {
      assert.equal(result.error, 'BUILDINGS_NOT_CONFIGURED');
    assert.equal(result.message, '建筑识别模型不可用，请配置建筑轮廓模型');
    assert.doesNotMatch(JSON.stringify(result), /未配置建筑轮廓模型/);
    }
    assert.equal(result.ok, true);
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.segmentationModel, 'yolov8n-building-seg.pt');
    assert.equal(result.refinementModel, null);
    assert.equal(result.refinedCount, 0);
    assert.equal(result.refinementError, 'BUILDINGS_NOT_CONFIGURED');
    assert.equal(result.uncertainty, 'high');
  } finally { f.ui.destroy(); }
});

test('vision quick question asks the configured LLM for a current-view statistical analysis', async () => {
  const f = await fixture({ '/api/ai/chat': { text: '当前视口统计已生成。', toolCalls: [] } }, {}, { workspace: {
    captureImage: async () => ({ image: 'data:image/jpeg;base64,YQ==', capturedAt: Date.now(), viewKey: 'v1' }),
    getViewKey: () => 'v1', getViewSnapshot: () => ({}), captureState: () => ({}),
  } });
  try {
    f.e('vision-ask').emit('click');
    await settle();
    await settle();
    const request = f.requests.find((entry) => entry.path === '/api/ai/chat');
    assert.ok(request);
    const body = JSON.parse(request.options.body);
    assert.match(body.messages.at(-1).content, /我看到了什么/);
    assert.match(body.messages.at(-1).content, /按类别统计/);
  } finally { f.ui.destroy(); }
});

test('web search tool is forwarded through the same-origin Firecrawl proxy', async () => {
  let chats = 0;
  const f = await fixture({
    '/api/ai/chat': () => (++chats === 1
      ? { text: '', toolCalls: [{ id: 'search', name: 'web_search', arguments: { query: '最新机场公告', limit: 2 } }] }
      : { text: '搜索完成', toolCalls: [] }),
    '/api/ai/search': { available: true, provider: 'firecrawl', query: '最新机场公告', results: [], count: 0 },
  }, {}, { workspace: { getViewSnapshot: () => ({}), captureState: () => ({}) } });
  try {
    await f.ui.sendText('搜索最新机场公告');
    const request = f.requests.find((entry) => entry.path === '/api/ai/search');
    assert.ok(request);
    assert.deepEqual(JSON.parse(request.options.body), { query: '最新机场公告', limit: 2 });
  } finally { f.ui.destroy(); }
});

async function fixture(overrides = {}, browserFeatures = {}, assistantOptions = {}) {
  const elements = new Map();
  const requests = [];
  const page = { ...fakeElement(), setInterval: () => 1, clearInterval() {}, ...browserFeatures };
  const find = (node, id) => node.id === id ? node : (node.children || []).map((child) => find(child, id)).find(Boolean);
  const byId = (id) => {
    const dynamic = [...elements.values()].map((node) => find(node, id)).find(Boolean);
    if (dynamic) return dynamic;
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id);
  };
  const fetchImpl = async (path, options = {}) => {
    requests.push({ path, options });
    const supplied = overrides[path];
    const result = typeof supplied === 'function' ? await supplied(options, requests)
      : supplied || (path === '/api/ai/config' ? config : path === '/api/vision/buildings-seg'
        ? { ok: true, task: 'buildings-seg', model: 'yolov8n-building-seg.pt', image: { width: 20, height: 20 }, polygons: [{ points: [[1, 1], [10, 1], [10, 10]], confidence: 0.72 }] }
        : { ok: true, model: config.model });
    if (result instanceof Response) return result;
    return { ok: result.status ? result.status < 400 : true, status: result.status || 200, json: async () => result };
  };
  const ui = initAiAssistant({
    runAction: async () => ({ ok: true }), fetchImpl,
    documentRef: { ...fakeElement(), getElementById: byId, createElement: fakeElement, createElementNS: fakeElement, defaultView: page, activeElement: page },
    ...assistantOptions,
  });
  await settle();
  return { ui, requests, page, byId, e: (name) => byId(`ai-${name}`) };
}

test('Agent Pro search settings hydrate and preserve provider endpoint drafts while clearing passwords', async () => {
  const saved = { ...config, search: { provider: 'agent-pro', baseUrl: 'http://127.0.0.1:6637/api/search',
    configured: true, keyConfigured: true,
    agentPro: { baseUrl: 'http://127.0.0.1:6637/api/search', keyConfigured: true },
    firecrawl: { baseUrl: 'https://crawl.test/v2', keyConfigured: false } } };
  const f = await fixture({ '/api/ai/config': saved });
  try {
    assert.equal(f.e('search-provider').value, 'agent-pro');
    assert.equal(f.e('search-api-key-label').textContent, t('ai.search.agentProCredential'));
    f.e('search-base-url').value = 'http://127.0.0.1:7000/api/search';
    f.e('search-api-key').value = 'secret-to-clear';
    f.e('search-provider').value = 'firecrawl';
    f.e('search-provider').emit('change');
    assert.equal(f.e('search-base-url').value, 'https://crawl.test/v2');
    assert.equal(f.e('search-api-key').value, '');
    assert.equal(f.e('search-api-key-label').textContent, t('ai.search.apiKey'));
    f.e('search-provider').value = 'agent-pro';
    f.e('search-provider').emit('change');
    assert.equal(f.e('search-base-url').value, 'http://127.0.0.1:7000/api/search');
  } finally { f.ui.destroy(); }
});

test('search diagnostics distinguish configured, failed and verified availability', async () => {
  for (const state of ['configured', 'failed', 'empty', 'invalid_config', 'ok']) {
    const f = await fixture({
      '/api/ai/config': { ...config, search: { provider: 'agent-pro', baseUrl: 'http://127.0.0.1:6637/api/search', configured: true, keyConfigured: true } },
      '/api/ai/diagnostics': { search: { provider: 'agent-pro', status: state } },
    });
    try {
      f.e('search-refresh').emit('click');
      await settle();
      const key = state === 'ok' ? 'ai.search.statusReady' : state === 'configured' ? 'ai.search.statusConfigured' : 'ai.search.statusUnavailable';
      assert.equal(f.e('search-status').textContent, t(key, { provider: 'Agent Pro' }), state);
    } finally { f.ui.destroy(); }
  }
});

test('shared local Firecrawl without auth renders no-key-required status', async () => {
  const f = await fixture({ '/api/ai/config': { ...config,
    search: { provider: 'firecrawl', baseUrl: 'http://127.0.0.1:3002/v2', configured: true, keyConfigured: false, keyOptional: true },
  } });
  try {
    assert.equal(f.e('search-key-status').textContent, t('ai.noKeyRequired'));
    assert.equal(f.e('search-api-key').placeholder, t('ai.keyOptional'));
  } finally { f.ui.destroy(); }
});

test('closing and pagehide remove transient search credentials', async () => {
  for (const event of ['close', 'pagehide']) {
    const f = await fixture();
    try {
      f.e('search-api-key').value = 'private-local-credential';
      if (event === 'close') f.byId('ai-assistant').emit('close');
      else f.page.emit('pagehide');
      assert.equal(f.e('search-api-key').value, '', event);
    } finally { f.ui.destroy(); }
  }
});

test('web search normalizes malformed and unavailable results to safe tool errors', async () => {
  for (const payload of [null, { available: false, code: 'SEARCH_AUTH_ERROR' }, { status: 500, code: 'secret-token' }, { status: 500, code: { secret: 'token' } }]) {
    let chats = 0;
    const f = await fixture({
      '/api/ai/chat': () => (++chats === 1
        ? { text: '', toolCalls: [{ id: 's', name: 'web_search', arguments: { query: 'airports' } }] }
        : { text: 'done', toolCalls: [] }),
      '/api/ai/search': () => payload,
    });
    try {
      await f.ui.sendText('Search airports');
      const followup = JSON.parse(f.requests.filter((r) => r.path === '/api/ai/chat').at(-1).options.body);
      const result = JSON.parse(followup.messages.find((entry) => entry.name === 'web_search').content);
      assert.equal(result.ok, false);
      assert.match(result.error, /^SEARCH_[A-Z_]+$/);
      assert.doesNotMatch(JSON.stringify(result), /secret-token|"secret"/);
    } finally { f.ui.destroy(); }
  }
});

test('web search returns valid bounded JSON with successful Agent Pro evidence', async () => {
  let chats = 0;
  const f = await fixture({
    '/api/ai/chat': () => (++chats === 1
      ? { text: '', toolCalls: [{ id: 's', name: 'web_search', arguments: { query: 'airports' } }] }
      : { text: 'done', toolCalls: [] }),
    '/api/ai/search': { available: true, provider: 'agent-pro', query: 'airports', results: Array.from({ length: 8 }, (_, n) => ({
      title: `Airport ${n}`, url: `https://example.test/${n}`, description: 'd'.repeat(1000), markdown: 'm'.repeat(3000),
    })), count: 8, unsafeField: 'x'.repeat(20000) },
  });
  try {
    await f.ui.sendText('Search airports');
    const followup = JSON.parse(f.requests.filter((r) => r.path === '/api/ai/chat').at(-1).options.body);
    const message = followup.messages.find((entry) => entry.name === 'web_search');
    const result = JSON.parse(message.content);
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'agent-pro');
    assert.ok(result.results.length > 0);
    assert.ok(message.content.length <= 16000);
    assert.equal(Object.hasOwn(result, 'unsafeField'), false);
  } finally { f.ui.destroy(); }
});

test('refresh search status does not keep an earlier successful search after a failed diagnostic', async () => {
  let chats = 0;
  const f = await fixture({
    '/api/ai/config': { ...config, search: { provider: 'firecrawl', baseUrl: 'https://crawl.test/v2', configured: true, keyConfigured: true } },
    '/api/ai/chat': () => (++chats === 1
      ? { text: '', toolCalls: [{ id: 's', name: 'web_search', arguments: { query: 'airports' } }] }
      : { text: 'done', toolCalls: [] }),
    '/api/ai/search': { available: true, provider: 'firecrawl', results: [] },
    '/api/ai/diagnostics': { search: { status: 'failed', provider: 'firecrawl' } },
  });
  try {
    await f.ui.sendText('Search airports');
    assert.equal(f.e('search-status').textContent, t('ai.search.statusReady', { provider: 'Firecrawl' }));
    f.e('search-refresh').emit('click');
    await settle();
    assert.equal(f.e('search-status').textContent, t('ai.search.statusUnavailable', { provider: 'Firecrawl' }));
  } finally { f.ui.destroy(); }
});

test('voiceprint controls reflect unavailable engine and keep actions disabled', async () => {
  const { ui, e } = await fixture({
    '/api/ai/voiceprint/status': { available: false, enabled: false, mode: 'observe', profiles: [] },
  });
  try {
    assert.equal(e('voiceprint-status').textContent, t('ai.voiceprint.unavailable'));
    assert.equal(e('voiceprint-enroll').disabled, true);
    assert.equal(e('voiceprint-verify').disabled, true);
    assert.equal(e('voiceprint-delete').disabled, true);
  } finally { ui.destroy(); }
});

test('voiceprint threshold hydrates from saved configuration and status', async () => {
  const saved = { ...config, speech: {
    provider: 'custom', model: 'local-whisper-small', baseUrl: 'http://127.0.0.1:8765/v1',
    voiceprint: { enabled: true, mode: 'enforce', profile: 'owner', threshold: 0.47 },
  } };
  const { ui, e } = await fixture({
    '/api/ai/config': saved,
    '/api/ai/voiceprint/status': { available: true, enabled: true, mode: 'enforce', profile: 'owner', threshold: 0.47, profiles: [] },
  });
  try {
    assert.equal(e('voiceprint-threshold').value, '0.47');
    assert.equal(e('voiceprint-threshold-value').textContent, '0.47');
  } finally { ui.destroy(); }
});

test('voiceprint enrollment and verification upload a sample without sending JSON', async () => {
  let statusCalls = 0;
  const status = () => ({ available: true, enabled: true, mode: 'observe', profiles: [{ id: 'owner' }] });
  const { ui, e, requests } = await fixture({
    '/api/ai/voiceprint/status': () => { statusCalls += 1; return status(); },
    '/api/ai/voiceprint/enroll': { ok: true, profile_id: 'owner' },
    '/api/ai/voiceprint/verify': { ok: true, verified: true, score: 0.91 },
  });
  try {
    await settle();
    await settle();
    e('voiceprint-profile').value = 'owner';
    e('voiceprint-audio').files = [new File(['sample'], 'sample.webm', { type: 'audio/webm' })];
    e('voiceprint-audio').emit('change');
    assert.equal(e('voiceprint-enroll').disabled, false);
    e('voiceprint-enroll').emit('click');
    await settle();
    const enroll = requests.find((request) => request.path === '/api/ai/voiceprint/enroll');
    assert.equal(enroll.options.method, 'POST');
    assert.equal(enroll.options.headers, undefined);
    assert.equal(enroll.options.body instanceof FormData, true);
    assert.equal(enroll.options.body.get('profile_id'), 'owner');
    assert.equal(enroll.options.body.get('file').name, 'sample.webm');
    assert.equal(statusCalls >= 2, true);

    e('voiceprint-verify').emit('click');
    await settle();
    const verify = requests.find((request) => request.path === '/api/ai/voiceprint/verify');
    assert.equal(verify.options.body instanceof FormData, true);
    assert.equal(verify.options.body.get('threshold'), '0.25');
    assert.equal(e('settings-status').textContent, t('ai.voiceprint.verified'));
  } finally { ui.destroy(); }
});

test('voiceprint recorder creates an in-memory sample and releases microphone tracks', async () => {
  const tracks = [{ stopped: 0, stop() { this.stopped += 1; } }];
  const stream = { getTracks: () => tracks };
  const recorders = [];
  class Recorder {
    static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    constructor(_stream, options) { this.mimeType = options?.mimeType || 'audio/webm'; this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['sample'], { type: this.mimeType }) }); this.onstop?.(); }
  }
  const { ui, e, requests } = await fixture({
    '/api/ai/voiceprint/status': { available: true, enabled: false, mode: 'observe', profiles: [] },
    '/api/ai/voiceprint/enroll': { ok: true, profile_id: 'owner' },
  }, { navigator: { mediaDevices: { getUserMedia: async () => stream } }, MediaRecorder: Recorder });
  try {
    await settle();
    await settle();
    e('voiceprint-profile').value = 'owner';
    e('voiceprint-record').emit('click');
    await settle();
    assert.equal(recorders.length, 1);
    assert.equal(recorders[0].state, 'recording');
    assert.equal(e('voiceprint-enroll').disabled, true);
    e('voiceprint-record').emit('click');
    await settle();
    assert.equal(tracks[0].stopped, 1);
    assert.match(e('voiceprint-record-status').textContent, /recorded|完成/);
    assert.equal(e('voiceprint-enroll').disabled, false);
    e('voiceprint-enroll').emit('click');
    await settle();
    const request = requests.find((entry) => entry.path === '/api/ai/voiceprint/enroll');
    assert.equal(request.options.body instanceof FormData, true);
    assert.equal(request.options.body.get('file').type, 'audio/webm;codecs=opus');
  } finally { ui.destroy(); }
});

test('closing the assistant cancels pending microphone permission and releases a late stream', async () => {
  let resolveMicrophone;
  let microphoneRequests = 0;
  let recordings = 0;
  let stopped = 0;
  const permission = new Promise((resolve) => { resolveMicrophone = resolve; });
  const { ui, e } = await fixture({
    '/api/ai/voiceprint/status': { available: true, enabled: false, profiles: [] },
  }, {
    navigator: { mediaDevices: { getUserMedia() { microphoneRequests += 1; return permission; } } },
    MediaRecorder: class { start() { recordings += 1; } },
  });
  try {
    e('voiceprint-record').emit('click');
    assert.equal(e('voiceprint-record').disabled, true);
    e('voiceprint-record').emit('click');
    e('assistant-close').emit('click');
    resolveMicrophone({ getTracks: () => [{ stop() { stopped += 1; } }] });
    await settle();
    assert.equal(microphoneRequests, 1);
    assert.equal(recordings, 0);
    assert.equal(stopped, 1);
  } finally { ui.destroy(); }
});

test('recording replaces the previous sample and locks voiceprint uploads until stopped', async () => {
  let stopped = 0;
  class Recorder {
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['new sample']) }); this.onstop?.(); }
  }
  const { ui, e, requests } = await fixture({
    '/api/ai/voiceprint/status': { available: true, enabled: false, profiles: [] },
  }, {
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped += 1; } }] }) } },
    MediaRecorder: Recorder,
  });
  try {
    e('voiceprint-profile').value = 'owner';
    e('voiceprint-audio').files = [new File(['old sample'], 'old.wav', { type: 'audio/wav' })];
    e('voiceprint-audio').emit('change');
    e('voiceprint-record').emit('click');
    await settle();
    assert.equal(e('voiceprint-audio').disabled, true);
    assert.equal(e('voiceprint-enroll').disabled, true);
    e('voiceprint-enroll').emit('click');
    assert.equal(requests.some(({ path }) => path.endsWith('/enroll')), false);
    e('assistant-close').emit('click');
    assert.equal(stopped, 1);
    assert.equal(e('voiceprint-enroll').disabled, true);
  } finally { ui.destroy(); }
});

test('destroying during asynchronous recorder stop discards late sample callbacks', async () => {
  let recorder;
  const { ui, e } = await fixture({
    '/api/ai/voiceprint/status': { available: true, enabled: false, profiles: [] },
  }, {
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    MediaRecorder: class {
      constructor() { recorder = this; this.state = 'inactive'; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; }
    },
  });
  e('voiceprint-record').emit('click');
  await settle();
  const deliver = recorder.ondataavailable;
  e('voiceprint-record').emit('click');
  const finish = recorder.onstop;
  ui.destroy();
  const oldStatus = e('voiceprint-record-status').textContent;
  deliver?.({ data: new Blob(['late sample']) });
  finish?.();
  assert.equal(e('voiceprint-record-status').textContent, oldStatus);
  assert.equal(e('voiceprint-enroll').disabled, true);
});

test('voiceprint sample recording stops at fifteen seconds and keeps the completed sample', async (context) => {
  let stopped = 0;
  class Recorder {
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/mp4'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['sample']) }); this.onstop?.(); }
  }
  const { ui, e, requests } = await fixture({
    '/api/ai/voiceprint/status': { available: true, enabled: false, profiles: [] },
  }, {
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped += 1; } }] }) } },
    MediaRecorder: Recorder,
  });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    e('voiceprint-profile').value = 'owner';
    e('voiceprint-record').emit('click');
    await settle();
    context.mock.timers.tick(14_999);
    assert.equal(stopped, 0);
    context.mock.timers.tick(1);
    assert.equal(stopped, 1);
    assert.equal(e('voiceprint-enroll').disabled, false);
    e('voiceprint-enroll').emit('click');
    await settle();
    const sample = requests.find(({ path }) => path.endsWith('/enroll')).options.body.get('file');
    assert.equal(sample.type, 'audio/mp4');
    assert.match(sample.name, /\.mp4$/);
  } finally { ui.destroy(); }
});

test('voiceprint permission timeout permits retry and releases the late microphone', async (context) => {
  let resolveMicrophone;
  let stopped = 0;
  const { ui, e } = await fixture({
    '/api/ai/voiceprint/status': { available: true, enabled: false, profiles: [] },
  }, {
    navigator: { mediaDevices: { getUserMedia: () => new Promise((resolve) => { resolveMicrophone = resolve; }) } },
    MediaRecorder: class {},
  });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    e('voiceprint-record').emit('click');
    context.mock.timers.tick(30_000);
    assert.equal(e('voiceprint-record').disabled, false);
    assert.equal(e('settings-status').textContent, t('ai.voiceprint.error.recording'));
    resolveMicrophone({ getTracks: () => [{ stop() { stopped += 1; } }] });
    await settle();
    assert.equal(stopped, 1);
    assert.equal(e('voiceprint-record').getAttribute('aria-pressed'), 'false');
  } finally { ui.destroy(); }
});

test('voiceprint deletion uses encoded profile id and no request body', async () => {
  const { ui, e, requests } = await fixture({
    '/api/ai/voiceprint/status': { available: true, enabled: true, mode: 'enforce', profiles: [{ id: 'owner/test' }] },
    '/api/ai/voiceprint/profiles/owner%2Ftest': { ok: true },
  });
  try {
    e('voiceprint-profile').value = 'owner/test';
    e('voiceprint-profile').emit('input');
    assert.equal(e('voiceprint-delete').disabled, false);
    e('voiceprint-delete').emit('click');
    await settle();
    const deletion = requests.find((request) => request.path.includes('/api/ai/voiceprint/profiles/'));
    assert.equal(deletion.path, '/api/ai/voiceprint/profiles/owner%2Ftest');
    assert.equal(deletion.options.method, 'DELETE');
    assert.equal(deletion.options.body, undefined);
  } finally { ui.destroy(); }
});

test('voiceprint settings render safe localized service errors', async () => {
  const previous = getLocale();
  setLocale('zh-CN');
  try {
    for (const code of ['VOICEPRINT_TIMEOUT', 'VOICEPRINT_BUSY', 'VOICEPRINT_STORAGE_ERROR', 'VOICEPRINT_AUDIO']) {
      const { ui, e } = await fixture({
        '/api/ai/voiceprint/status': { available: true, profiles: [] },
        '/api/ai/voiceprint/enroll': { status: 503, error: { code, message: 'private server detail' } },
      });
      try {
        e('voiceprint-profile').value = 'owner';
        e('voiceprint-audio').files = [new File(['sample'], 'sample.wav', { type: 'audio/wav' })];
        e('voiceprint-enroll').emit('click');
        await settle();
        assert.equal(e('settings-status').textContent, t(`ai.speech.error.${code}`));
        assert.match(e('settings-status').textContent, /[\u4e00-\u9fff]/);
        assert.doesNotMatch(e('settings-status').textContent, /private server detail/);
      } finally { ui.destroy(); }
    }
  } finally { setLocale(previous); }
});

test('assistant uses fresh viewport evidence and exposes statistics through its protected runner', async () => {
  let count = 3;
  let toolReturned = false;
  const current = () => ({ scope: 'viewport', bounds: { west: -10, south: -10, east: 10, north: 10 }, generatedAt: count,
    viewport: { available: true, width: 1000, height: 700 }, layers: [{ id: 'local-datacenters', name: 'Data centers', enabled: true,
      status: 'ready', source: 'Local', count, countIsLowerBound: false, records: [{ id: 'a', latitude: 0, longitude: 0 }] }] });
  const workspace = { getViewSnapshot: current, getSnapshot: () => ({ ...current(), scope: 'bounds', layers: [] }) };
  const f = await fixture({ '/api/ai/chat': () => {
    if (!toolReturned) { toolReturned = true; return { text: '', toolCalls: [{ id: 'stats', name: 'get_view_statistics', arguments: { layerId: 'local-datacenters', limit: 1 } }] }; }
    return { text: 'Result', toolCalls: [] };
  } }, {}, { workspace, runAction: async () => ({ ok: true, layers: [{ id: 'local-datacenters', count: 4362 }] }) });
  try {
    await f.ui.sendText('Count this viewport');
    let bodies = f.requests.filter(({ path }) => path === '/api/ai/chat').map(({ options }) => JSON.parse(options.body));
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      assert.equal(body.context.intelligence.scope, 'viewport-loaded-data-only');
      assert.equal(body.context.intelligence.layers[0].count, 3);
      assert.equal(body.context.layers[0].count, undefined);
      assert.equal(body.context.layers[0].loadedCount, 4362);
    }
    const tool = JSON.parse(bodies[1].messages.find((message) => message.role === 'tool').content);
    assert.equal(tool.layers[0].count, 3);
    count = 7;
    await f.ui.sendText('Count the new viewport');
    bodies = f.requests.filter(({ path }) => path === '/api/ai/chat').map(({ options }) => JSON.parse(options.body));
    assert.equal(bodies.at(-1).context.intelligence.layers[0].count, 7);
    assert.equal((await f.ui.runMapAction('get_view_statistics', {})).totalCount, 7);
  } finally { f.ui.destroy(); }
});

test('stream updates one simplified message in place and retains partial text on stop', async () => {
  const previous = getLocale();
  setLocale('zh-CN', { persist: false });
  let sink;
  const response = new Response(new ReadableStream({ start(controller) { sink = controller; } }), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
  const { ui, e } = await fixture({ '/api/ai/chat': () => response });
  const events = [];
  ui.subscribe((event) => events.push(event));
  try {
    const pending = ui.sendText('請問你能幹什麼工作');
    await settle();
    const emit = (text) => sink.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`));
    emit('飛機');
    await settle();
    const row = e('messages').children.at(-1);
    assert.equal(row.children[1].textContent, '飞机');
    assert.equal(row.dataset.streaming, 'true');
    assert.equal(e('conversation-status').textContent, t('ai.streaming'));
    emit('與衛星');
    await settle();
    assert.equal(e('messages').children.at(-1), row);
    assert.equal(e('messages').children.length, 2);
    assert.equal(row.children[1].textContent, '飞机与卫星');
    e('stop').emit('click');
    await assert.rejects(pending, { code: 'LLM_CANCELLED' });
    assert.equal(row.dataset.streaming, 'false');
    assert.equal(row.children[2].textContent, t('ai.incomplete'));
    assert.equal(events.filter((event) => event.type === 'reply').at(-1).incomplete, true);
  } finally { ui.destroy(); setLocale(previous, { persist: false }); }
});

test('voice drafts are simplified and replaced without overwriting typed composer text or sending', async () => {
  const previous = getLocale();
  setLocale('zh-CN', { persist: false });
  const { ui, e, requests } = await fixture();
  try {
    e('message').value = 'keep typed draft';
    ui.setVoiceDraft('請問');
    ui.setVoiceDraft('請問你能幹什麼工作');
    assert.equal(e('messages').children.length, 1);
    assert.equal(e('messages').children[0].children[1].textContent, '请问你能干什么工作');
    assert.equal(e('message').value, 'keep typed draft');
    assert.equal(requests.filter(({ path }) => path === '/api/ai/chat').length, 0);
    ui.setVoiceDraft('');
    assert.equal(e('messages').children[0].className, 'ai-empty');
  } finally { ui.destroy(); setLocale(previous, { persist: false }); }
});

test('voice draft can be edited in the composer before sending', async () => {
  const { ui, e } = await fixture();
  try {
    ui.setVoiceDraft('璜嬪晱椋涙');
    assert.equal(e('message').value, '');
    const normalized = e('messages').children[0].children[1].textContent;
    e('voice-draft-edit').emit('click');
    assert.equal(e('message').value, normalized);
    assert.equal(e('messages').children[0].className, 'ai-empty');
    assert.equal(e('send').disabled, false);
  } finally { ui.destroy(); }
});

test('diagnostics endpoint is requested when opening settings', async () => {
  let calls = 0;
  const { ui, e } = await fixture({
    '/api/ai/diagnostics': () => { calls += 1; return { speech: { status: 'ok', model: 'local-whisper-small' }, llm: { status: 'ok' } }; },
  });
  try {
    e('tab-settings').emit('click');
    await settle();
    assert.equal(calls >= 1, true);
    assert.match(e('diagnostics').textContent, /local-whisper-small/);
  } finally { ui.destroy(); }
});

test('composer respects IME composition and normalizes after composition ends', async () => {
  const previous = getLocale();
  setLocale('zh-CN', { persist: false });
  const { ui, e } = await fixture();
  try {
    e('message').value = '請問';
    e('message').emit('input', { isComposing: true });
    assert.equal(e('message').value, '請問');
    e('message').emit('compositionend');
    assert.equal(e('message').value, '请问');
    e('message').value = '臺灣飛機';
    e('message').emit('input', { isComposing: false });
    assert.equal(e('message').value, '台湾飞机');
  } finally { ui.destroy(); setLocale(previous, { persist: false }); }
});

test('clear and a new turn cannot be repopulated by an older cancelled partial message', async () => {
  let sink;
  const response = new Response(new ReadableStream({ start(controller) { sink = controller; } }), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
  let calls = 0;
  const { ui, e } = await fixture({ '/api/ai/chat': () => ++calls === 1 ? response : { text: 'new reply', toolCalls: [] } });
  try {
    const pending = ui.sendText('old');
    await settle();
    sink.enqueue(new TextEncoder().encode('data: {"type":"delta","text":"old partial"}\n\n'));
    await settle();
    ui.cancel();
    e('clear').emit('click');
    const next = ui.sendText('new');
    await assert.rejects(pending, { code: 'LLM_CANCELLED' });
    await next;
    assert.deepEqual(e('messages').children.map((row) => row.children[1].textContent), ['new', 'new reply']);
  } finally { ui.destroy(); }
});

test('provider changes reset provider-specific fields, clear pasted keys, and disable unsaved tests', async () => {
  const { ui, requests, e } = await fixture();
  try {
    assert.equal(e('test').disabled, false);
    e('api-key').value = 'temporary-test-key';
    e('provider').value = 'deepseek';
    e('provider').emit('change');
    assert.equal(e('model').value, 'deepseek-chat');
    assert.equal(e('base-url').value, 'https://two.test/v1');
    assert.equal(e('api-key').value, '');
    assert.equal(e('test').disabled, true);
    e('test').emit('click');
    await settle();
    assert.equal(requests.filter((request) => request.path === '/api/ai/test').length, 0);
  } finally { ui.destroy(); }
});

test('save submits only selected settings and password, then clears the password', async () => {
  const savedConfig = {
    ...config, provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://two.test/v1',
    providers: config.providers.map((entry) => entry.id === 'deepseek' ? { ...entry, keyConfigured: true } : entry),
  };
  const { ui, requests, e } = await fixture({
    '/api/ai/config': (_options, seen) => seen.filter((request) => request.path === '/api/ai/config').length === 1 ? config : savedConfig,
  });
  try {
    e('provider').value = 'deepseek';
    e('provider').emit('change');
    e('api-key').value = 'mock-deepseek-key';
    e('settings-form').emit('input');
    e('settings-form').emit('submit');
    await settle();
    const saved = JSON.parse(requests.find((request) => request.path === '/api/setup/keys').options.body);
    assert.deepEqual(saved, {
      GEV_LLM_PROVIDER: 'deepseek', GEV_LLM_MODEL: 'deepseek-chat', GEV_LLM_BASE_URL: 'https://two.test/v1', DEEPSEEK_API_KEY: 'mock-deepseek-key', GEV_STT_PROVIDER: 'browser',
    });
    assert.equal(e('api-key').value, '');
    assert.equal(e('test').disabled, false);
    assert.equal(e('key-status').textContent, t('ai.keyConfigured'));
    assert.equal(requests.filter((request) => request.path === '/api/ai/config').length, 2);
  } finally { ui.destroy(); }
});

test('saved configuration uses fresh server readiness instead of guessing from a pasted key', async () => {
  const refreshed = { ...config, configured: false, providers: config.providers.map((entry) => ({ ...entry, keyConfigured: false })) };
  const { ui, e } = await fixture({
    '/api/ai/config': (_options, requests) => requests.filter((request) => request.path === '/api/ai/config').length === 1 ? config : refreshed,
  });
  try {
    e('api-key').value = 'mock-new-key';
    e('settings-form').emit('submit');
    await settle();
    assert.equal(e('test').disabled, true);
    assert.equal(e('key-status').textContent, t('ai.keyMissing'));
  } finally { ui.destroy(); }
});

test('failed post-save refresh disables AI until configuration is retrieved again', async () => {
  const { ui, e } = await fixture({
    '/api/ai/config': (_options, requests) => {
      if (requests.filter((request) => request.path === '/api/ai/config').length === 1) return config;
      throw new TypeError('Server restarting');
    },
  });
  try {
    e('model').value = 'other';
    e('settings-form').emit('submit');
    await settle();
    assert.equal(e('test').disabled, true);
    assert.equal(e('send').disabled, true);
    assert.equal(e('settings-status').dataset.error, 'true');
  } finally { ui.destroy(); }
});

test('pagehide aborts active settings requests and clears transient credentials', async () => {
  const { ui, requests, page, e } = await fixture({
    '/api/ai/test': ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
    }),
  });
  try {
    e('test').emit('click');
    e('api-key').value = 'transient-test-key';
    page.emit('pagehide');
    assert.equal(requests.find((request) => request.path === '/api/ai/test').options.signal.aborted, true);
    assert.equal(e('api-key').value, '');
    await settle();
  } finally { ui.destroy(); }
});

test('environment-managed save conflict is localized and does not claim success', async () => {
  const previous = getLocale();
  setLocale('zh-CN', { persist: false });
  const { ui, e } = await fixture({ '/api/setup/keys': { status: 409, error: 'Managed by environment' } });
  try {
    e('model').value = 'other-model';
    e('settings-form').emit('submit');
    await settle();
    assert.equal(e('settings-status').textContent, t('ai.error.external'));
    assert.equal(e('settings-status').dataset.error, 'true');
    assert.equal(e('test').disabled, true);
  } finally { ui.destroy(); setLocale(previous, { persist: false }); }
});

test('closing the assistant clears transient credentials and restores collapsed trigger state', async () => {
  const { ui, e } = await fixture();
  try {
    ui.open('settings');
    e('api-key').value = 'temporary-test-key';
    ui.close();
    assert.equal(e('api-key').value, '');
    assert.equal(e('assistant-toggle').getAttribute('aria-expanded'), 'false');
  } finally { ui.destroy(); }
});

test('opening the assistant leaves the document interactive and the trigger toggles it closed', async () => {
  const { ui, e } = await fixture();
  try {
    e('assistant-toggle').emit('click');
    assert.equal(e('assistant').open, true);
    assert.equal(e('assistant').modal, false, 'native dialog must be non-modal');
    assert.equal(e('assistant').getAttribute('aria-modal'), 'false');
    e('assistant-toggle').emit('click');
    assert.equal(e('assistant').open, false);
    assert.equal(e('assistant-toggle').getAttribute('aria-expanded'), 'false');
  } finally { ui.destroy(); }
});

test('Escape within the assistant closes it and does not reach map shortcuts', async () => {
  const { ui, e } = await fixture();
  try {
    ui.open('settings');
    e('api-key').value = 'transient-test-key';
    let prevented = false;
    let stopped = false;
    e('assistant').emit('keydown', {
      key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() { stopped = true; },
    });
    assert.equal(e('assistant').open, false);
    assert.equal(e('api-key').value, '');
    assert.equal(e('assistant-toggle').focused, true);
    assert.equal(prevented, true);
    assert.equal(stopped, true);
  } finally { ui.destroy(); }
});

test('panel typing is not prevented and composition Escape cannot dismiss the panel', async () => {
  const { ui, e, page } = await fixture();
  try {
    ui.open('conversation');
    let prevented = false;
    e('assistant').emit('keydown', { key: 'a', preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
    e('assistant').emit('keydown', { key: 'Escape', isComposing: true });
    assert.equal(e('assistant').open, true);
    page.emit('keydown', { key: 'Escape' });
    assert.equal(e('assistant').open, true, 'Escape outside the panel belongs to the map');
  } finally { ui.destroy(); }
});

test('conversation renders provider text literally and clear resets its transcript', async () => {
  const { ui, e } = await fixture({ '/api/ai/chat': { text: '<img src=x onerror=alert(1)>', toolCalls: [] } });
  try {
    e('message').value = 'Summarize';
    e('message-form').emit('submit');
    await settle();
    const assistant = e('messages').children.find((row) => row.dataset.role === 'assistant');
    assert.equal(assistant.children[1].textContent, '<img src=x onerror=alert(1)>');
    assert.equal(assistant.children[1].children.length, 0);
    e('clear').emit('click');
    assert.equal(e('messages').children.length, 1);
    assert.equal(e('messages').children[0].textContent, t('ai.empty'));
  } finally { ui.destroy(); }
});

test('assistant replies hide emphasis markers while user input and HTML remain literal', async () => {
  const { ui, e } = await fixture({ '/api/ai/chat': {
    text: '**Flight**: IGO68N\n*Status*: live\n* Source: OpenSky\n**<img src=x onerror=alert(1)>**', toolCalls: [],
  } });
  try {
    await ui.sendText('Keep my **input**');
    const rows = e('messages').children;
    assert.equal(rows[0].children[1].textContent, 'Keep my **input**');
    assert.equal(rows[1].children[1].textContent,
      'Flight: IGO68N\nStatus: live\n- Source: OpenSky\n<img src=x onerror=alert(1)>');
    assert.equal(rows[1].children[1].children.length, 0);
  } finally { ui.destroy(); }
});

test('streamed emphasis never flashes markers and stays plain after interruption and locale rerender', async () => {
  const previous = getLocale();
  let sink;
  const response = new Response(new ReadableStream({ start(controller) { sink = controller; } }), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
  const { ui, e } = await fixture({ '/api/ai/chat': () => response });
  let pending;
  try {
    pending = ui.sendText('Summarize');
    pending.catch(() => {});
    await settle();
    for (const chunk of ['**', 'Flight', '**: IGO68N\n*Status']) {
      sink.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`));
      await settle();
      assert.doesNotMatch(e('messages').children.at(-1).children[1].textContent, /\*/);
    }
    e('stop').emit('click');
    await assert.rejects(pending, { code: 'LLM_CANCELLED' });
    setLocale(previous === 'en' ? 'zh-CN' : 'en', { persist: false });
    assert.equal(e('messages').children.at(-1).children[1].textContent, 'Flight: IGO68N\nStatus');
    assert.equal(e('messages').children.at(-1).children[2].textContent, t('ai.incomplete'));
  } finally { ui.destroy(); setLocale(previous, { persist: false }); }
});

test('voice sendText shares the conversation transcript without focusing its textbox', async () => {
  const { ui, e, requests, page } = await fixture({ '/api/ai/chat': { text: 'Acknowledged', toolCalls: [] } });
  try {
    assert.equal(await ui.ready(), config);
    assert.equal(ui.getConfig(), config);
    const answer = await ui.sendText('Voice command');
    assert.equal(answer, 'Acknowledged');
    assert.equal(e('assistant').open, true);
    assert.notEqual(e('message').focused, true);
    assert.equal(page.focused, true, 'prior push-to-talk target regains focus');
    e('message').value = 'Typed follow-up';
    e('message-form').emit('submit');
    await settle();
    const sent = requests.filter((request) => request.path === '/api/ai/chat').map((request) => JSON.parse(request.options.body));
    assert.deepEqual(sent[1].messages.map((message) => message.content), ['Voice command', 'Acknowledged', 'Typed follow-up']);
  } finally { ui.destroy(); }
});

test('voice router receives config, close, clear, stop, save and teardown events', async () => {
  const { ui, e } = await fixture();
  const events = [];
  const unsubscribe = ui.subscribe((event) => events.push(event));
  try {
    assert.equal(events[0].type, 'config');
    ui.open();
    ui.close();
    e('clear').emit('click');
    e('stop').emit('click');
    e('model').value = 'other';
    e('settings-form').emit('submit');
    await settle();
    assert.equal(events.filter((event) => event.type === 'cancel').length, 4);
    assert.equal(events.filter((event) => event.type === 'config').length, 2);
    ui.destroy();
    assert.equal(events.at(-1).type, 'destroy');
    unsubscribe();
  } finally { ui.destroy(); }
});

test('browser speech reports unsupported browsers and hides custom credentials', async () => {
  const { ui, e } = await fixture();
  try {
    assert.equal(e('speech-provider').value, 'browser');
    assert.equal(e('speech-server-fields').hidden, true);
    assert.equal(e('speech-custom-fields').hidden, true);
    assert.equal(e('voice-status').textContent, t('ai.speech.browserUnavailable'));
    assert.equal(e('speech-hint').textContent, t('ai.speech.browserHint'));
    e('speech-provider').value = 'custom';
    e('speech-provider').emit('change');
    assert.equal(e('speech-custom-fields').hidden, false);
    assert.equal(e('speech-base-url').disabled, false);
    e('speech-api-key').value = 'temporary-asr-key';
    e('speech-provider').value = 'browser';
    e('speech-provider').emit('change');
    assert.equal(e('speech-api-key').value, '');
    assert.equal(e('speech-base-url').disabled, true);
  } finally { ui.destroy(); }
});

test('sendText reports localized errors before rejecting to the voice router', async () => {
  const { ui, e } = await fixture({ '/api/ai/chat': { status: 429, code: 'LLM_RATE_LIMITED' } });
  try {
    await assert.rejects(ui.sendText('Voice command'), { code: 'LLM_RATE_LIMITED' });
    assert.equal(e('conversation-status').textContent, t('ai.error.rateLimited'));
  } finally { ui.destroy(); }
});

test('browser recognition availability is independent of an OpenAI credential', async () => {
  const current = { ...config, provider: 'deepseek', voice: { configured: false }, speech: { provider: 'browser', configured: true } };
  const { ui, e } = await fixture({ '/api/ai/config': current }, { SpeechRecognition: function MockRecognition() {} });
  try {
    assert.equal(e('voice-status').textContent, t('ai.speech.browserReady'));
    assert.doesNotMatch(e('voice-status').textContent, /OpenAI/);
    e('speech-provider').value = 'realtime';
    e('speech-provider').emit('change');
    assert.equal(e('voice-status').textContent, t('ai.voiceMissing'));
  } finally { ui.destroy(); }
});

test('server speech preserves a custom key until an explicit replacement is submitted', async () => {
  const speech = { provider: 'custom', configured: true, model: 'whisper-1', baseUrl: 'https://asr.test/v1', keyConfigured: true };
  const current = { ...config, speech };
  const { ui, e, requests } = await fixture({ '/api/ai/config': current });
  try {
    assert.equal(e('speech-api-key').placeholder, t('ai.keyPreserve'));
    assert.equal(e('voice-status').textContent, t('ai.speech.serverReady'));
    e('speech-model').value = 'transcribe-large';
    e('settings-form').emit('submit');
    await settle();
    const body = JSON.parse(requests.find((request) => request.path === '/api/setup/keys').options.body);
    assert.equal(body.GEV_STT_MODEL, 'transcribe-large');
    assert.equal(body.GEV_STT_BASE_URL, speech.baseUrl);
    assert.equal(Object.hasOwn(body, 'GEV_STT_API_KEY'), false);
    const replacement = buildAiSettingsPayload(current, { ...current, speech: { ...speech, apiKey: ' mock-speech-key ' } });
    assert.equal(replacement.GEV_STT_API_KEY, 'mock-speech-key');
  } finally { ui.destroy(); }
});

test('sendText cancellation aborts the shared request and notifies the router without recursion', async () => {
  const { ui, requests } = await fixture({
    '/api/ai/chat': ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
    }),
  });
  try {
    let cancels = 0;
    ui.subscribe((event) => { if (event.type === 'cancel') { cancels += 1; ui.cancel(); } });
    const answer = ui.sendText('Pending voice command');
    const rejected = assert.rejects(answer, { code: 'LLM_CANCELLED' });
    await settle();
    ui.cancel();
    await rejected;
    assert.equal(requests.find((request) => request.path === '/api/ai/chat').options.signal.aborted, true);
    assert.equal(cancels, 1);
  } finally { ui.destroy(); }
});

test('unsupported current-endpoint transcription stays explicit and cannot be saved', async () => {
  const current = { ...config, provider: 'deepseek', speech: { provider: 'current', model: 'whisper-1', configured: false } };
  const { ui, e, requests } = await fixture({ '/api/ai/config': current });
  try {
    const option = { value: 'current', disabled: false };
    e('speech-provider').append(option);
    e('settings-form').emit('input');
    assert.equal(option.disabled, true);
    assert.equal(e('voice-status').textContent, t('ai.speech.currentUnavailable'));
    e('settings-form').emit('submit');
    await settle();
    assert.equal(requests.some((request) => request.path === '/api/setup/keys'), false);
    assert.equal(e('settings-status').textContent, t('ai.speech.error.VOICE_INVALID_CONFIG'));
  } finally { ui.destroy(); }
});

test('custom transcription settings survive switching to browser mode, saving, and switching back', async () => {
  const custom = { model: 'custom-whisper', baseUrl: 'https://asr-only.test/v1', keyConfigured: true, configured: true };
  const first = { ...config, speech: { ...custom, provider: 'custom', custom } };
  const next = { ...config, speech: { provider: 'browser', model: custom.model, baseUrl: '', keyConfigured: false, configured: true, custom } };
  const { ui, e } = await fixture({
    '/api/ai/config': (_options, requests) => requests.filter((request) => request.path === '/api/ai/config').length === 1 ? first : next,
  });
  try {
    e('speech-provider').value = 'browser';
    e('speech-provider').emit('change');
    e('settings-form').emit('submit');
    await settle();
    e('speech-provider').value = 'custom';
    e('speech-provider').emit('change');
    assert.equal(e('speech-base-url').value, custom.baseUrl);
    assert.equal(e('speech-model').value, custom.model);
    assert.equal(e('speech-key-status').textContent, t('ai.keyConfigured'));
    assert.equal(e('speech-api-key').value, '');
  } finally { ui.destroy(); }
});

test('current endpoint credentials and root never prefill isolated custom transcription', async () => {
  const custom = { model: 'whisper-1', baseUrl: '', keyConfigured: false, configured: false };
  const current = { ...config, speech: { provider: 'current', model: 'current-model', baseUrl: config.baseUrl, keyConfigured: true, configured: true, custom } };
  const { ui, e } = await fixture({ '/api/ai/config': current });
  try {
    e('speech-provider').value = 'custom';
    e('speech-provider').emit('change');
    assert.equal(e('speech-base-url').value, '');
    assert.equal(e('speech-model').value, 'whisper-1');
    assert.equal(e('speech-key-status').textContent, t('ai.keyMissing'));
    assert.equal(e('speech-api-key').placeholder, t('ai.keyEmpty'));
  } finally { ui.destroy(); }
});

test('unsaved custom transcription endpoint and model drafts survive mode switching without retaining keys', async () => {
  const custom = { model: 'stored-custom-model', baseUrl: 'https://stored-asr.test/v1', keyConfigured: false, configured: false };
  const current = { ...config, speech: { provider: 'current', model: 'current-model', baseUrl: config.baseUrl, keyConfigured: true, configured: true, custom } };
  const { ui, e } = await fixture({ '/api/ai/config': current });
  try {
    e('speech-provider').value = 'custom';
    e('speech-provider').emit('change');
    e('speech-model').value = 'unsaved-custom-model';
    e('speech-base-url').value = 'https://draft-asr.test/v1';
    e('speech-api-key').value = 'temporary-test-key';
    e('speech-provider').value = 'current';
    e('speech-provider').emit('change');
    assert.equal(e('speech-model').value, 'current-model');
    e('speech-provider').value = 'browser';
    e('speech-provider').emit('change');
    e('speech-provider').value = 'custom';
    e('speech-provider').emit('change');
    assert.equal(e('speech-model').value, 'unsaved-custom-model');
    assert.equal(e('speech-base-url').value, 'https://draft-asr.test/v1');
    assert.equal(e('speech-api-key').value, '');
  } finally { ui.destroy(); }
});

test('brief and watch tabs participate in selection and keyboard navigation', async () => {
  const { ui, e } = await fixture();
  try {
    e('tab-intelligence').emit('click');
    assert.equal(e('tab-intelligence').getAttribute('aria-selected'), 'true');
    assert.equal(e('intelligence-panel').hidden, false);
    assert.equal(e('conversation-panel').hidden, true);
    e('tab-intelligence').emit('keydown', { key: 'ArrowRight' });
    assert.equal(e('tab-watch').getAttribute('aria-selected'), 'true');
    e('tab-watch').emit('keydown', { key: 'End' });
    assert.equal(e('tab-settings').getAttribute('aria-selected'), 'true');
  } finally { ui.destroy(); }
});

test('workspace evidence, map confirmation and undo are wired through the assistant', async () => {
  const actions = [];
  const events = [];
  const restored = [];
  const snapshot = { bounds: { west: 0, south: 0, east: 10, north: 10 }, generatedAt: 1000, layers: [] };
  let round = 0;
  const f = await fixture({ '/api/ai/chat': () => ++round === 1
    ? { text: '', toolCalls: [{ id: 'style', name: 'set_visual_style', arguments: { style: 'noir' } }] }
    : { text: 'Done', toolCalls: [] } }, {}, {
    runAction: async (name) => { actions.push(name); return { ok: true }; },
    workspace: { getSnapshot: () => snapshot, getViewSnapshot: () => ({ ...snapshot, scope: 'viewport', viewport: { available: true, width: 1000, height: 700 } }), captureState: () => ({ style: 'normal' }), restoreState: async (saved) => { restored.push(saved); } },
  });
  try {
    f.ui.subscribe((event) => events.push(event));
    const reply = f.ui.sendText('Change style');
    await settle();
    assert.equal(f.e('action-review').hidden, false);
    assert.equal(actions.includes('set_visual_style'), false);
    const request = JSON.parse(f.requests.find((r) => r.path === '/api/ai/chat').options.body);
    assert.equal(request.context.intelligence.scope, 'viewport-loaded-data-only');
    assert.deepEqual(request.context.intelligence.bounds, snapshot.bounds);
    assert.equal(events.at(-1).waiting, true);
    f.byId('intel-action-confirm').emit('click');
    assert.equal(await reply, 'Done');
    assert.equal(actions.filter((name) => name === 'set_visual_style').length, 1);
    assert.equal(events.filter((event) => event.type === 'confirmation').at(-1).waiting, false);
    assert.equal(f.e('undo').disabled, false);
    f.e('undo').emit('click');
    await settle();
    assert.deepEqual(restored, [{ style: 'normal' }]);
    assert.equal(f.e('undo').disabled, true);
  } finally { f.ui.destroy(); }
});

test('planned route grades survive a coordinate-only LLM drawing through confirmation', async () => {
  const actions = [];
  const terrain = {grid: {rows: 3, cols: 3,
    points: Array.from({length: 9}, (_, i) => ({lon: -97 + i % 3 * 0.001, lat: 30 + Math.floor(i / 3) * 0.001})),
    values: [0, 8, 20, 5, 20, 50, 10, 25, 60]}};
  const f = await fixture({}, {}, {runAction: async (name, args) => {actions.push({name, args}); return {ok: true};},
    workspace: {analyzeTerrain: async () => terrain, drawTerrainAnalysis: async () => ({}), getSnapshot: () => ({}),
      getViewSnapshot: () => ({}), captureState: () => ({}), restoreState: async () => true}});
  try {
    const planned = await f.ui.runMapAction('plan_terrain_route', {start: {latitude: 30, longitude: -97}, end: {latitude: 30.002, longitude: -96.998}});
    assert.equal(planned.ok, true);
    const drawing = f.ui.runMapAction('annotate_map', {annotations: [{type: 'route', label: 'test', points: planned.points.map(({latitude, longitude}) => ({latitude, longitude}))}]});
    await settle();
    assert.equal(actions.length, 0, 'drawing still requires confirmation');
    f.byId('intel-action-confirm').emit('click');
    assert.equal((await drawing).ok, true);
    assert.deepEqual(actions[0].args.annotations[0].points, planned.points);
    assert.equal(actions[0].args.annotations[0].source, 'terrain-route');
    const section = f.byId('ai-intelligence-panel').children.find((node) => node.id === 'ai-terrain-analysis');
    const legend = section.children.find((node) => node.className === 'terrain-grade-legend');
    assert.equal(legend.hidden, false);
    assert.equal(legend.children.filter((node) => node.className === 'terrain-grade-item').length, 5);
  } finally {f.ui.destroy();}
});

test('closing a pending action cancels it without changing the map', async () => {
  const actions = [];
  const f = await fixture({ '/api/ai/chat': { text: '', toolCalls: [{ id: 'style', name: 'set_visual_style', arguments: { style: 'noir' } }] } }, {}, {
    runAction: async (name) => { actions.push(name); return { ok: true }; },
    workspace: { getSnapshot: () => ({}), captureState: () => ({}), restoreState: async () => {} },
  });
  try {
    const reply = f.ui.sendText('Change style');
    const rejected = assert.rejects(reply, { code: 'LLM_CANCELLED' });
    await settle();
    f.ui.close();
    await rejected;
    assert.equal(actions.includes('set_visual_style'), false);
    assert.equal(f.e('action-review').hidden, true);
  } finally { f.ui.destroy(); }
});

test('three-second auto confirmation resumes the model reply and preserves undo', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const actions = [];
  const events = [];
  const restored = [];
  let round = 0;
  const f = await fixture({ '/api/ai/chat': () => ++round === 1
    ? { text: '', toolCalls: [{ id: 'style', name: 'set_visual_style', arguments: { style: 'noir' } }] }
    : { text: 'Done', toolCalls: [] } }, {}, {
    runAction: async (name) => { actions.push(name); return { ok: true }; },
    workspace: { getSnapshot: () => ({}), captureState: () => ({ style: 'normal' }), restoreState: async (saved) => { restored.push(saved); } },
  });
  try {
    f.ui.subscribe((event) => events.push(event));
    const reply = f.ui.sendText('Change style');
    await settle();
    assert.equal(f.byId('intel-action-countdown').textContent, t('intel.autoConfirm', { seconds: 3 }));
    context.mock.timers.tick(2000);
    await settle();
    assert.equal(f.byId('intel-action-countdown').textContent, t('intel.autoConfirm', { seconds: 1 }));
    assert.equal(actions.includes('set_visual_style'), false);
    assert.deepEqual(events.filter((event) => event.type === 'confirmation').map((event) => event.waiting), [true]);
    context.mock.timers.tick(999);
    await settle();
    assert.equal(actions.includes('set_visual_style'), false);
    context.mock.timers.tick(1);
    assert.equal(await reply, 'Done');
    assert.equal(actions.filter((name) => name === 'set_visual_style').length, 1);
    assert.equal(round, 2);
    assert.deepEqual(events.filter((event) => event.type === 'confirmation').map((event) => event.waiting), [true, false]);
    f.byId('intel-action-undo').emit('click');
    await settle();
    assert.deepEqual(restored, [{ style: 'normal' }]);
  } finally { f.ui.destroy(); }
});

test('closing assistant during countdown prevents later automatic map execution', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const actions = [];
  const f = await fixture({}, {}, {
    runAction: async (name) => { actions.push(name); return { ok: true }; },
    workspace: { getSnapshot: () => ({}), captureState: () => ({}), restoreState: async () => {} },
  });
  try {
    const waiting = f.ui.runMapAction('zoom_to_globe', {});
    context.mock.timers.tick(1000);
    f.ui.close();
    assert.equal((await waiting).cancelled, true);
    context.mock.timers.tick(10000);
    await settle();
    assert.deepEqual(actions, []);
    assert.equal(f.e('action-review').hidden, true);
  } finally { f.ui.destroy(); }
});

test('undo cancels an in-flight answer based on the pre-undo view', async () => {
  let round = 0;
  let restored = false;
  const f = await fixture({ '/api/ai/chat': ({ signal }) => ++round === 1
    ? { text: '', toolCalls: [{ id: 'style', name: 'set_visual_style', arguments: { style: 'noir' } }] }
    : new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) }, {}, {
    workspace: { getSnapshot: () => ({}), captureState: () => ({}), restoreState: async () => { restored = true; } },
  });
  try {
    const reply = f.ui.sendText('Change style');
    const rejected = assert.rejects(reply, { code: 'LLM_CANCELLED' });
    await settle();
    f.byId('intel-action-confirm').emit('click');
    await settle();
    assert.equal(round, 2);
    f.byId('intel-action-undo').emit('click');
    await settle();
    assert.equal(f.requests.filter((r) => r.path === '/api/ai/chat').at(-1).options.signal.aborted, true);
    await rejected;
    assert.equal(restored, true);
  } finally { f.ui.destroy(); }
});

test('assistant forwards read-only briefing intent without changing normal chat', async () => {
  const f = await fixture({ '/api/ai/chat': { text: 'Brief', toolCalls: [] } });
  try {
    await f.ui.sendText('Summarize visible evidence', { intent: 'brief' });
    const body = JSON.parse(f.requests.find((r) => r.path === '/api/ai/chat').options.body);
    assert.equal(body.intent, 'brief');
  } finally { f.ui.destroy(); }
});
