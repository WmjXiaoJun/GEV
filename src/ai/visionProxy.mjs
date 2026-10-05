import { admitKeySetupRequest } from '../keySetupCore.mjs';
import { resolveLlmConfig } from './providers.js';
import { MAX_BUILDING_IMAGE_BYTES, MAX_BUILDING_POLYGONS, requestBuildingPolygons } from './buildingModel.mjs';

const BASE_URL = 'http://127.0.0.1:8766';
export const MAX_VISION_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_VISION_BODY_BYTES = Math.ceil(MAX_VISION_IMAGE_BYTES / 3) * 4 + 1024;
export const MAX_VISION_RESPONSE_BYTES = 512 * 1024;
const TIMEOUT_MS = 30_000;
const BUILDINGS_TIMEOUT_MS = 125_000;
// Include bounded 500 x 256 numeric candidate rings as well as the image.
const MAX_BUILDING_BODY_BYTES = Math.ceil(MAX_BUILDING_IMAGE_BYTES / 3) * 4 + 4 * 1024 * 1024;
const MAX_DIMENSION = 4096;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const CLASS_NAME = /^[A-Za-z0-9][A-Za-z0-9 _/-]{0,79}$/;
const BUILDING_CLASSES = new Set(['building', 'buildings', 'building footprint', 'building-footprint']);
const FAILURES = Object.freeze({
  VISION_INVALID_REQUEST: [400, '图片或识别参数无效'],
  VISION_REQUEST_TOO_LARGE: [413, '图片过大，最多允许 5 MB'],
  VISION_LOCAL_ONLY: [403, '图片识别仅允许从本机应用访问'],
  VISION_CONTENT_TYPE: [415, '图片识别请求必须使用 JSON'],
  VISION_RATE_LIMITED: [429, '识别请求过于频繁，请稍后重试'],
  VISION_BUSY: [429, '正在识别其他图片，请稍后重试'],
  VISION_TIMEOUT: [504, '本地图片识别超时，请重试'],
  VISION_CONNECTION_ERROR: [503, '无法连接本地 YOLO 服务，请检查服务是否已启动'],
  VISION_UNAVAILABLE: [503, '本地 YOLO 模型尚未就绪'],
  VISION_INFERENCE_FAILED: [503, '本地图片识别失败，请重试'],
  VISION_UPSTREAM_ERROR: [502, '本地图片识别服务返回错误'],
  VISION_INVALID_RESPONSE: [502, '本地图片识别结果无效'],
  VISION_CANCELLED: [499, '图片识别已取消'],
});
const fail = (code) => Object.assign(new Error(code), { code });
const BUILDING_FAILURE_MESSAGES = Object.freeze({
  BUILDINGS_INVALID_REQUEST: '\u5efa\u7b51\u8bc6\u522b\u8bf7\u6c42\u65e0\u6548',
  BUILDINGS_REQUEST_TOO_LARGE: '\u5efa\u7b51\u8bc6\u522b\u56fe\u7247\u8fc7\u5927',
  BUILDINGS_LOCAL_ONLY: '\u5efa\u7b51\u8bc6\u522b\u4ec5\u5141\u8bb8\u672c\u5730\u5e94\u7528\u8bbf\u95ee',
  BUILDINGS_CONTENT_TYPE: '\u5efa\u7b51\u8bc6\u522b\u8bf7\u6c42\u5fc5\u987b\u4f7f\u7528 JSON',
  BUILDINGS_RATE_LIMITED: '\u5efa\u7b51\u8bc6\u522b\u8bf7\u6c42\u8fc7\u4e8e\u9891\u7e41',
  BUILDINGS_BUSY: '\u6b63\u5728\u8bc6\u522b\u5176\u4ed6\u5efa\u7b51\u5f71\u50cf',
  BUILDINGS_TIMEOUT: '\u5efa\u7b51\u8bc6\u522b\u8d85\u65f6\uff0c\u8bf7\u91cd\u8bd5',
  BUILDINGS_NOT_CONFIGURED: '\u672a\u914d\u7f6e\u5efa\u7b51\u8f6e\u5ed3\u8bc6\u522b\u6a21\u578b\uff0c\u8bf7\u5728\u6a21\u578b\u8bbe\u7f6e\u4e2d\u914d\u7f6e\u652f\u6301\u56fe\u50cf\u7684\u6a21\u578b',
  BUILDINGS_INVALID_IMAGE: '\u5efa\u7b51\u8bc6\u522b\u56fe\u7247\u65e0\u6548',
  BUILDINGS_INVALID_RESPONSE: '\u5efa\u7b51\u6a21\u578b\u8fd4\u56de\u7684\u8f6e\u5ed3\u65e0\u6548',
  BUILDINGS_CONNECTION_ERROR: '\u65e0\u6cd5\u8fde\u63a5\u5efa\u7b51\u6a21\u578b\u670d\u52a1',
  BUILDINGS_UPSTREAM_ERROR: '\u5efa\u7b51\u6a21\u578b\u670d\u52a1\u8fd4\u56de\u9519\u8bef',
  BUILDINGS_CANCELLED: '\u5efa\u7b51\u8bc6\u522b\u5df2\u53d6\u6d88',
});
const BUILDING_SEG_FAILURE_MESSAGES = Object.freeze({
  BUILDINGS_SEG_INVALID_REQUEST: '建筑分割请求无效',
  BUILDINGS_SEG_REQUEST_TOO_LARGE: '建筑分割图片过大',
  BUILDINGS_SEG_LOCAL_ONLY: '建筑分割仅允许本地应用访问',
  BUILDINGS_SEG_CONTENT_TYPE: '建筑分割请求必须使用 JSON',
  BUILDINGS_SEG_RATE_LIMITED: '建筑分割请求过于频繁',
  BUILDINGS_SEG_BUSY: '正在分割其他建筑影像',
  BUILDINGS_SEG_TIMEOUT: '建筑分割超时，请重试',
  BUILDINGS_SEG_CONNECTION_ERROR: '无法连接建筑分割服务',
  BUILDINGS_SEG_UPSTREAM_ERROR: '建筑分割服务返回错误',
  BUILDINGS_SEG_INVALID_RESPONSE: '建筑分割结果无效',
  BUILDINGS_SEG_CANCELLED: '建筑分割已取消',
});
const BUILDING_FAILURE_STATUS = Object.freeze({
  BUILDINGS_INVALID_REQUEST: 400, BUILDINGS_REQUEST_TOO_LARGE: 413, BUILDINGS_LOCAL_ONLY: 403,
  BUILDINGS_CONTENT_TYPE: 415, BUILDINGS_RATE_LIMITED: 429, BUILDINGS_BUSY: 429,
  BUILDINGS_TIMEOUT: 504, BUILDINGS_NOT_CONFIGURED: 503, BUILDINGS_INVALID_IMAGE: 400,
  BUILDINGS_INVALID_RESPONSE: 502, BUILDINGS_CONNECTION_ERROR: 503, BUILDINGS_UPSTREAM_ERROR: 502,
  BUILDINGS_CANCELLED: 499,
});
const BUILDING_SEG_FAILURE_STATUS = Object.freeze({
  BUILDINGS_SEG_INVALID_REQUEST: 400, BUILDINGS_SEG_REQUEST_TOO_LARGE: 413, BUILDINGS_SEG_LOCAL_ONLY: 403,
  BUILDINGS_SEG_CONTENT_TYPE: 415, BUILDINGS_SEG_RATE_LIMITED: 429, BUILDINGS_SEG_BUSY: 429,
  BUILDINGS_SEG_TIMEOUT: 504, BUILDINGS_SEG_CONNECTION_ERROR: 503, BUILDINGS_SEG_UPSTREAM_ERROR: 502,
  BUILDINGS_SEG_INVALID_RESPONSE: 502, BUILDINGS_SEG_CANCELLED: 499,
});
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const numberIn = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const assertResponse = (condition) => { if (!condition) throw fail('VISION_INVALID_RESPONSE'); };

function send(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(payload));
}

function signatureMatches(bytes, type) {
  if (type === 'png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

export function validateVisionImage(body) {
  if (!record(body) || Object.keys(body).some((key) => !['image', 'confidence', 'task'].includes(key))) {
    throw fail('VISION_INVALID_REQUEST');
  }
  if (typeof body.image !== 'string') throw fail('VISION_INVALID_REQUEST');
  if (body.image.length > MAX_VISION_BODY_BYTES - 1024 + 32) throw fail('VISION_REQUEST_TOO_LARGE');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(body.image);
  if (!match || match[2].length % 4 !== 0) throw fail('VISION_INVALID_REQUEST');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_VISION_IMAGE_BYTES) throw fail('VISION_REQUEST_TOO_LARGE');
  if (!bytes.length || bytes.toString('base64') !== match[2] || !signatureMatches(bytes, match[1])) {
    throw fail('VISION_INVALID_REQUEST');
  }
  const confidence = body.confidence === undefined ? 0.25 : body.confidence;
  const task = body.task === undefined ? 'obb' : body.task;
  if (!numberIn(confidence, 0.05, 0.95) || !['detect', 'obb', 'segment', 'buildings-seg'].includes(task)) throw fail('VISION_INVALID_REQUEST');
  return { image: body.image, confidence, task };
}

function sanitizeClasses(value) {
  assertResponse(Array.isArray(value) && value.length <= 300 && value.every((name) => typeof name === 'string' && CLASS_NAME.test(name)));
  return [...new Set(value)];
}

function sanitizeBox(box, image) {
  assertResponse(record(box) && numberIn(box.x, 0, image.width) && numberIn(box.y, 0, image.height)
    && numberIn(box.width, Number.MIN_VALUE, image.width) && numberIn(box.height, Number.MIN_VALUE, image.height)
    && box.x + box.width <= image.width && box.y + box.height <= image.height);
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function sanitizePolygon(polygon, image) {
  assertResponse(Array.isArray(polygon) && polygon.length === 4);
  return polygon.map((point) => {
    assertResponse(Array.isArray(point) && point.length === 2 && numberIn(point[0], 0, image.width) && numberIn(point[1], 0, image.height));
    return [point[0], point[1]];
  });
}

function sanitizeVariablePolygon(polygon, image) {
  assertResponse(Array.isArray(polygon) && polygon.length >= 3 && polygon.length <= 256);
  const points = polygon.map((point) => {
    assertResponse(Array.isArray(point) && point.length === 2 && numberIn(point[0], 0, image.width) && numberIn(point[1], 0, image.height));
    return [point[0], point[1]];
  });
  assertResponse(new Set(points.map((point) => `${point[0]}:${point[1]}`)).size >= 3);
  return points;
}

export function sanitizeVisionResult(payload) {
  assertResponse(record(payload) && typeof payload.model === 'string' && MODEL_NAME.test(payload.model)
    && ['detect', 'obb', 'segment', 'buildings-seg'].includes(payload.task) && record(payload.image));
  const detectionLimit = payload.task === 'buildings-seg' ? MAX_BUILDING_POLYGONS : 300;
  const { width, height } = payload.image;
  assertResponse(Number.isInteger(width) && Number.isInteger(height) && numberIn(width, 1, MAX_DIMENSION)
    && numberIn(height, 1, MAX_DIMENSION));
  const image = { width, height };
  const supportedClasses = sanitizeClasses(payload.supportedClasses);
  assertResponse(payload.truncated === undefined || typeof payload.truncated === 'boolean');
  assertResponse(payload.maxDetections === undefined || payload.maxDetections === detectionLimit);
  assertResponse(Array.isArray(payload.detections) && payload.detections.length <= detectionLimit);
  const detections = payload.detections.map((item) => {
    assertResponse(record(item) && supportedClasses.includes(item.class) && numberIn(item.confidence, 0, 1));
    return { class: item.class, confidence: item.confidence, box: sanitizeBox(item.box, image),
      ...(item.polygon === undefined ? {} : { polygon: ['segment', 'buildings-seg'].includes(payload.task)
        ? sanitizeVariablePolygon(item.polygon, image) : sanitizePolygon(item.polygon, image) }) };
  });
  return { model: payload.model, task: payload.task, image, supportedClasses, detections,
    ...(payload.truncated === undefined ? {} : { truncated: payload.truncated }),
    ...(payload.maxDetections === undefined ? {} : { maxDetections: payload.maxDetections }) };
}

/** Convert local building-seg detections into the building polygon contract. */
export function sanitizeBuildingSegResult(payload) {
  if (record(payload) && payload.ok === true && payload.task === 'buildings-seg') {
    const invalid = () => { throw fail('BUILDINGS_SEG_INVALID_RESPONSE'); };
    if (typeof payload.model !== 'string' || !MODEL_NAME.test(payload.model) || !record(payload.image)) invalid();
    const { width, height } = payload.image;
    if (!Number.isInteger(width) || !Number.isInteger(height) || !numberIn(width, 1, MAX_DIMENSION)
      || !numberIn(height, 1, MAX_DIMENSION) || !Array.isArray(payload.polygons) || payload.polygons.length > MAX_BUILDING_POLYGONS) invalid();
    let polygons;
    try {
      polygons = payload.polygons.map((item) => {
        if (!record(item) || !Array.isArray(item.points) || item.points.length < 3 || item.points.length > 256
          || (item.confidence !== null && !numberIn(item.confidence, 0, 1))) invalid();
        return { points: sanitizeVariablePolygon(item.points, { width, height }), confidence: item.confidence };
      });
    } catch { invalid(); }
    if (payload.truncated !== undefined && typeof payload.truncated !== 'boolean') invalid();
    return { ok: true, task: 'buildings-seg', model: payload.model, image: { width, height }, polygons,
      truncated: payload.truncated === true, segmentationModel: payload.segmentationModel || payload.model,
      detectedCount: polygons.length };
  }
  let result;
  try { result = sanitizeVisionResult(payload); }
  catch (error) { throw fail('BUILDINGS_SEG_INVALID_RESPONSE'); }
  if (result.task !== 'buildings-seg') throw fail('BUILDINGS_SEG_INVALID_RESPONSE');
  const polygons = result.detections
    .filter((item) => BUILDING_CLASSES.has(item.class.trim().toLowerCase()) && Array.isArray(item.polygon))
    .map((item) => ({ points: item.polygon.map((point) => [...point]), confidence: item.confidence }));
  return { ok: true, task: 'buildings-seg', model: result.model, image: result.image, polygons,
    truncated: result.truncated === true, segmentationModel: result.model, detectedCount: polygons.length };
}

function sanitizeHealth(payload) {
  assertResponse(record(payload) && ['ok', 'degraded', 'failed'].includes(payload.status)
    && typeof payload.model === 'string' && MODEL_NAME.test(payload.model));
  const models = Object.fromEntries(['obb', 'detect', 'segment', 'buildings-seg'].filter((task) => payload.models?.[task]).map((task) => {
    const model = payload.models[task];
    assertResponse(record(model) && typeof model.model === 'string' && MODEL_NAME.test(model.model)
      && typeof model.installed === 'boolean' && typeof model.loaded === 'boolean');
    return [task, { model: model.model, installed: model.installed, loaded: model.loaded }];
  }));
  return { status: payload.status, model: payload.model, models,
    ...(typeof payload.version === 'string' && /^\d+\.\d+\.\d+$/.test(payload.version) ? { version: payload.version } : {}),
    ...(typeof payload.device === 'string' && /^(?:cpu|mps|cuda(?::\d+)?)$/.test(payload.device) ? { device: payload.device } : {}),
    ...(payload.supportedClasses === undefined ? {} : { supportedClasses: sanitizeClasses(payload.supportedClasses) }) };
}

function untilAborted(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); })
      .then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function readResponse(response, signal) {
  if (Number(response.headers?.get('content-length')) > MAX_VISION_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw fail('VISION_INVALID_RESPONSE');
  }
  if (!response.body) throw fail('VISION_INVALID_RESPONSE');
  const reader = response.body.getReader();
  let chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await untilAborted(() => reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_VISION_RESPONSE_BYTES) throw fail('VISION_INVALID_RESPONSE');
      chunks = [...chunks, value];
    }
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { throw fail('VISION_INVALID_RESPONSE'); }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

async function requestLocal(path, { body, fetchImpl = fetch, signal, timeoutMs = TIMEOUT_MS } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([deadline, signal]) : deadline;
  try {
    const response = await untilAborted(() => fetchImpl(`${BASE_URL}${path}`, {
      method: body ? 'POST' : 'GET', signal: combined, redirect: 'error',
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    }), combined);
    const payload = await readResponse(response, combined);
    if (!response.ok) {
      const code = payload?.error?.code || payload?.code;
      throw fail(['VISION_INVALID_REQUEST', 'VISION_REQUEST_TOO_LARGE', 'VISION_UNAVAILABLE',
        'VISION_INFERENCE_FAILED', 'VISION_BUSY', 'VISION_TIMEOUT'].includes(code) ? code : 'VISION_UPSTREAM_ERROR');
    }
    return payload;
  } catch (error) {
    if (signal?.aborted) throw fail(signal.reason?.code === 'VISION_TIMEOUT' ? 'VISION_TIMEOUT' : 'VISION_CANCELLED');
    if (deadline.aborted) throw fail('VISION_TIMEOUT');
    if (Object.hasOwn(FAILURES, error?.code)) throw error;
    throw fail('VISION_CONNECTION_ERROR');
  }
}

export async function requestVision(options) {
  return sanitizeVisionResult(await requestLocal('/v1/detect', { ...options, body: validateVisionImage(options.body) }));
}

export function validateBuildingImage(body) {
  if (!record(body) || Object.keys(body).some((key) => !['image', 'confidence', 'candidates'].includes(key))) {
    throw fail('BUILDINGS_INVALID_REQUEST');
  }
  try {
    const { image, confidence } = validateVisionImage({ image: body.image, confidence: body.confidence });
    const candidates = body.candidates === undefined ? undefined : sanitizeBuildingCandidates(body.candidates);
    return { image, confidence, ...(candidates === undefined ? {} : { candidates }) };
  } catch (error) {
    throw fail(error?.code === 'VISION_REQUEST_TOO_LARGE' ? 'BUILDINGS_REQUEST_TOO_LARGE' : 'BUILDINGS_INVALID_REQUEST');
  }
}

export function sanitizeBuildingCandidates(value) {
  if (!Array.isArray(value) || value.length > MAX_BUILDING_POLYGONS) throw fail('BUILDINGS_INVALID_REQUEST');
  return value.map((item) => {
    if (!record(item) || Object.keys(item).some((key) => !['points', 'confidence'].includes(key))
      || !Array.isArray(item.points) || item.points.length < 3 || item.points.length > 256
      || (item.confidence !== undefined && item.confidence !== null && !numberIn(item.confidence, 0, 1))) {
      throw fail('BUILDINGS_INVALID_REQUEST');
    }
    const points = item.points.map((point) => {
      if (!Array.isArray(point) || point.length !== 2 || !numberIn(point[0], 0, MAX_DIMENSION)
        || !numberIn(point[1], 0, MAX_DIMENSION)) throw fail('BUILDINGS_INVALID_REQUEST');
      return [point[0], point[1]];
    });
    return { points, confidence: item.confidence === undefined ? null : item.confidence };
  });
}

export function validateBuildingSegImage(body) {
  if (!record(body) || Object.keys(body).some((key) => !['image', 'confidence', 'task'].includes(key))
    || (body.task !== undefined && body.task !== 'buildings-seg')) {
    throw fail('BUILDINGS_SEG_INVALID_REQUEST');
  }
  try {
    const validated = validateVisionImage({ ...body, task: 'buildings-seg' });
    return validated;
  } catch (error) {
    throw fail(error?.code === 'VISION_REQUEST_TOO_LARGE' ? 'BUILDINGS_SEG_REQUEST_TOO_LARGE' : 'BUILDINGS_SEG_INVALID_REQUEST');
  }
}

export function sanitizeBuildingResult(payload) {
  const invalid = () => { throw fail('BUILDINGS_INVALID_RESPONSE'); };
  if (!record(payload) || payload.ok !== true || payload.task !== 'buildings'
    || typeof payload.model !== 'string' || !payload.model.length || payload.model.length > 120
    || /[\u0000-\u001f\u007f]/.test(payload.model) || !record(payload.image)) invalid();
  const { width, height } = payload.image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || !numberIn(width, 1, MAX_DIMENSION)
    || !numberIn(height, 1, MAX_DIMENSION) || !Array.isArray(payload.polygons) || payload.polygons.length > MAX_BUILDING_POLYGONS
    || (payload.truncated !== undefined && typeof payload.truncated !== 'boolean')) invalid();
  const polygons = payload.polygons.map((item) => {
    if (!record(item) || !Array.isArray(item.points) || item.points.length < 3 || item.points.length > 256
      || (item.confidence !== null && !numberIn(item.confidence, 0, 1))) invalid();
    const points = item.points.map((point) => {
      if (!Array.isArray(point) || point.length !== 2 || !numberIn(point[0], 0, width) || !numberIn(point[1], 0, height)) invalid();
      return [point[0], point[1]];
    });
    return { points, confidence: item.confidence };
  });
  const completion = payload.completion;
  if (completion !== undefined && (!record(completion)
    || !Number.isInteger(completion.totalTiles) || !numberIn(completion.totalTiles, 1, 4)
    || !Number.isInteger(completion.successfulTiles) || !numberIn(completion.successfulTiles, 0, completion.totalTiles)
    || completion.failedTiles !== completion.totalTiles - completion.successfulTiles)) invalid();
  return { ok: true, task: 'buildings', model: payload.model, image: { width, height }, polygons, truncated: payload.truncated === true,
    ...(completion ? { completion: { totalTiles: completion.totalTiles, successfulTiles: completion.successfulTiles, failedTiles: completion.failedTiles } } : {}) };
}

export async function requestBuildings({ body, env = process.env, signal, fetchImpl } = {}) {
  const validated = validateBuildingImage(body);
  let config;
  try { config = resolveLlmConfig(env); } catch { throw fail('BUILDINGS_NOT_CONFIGURED'); }
  if (!config.configured) throw fail('BUILDINGS_NOT_CONFIGURED');
  const result = await requestBuildingPolygons({ image: validated.image, candidates: validated.candidates, config, signal, fetchImpl });
  return sanitizeBuildingResult(result);
}

export async function requestBuildingSegmentation({ body, signal, fetchImpl, timeoutMs = TIMEOUT_MS } = {}) {
  const validated = validateBuildingSegImage(body);
  const result = await requestLocal('/v1/detect', { body: validated, signal, fetchImpl, timeoutMs });
  return sanitizeBuildingSegResult(result);
}

export async function localVisionHealth(options = {}) {
  try { return sanitizeHealth(await requestLocal('/health', { ...options, timeoutMs: options.timeoutMs ?? 3000 })); }
  catch { return { status: 'failed', model: '', models: {} }; }
}

function readRequest(req, signal, maxBytes = MAX_VISION_BODY_BYTES, tooLargeCode = 'VISION_REQUEST_TOO_LARGE') {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onAbort = () => { req.pause(); onError(signal.reason); };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { req.pause(); onError(fail(tooLargeCode)); }
      else chunks = [...chunks, chunk];
    };
    const onEnd = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8'))); }
      catch { reject(fail('VISION_INVALID_REQUEST')); }
    };
    if (Number(req.headers['content-length']) > maxBytes) return onError(fail(tooLargeCode));
    req.on('data', onData).once('end', onEnd).once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function quota(limit, now) {
  let state = { started: now(), count: 0 };
  return () => {
    if (now() - state.started >= 60_000) state = { started: now(), count: 0 };
    if (state.count >= limit) throw fail('VISION_RATE_LIMITED');
    state = { ...state, count: state.count + 1 };
  };
}

export function createVisionHandler({ detect = requestVision, buildings = requestBuildings, buildingsSeg = requestBuildingSegmentation,
  health = localVisionHealth, getEnv = () => process.env,
  rateLimit = 12, healthRateLimit = 60, now = Date.now, timeoutMs = TIMEOUT_MS, buildingTimeoutMs = BUILDINGS_TIMEOUT_MS } = {}) {
  const consume = { '/detect': quota(rateLimit, now), '/buildings': quota(rateLimit, now), '/buildings-seg': quota(rateLimit, now), '/health': quota(healthRateLimit, now) };
  let active = new Set();
  return async (req, res, next = () => send(res, 404, { error: 'Not found' })) => {
    const route = (req.url || '').split('?')[0];
    if (!['/detect', '/buildings', '/buildings-seg', '/health'].includes(route)) return next();
    if (req.method !== (route === '/health' ? 'GET' : 'POST')) return send(res, 405, { error: 'Method not allowed' });
    const admission = admitKeySetupRequest({ method: req.method, remoteAddress: req.socket?.remoteAddress,
      hostHeader: req.headers.host, protocol: req.socket?.encrypted ? 'https:' : 'http:', origin: req.headers.origin,
      contentType: req.headers['content-type'], proxyHeaders: req.headers, env: getEnv() });
    if (!admission.ok) {
      const buildingRoute = route === '/buildings' || route === '/buildings-seg';
      const prefix = route === '/buildings-seg' ? 'BUILDINGS_SEG_' : 'BUILDINGS_';
      const code = buildingRoute
        ? `${prefix}${admission.status === 415 ? 'CONTENT_TYPE' : 'LOCAL_ONLY'}`
        : (admission.status === 415 ? 'VISION_CONTENT_TYPE' : 'VISION_LOCAL_ONLY');
      const message = route === '/buildings-seg' ? BUILDING_SEG_FAILURE_MESSAGES[code]
        : route === '/buildings' ? BUILDING_FAILURE_MESSAGES[code]
        : FAILURES[code]?.[1];
      return send(res, admission.status, { error: message, code });
    }
    if (req.method === 'POST' && String(req.headers['content-type']).split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      const code = route === '/buildings-seg' ? 'BUILDINGS_SEG_CONTENT_TYPE' : route === '/buildings' ? 'BUILDINGS_CONTENT_TYPE' : 'VISION_CONTENT_TYPE';
      const message = route === '/buildings-seg' ? BUILDING_SEG_FAILURE_MESSAGES[code] : route === '/buildings' ? BUILDING_FAILURE_MESSAGES[code] : FAILURES.VISION_CONTENT_TYPE[1];
      return send(res, 415, { error: message, code });
    }
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(fail('VISION_CANCELLED')); };
    const timer = setTimeout(() => controller.abort(fail('VISION_TIMEOUT')), route === '/health'
      ? Math.min(timeoutMs, 3000) : route === '/buildings' ? buildingTimeoutMs : route === '/buildings-seg' ? timeoutMs : timeoutMs);
    timer.unref?.();
    res.once('close', onClose);
    let acquired = false;
    try {
      consume[route]();
      if (active.has(route)) throw fail('VISION_BUSY');
      active = new Set([...active, route]);
      acquired = true;
      if (route === '/health') {
        const status = await untilAborted(() => health({ signal: controller.signal }), controller.signal);
        return send(res, 200, status.status === 'failed' ? { status: 'failed', model: '', models: {} } : sanitizeHealth(status));
      }
      if (route === '/buildings') {
        const body = validateBuildingImage(await readRequest(req, controller.signal, MAX_BUILDING_BODY_BYTES, 'BUILDINGS_REQUEST_TOO_LARGE'));
        const payload = await untilAborted(() => buildings({ body, env: getEnv(), signal: controller.signal }), controller.signal);
        return send(res, 200, sanitizeBuildingResult(payload));
      }
      if (route === '/buildings-seg') {
        const body = validateBuildingSegImage(await readRequest(req, controller.signal, MAX_VISION_BODY_BYTES, 'BUILDINGS_SEG_REQUEST_TOO_LARGE'));
        const payload = await untilAborted(() => buildingsSeg({ body, signal: controller.signal }), controller.signal);
        return send(res, 200, sanitizeBuildingSegResult(payload));
      }
      const body = validateVisionImage(await readRequest(req, controller.signal));
      const payload = await untilAborted(() => detect({ body, signal: controller.signal }), controller.signal);
      return send(res, 200, { ok: true, ...sanitizeVisionResult(payload) });
    } catch (error) {
      if (!req.complete) {
        req.pause();
        res.setHeader('Connection', 'close');
        res.once('finish', () => req.destroy());
      }
      if (route === '/buildings-seg') {
        const candidate = String(error?.code || '').replace(/^VISION_/, 'BUILDINGS_SEG_');
        const code = Object.hasOwn(BUILDING_SEG_FAILURE_MESSAGES, candidate) ? candidate : 'BUILDINGS_SEG_CONNECTION_ERROR';
        return send(res, BUILDING_SEG_FAILURE_STATUS[code], { ok: false, error: BUILDING_SEG_FAILURE_MESSAGES[code], code });
      }
      if (route === '/buildings') {
        const candidate = String(error?.code || '').replace(/^VISION_/, 'BUILDINGS_');
        const code = Object.hasOwn(BUILDING_FAILURE_MESSAGES, candidate) ? candidate : 'BUILDINGS_CONNECTION_ERROR';
        return send(res, BUILDING_FAILURE_STATUS[code], { ok: false, error: BUILDING_FAILURE_MESSAGES[code], code });
      }
      const code = Object.hasOwn(FAILURES, error?.code) ? error.code : 'VISION_CONNECTION_ERROR';
      return send(res, FAILURES[code][0], { error: FAILURES[code][1], code });
    } finally {
      if (acquired) active = new Set([...active].filter((value) => value !== route));
      clearTimeout(timer);
      res.removeListener('close', onClose);
    }
  };
}

export function visionProxy(options) {
  const install = (server) => { server.middlewares.use('/api/vision', createVisionHandler(options)); };
  return { name: 'gev-local-yolo-vision', configureServer: install, configurePreviewServer: install };
}
