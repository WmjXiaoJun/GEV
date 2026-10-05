import sharp from 'sharp';
import { validateLlmBaseUrl } from './providers.js';

export const MAX_BUILDING_IMAGE_BYTES = 7 * 1024 * 1024;
export const MAX_BUILDING_IMAGE_DIMENSION = 16_000;
export const MAX_BUILDING_MODEL_DIMENSION = 1_600;
export const MAX_BUILDING_POLYGONS = 500;
export const MAX_BUILDING_VERTICES = 256;
export const BUILDING_MODEL_TIMEOUT_MS = 120_000;
const TILE_TRIGGER_DIMENSION = 1_280;
const MAX_MODEL_TILES = 4;
const TILE_CONCURRENCY = 2;

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const OPENAI_PROVIDERS = new Set(['openai', 'deepseek', 'qwen', 'moonshot', 'ollama', 'custom']);
const MEDIA_TYPES = new Set(['png', 'jpeg', 'jpg', 'webp']);
const fail = (code, message = code) => Object.assign(new Error(message), { code });
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const BUILDING_POLYGON_PROMPT = [
  '请从这张遥感影像中识别可见的独立建筑屋顶，并输出建筑轮廓多边形。',
  '只输出一个严格 JSON 对象，不要 Markdown、解释、注释或额外字段。',
  '格式必须是：{"polygons":[{"points":[[x,y],[x,y],[x,y]],"confidence":0.0}],"truncated":false}',
  'points 是按顺时针或逆时针排列的闭合前多边形顶点，坐标按整张图片归一化到 0..1000。',
  '每个多边形至少 3 个、最多 256 个顶点；confidence 为 0..1 的数字，无法估计时使用 null。',
  '只标出影像中有明确屋顶边界的建筑，不要把道路、车辆、桥梁、运动场、树木或阴影当作建筑。',
  '坐标序列遵循 LPM-inspired 约定：建筑按距离图像左上角（top-left）排序，每个建筑从最靠近左上角的顶点开始按顺时针（clockwise）排列。',
  '下方的 YOLO-seg 候选并不完整。请以它们为参考修正边界，并独立检查整张影像，补充候选中漏检但屋顶边界清晰的建筑。不要输出道路、车辆、桥梁、运动场、树木或阴影。',
  'YOLO-seg candidates are non-exhaustive. Refine their outlines and independently recover clearly visible missed roofs.',
].join('\n');

function imageBytes(image) {
  if (Buffer.isBuffer(image)) return image;
  if (image instanceof Uint8Array) return Buffer.from(image);
  if (typeof image !== 'string') throw fail('BUILDINGS_INVALID_IMAGE', 'Invalid building image.');
  const match = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(image);
  if (!match || match[2].length % 4 !== 0) throw fail('BUILDINGS_INVALID_IMAGE', 'Invalid building image.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.toString('base64') !== match[2]) throw fail('BUILDINGS_INVALID_IMAGE', 'Invalid building image.');
  return bytes;
}

async function prepareImage(image) {
  const bytes = imageBytes(image);
  if (bytes.length > MAX_BUILDING_IMAGE_BYTES) throw fail('BUILDINGS_INVALID_IMAGE', 'Building image is too large.');
  let metadata;
  try { metadata = await sharp(bytes).metadata(); } catch { throw fail('BUILDINGS_INVALID_IMAGE', 'Invalid building image.'); }
  const width = Number(metadata.width); const height = Number(metadata.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > MAX_BUILDING_IMAGE_DIMENSION || height > MAX_BUILDING_IMAGE_DIMENSION
    || !MEDIA_TYPES.has(metadata.format === 'jpeg' ? 'jpeg' : metadata.format)) {
    throw fail('BUILDINGS_INVALID_IMAGE', 'Invalid building image dimensions.');
  }
  let encoded = bytes;
  let mime = metadata.format === 'png' ? 'image/png' : metadata.format === 'webp' ? 'image/webp' : 'image/jpeg';
  if (Math.max(width, height) > MAX_BUILDING_MODEL_DIMENSION) {
    try {
      encoded = await sharp(bytes).resize({ width: MAX_BUILDING_MODEL_DIMENSION, height: MAX_BUILDING_MODEL_DIMENSION,
        fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
      mime = 'image/jpeg';
    } catch { throw fail('BUILDINGS_INVALID_IMAGE', 'Unable to process building image.'); }
  }
  return { bytes: encoded, mime, width, height, format: metadata.format, dataUrl: `data:${mime};base64,${encoded.toString('base64')}` };
}

function checkedConfig(config) {
  if (!isRecord(config) || typeof config.provider !== 'string' || typeof config.model !== 'string'
    || typeof config.baseUrl !== 'string' || typeof config.apiKey !== 'string') {
    throw fail('BUILDINGS_NOT_CONFIGURED', 'Building model is not configured.');
  }
  const provider = config.provider;
  if (!OPENAI_PROVIDERS.has(provider) && provider !== 'anthropic' && provider !== 'gemini') {
    throw fail('BUILDINGS_NOT_CONFIGURED', 'Building model is not configured.');
  }
  let baseUrl;
  try { baseUrl = validateLlmBaseUrl(config.baseUrl); } catch { throw fail('BUILDINGS_NOT_CONFIGURED', 'Building model is not configured.'); }
  if (!baseUrl || !config.model.trim() || config.model.length > 256 || /[\u0000-\u001f\u007f]/.test(config.model)
    || config.apiKey.length > 2048 || /[\u0000-\u001f\u007f]/.test(config.apiKey)
    || (!config.apiKey.trim() && provider !== 'ollama')) {
    throw fail('BUILDINGS_NOT_CONFIGURED', 'Building model is not configured.');
  }
  return { provider, model: config.model.trim(), baseUrl, apiKey: config.apiKey.trim() };
}

function normalizeCandidates(candidates, width, height) {
  if (!Array.isArray(candidates)) return [];
  return candidates.slice(0, MAX_BUILDING_POLYGONS).flatMap((item) => {
    if (!isRecord(item) || !Array.isArray(item.points) || item.points.length < 3) return [];
    const points = item.points.flatMap((point) => {
      if (!Array.isArray(point) || point.length !== 2) return [];
      const x = Number(point[0]); const y = Number(point[1]);
      return Number.isFinite(x) && Number.isFinite(y)
        ? [[Math.max(0, Math.min(width, x)) * 1000 / width, Math.max(0, Math.min(height, y)) * 1000 / height]] : [];
    });
    if (points.length < 3) return [];
    return points.length <= MAX_BUILDING_VERTICES ? [{ points: canonicalizeRing(points),
      confidence: Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : null }] : [];
  });
}

// LPM uses a canonical sequence: start nearest the image top-left and then
// walk clockwise. In image coordinates (y grows down), clockwise has positive
// shoelace area.
function canonicalizeRing(points) {
  if (!Array.isArray(points) || points.length < 3) return points;
  const start = points.reduce((best, point, index) => {
    if (best < 0) return index;
    const score = point[0] + point[1];
    const bestScore = points[best][0] + points[best][1];
    return score < bestScore || (score === bestScore && (point[1] < points[best][1]
      || (point[1] === points[best][1] && point[0] < points[best][0]))) ? index : best;
  }, -1);
  const rotated = [...points.slice(start), ...points.slice(0, start)];
  const area2 = rotated.reduce((sum, point, index) => {
    const next = rotated[(index + 1) % rotated.length];
    return sum + point[0] * next[1] - point[1] * next[0];
  }, 0);
  const ordered = area2 >= 0 ? rotated : [rotated[0], ...rotated.slice(1).reverse()];
  return ordered.map((point) => [...point]);
}

function promptForCandidates(candidates, width, height) {
  const normalized = normalizeCandidates(candidates, width, height);
  return `${BUILDING_POLYGON_PROMPT}\nYOLO-seg candidates (normalized 0..1000): ${JSON.stringify(normalized)}`;
}

function makeRequest(config, image, prompt = BUILDING_POLYGON_PROMPT) {
  const { provider, model, baseUrl, apiKey } = config;
  if (provider === 'anthropic') {
    return { url: `${baseUrl}/messages`, headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: {
      model, max_tokens: 12_000, temperature: 0, system: prompt,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt },
        { type: 'image', source: { type: 'base64', media_type: image.mime, data: image.bytes.toString('base64') } }] }],
    } };
  }
  if (provider === 'gemini') {
    const modelId = model.replace(/^models\//, '');
    return { url: `${baseUrl}/models/${encodeURIComponent(modelId)}:generateContent`, headers: { 'x-goog-api-key': apiKey }, body: {
      systemInstruction: { parts: [{ text: prompt }] },
      contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: image.mime, data: image.bytes.toString('base64') } }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 12_000 },
    } };
  }
  return { url: `${baseUrl}/chat/completions`, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, body: {
    model, temperature: 0, max_tokens: 12_000, response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: image.dataUrl, detail: 'high' } }] }],
  } };
}

function responseText(payload, provider) {
  if (provider === 'anthropic') {
    if (!Array.isArray(payload?.content)) throw fail('BUILDINGS_INVALID_RESPONSE', 'Invalid building model response.');
    return payload.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  }
  if (provider === 'gemini') {
    const parts = payload?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) throw fail('BUILDINGS_INVALID_RESPONSE', 'Invalid building model response.');
    return parts.filter((part) => typeof part?.text === 'string' && !part.thought).map((part) => part.text).join('\n');
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((part) => typeof part?.text === 'string').map((part) => part.text).join('\n');
  throw fail('BUILDINGS_INVALID_RESPONSE', 'Invalid building model response.');
}

function parseJsonText(text) {
  if (typeof text !== 'string' || !text.trim()) throw fail('BUILDINGS_INVALID_RESPONSE', 'Invalid building model response.');
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let value;
  try { value = JSON.parse(trimmed); } catch {
    const start = trimmed.indexOf('{'); const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) throw fail('BUILDINGS_INVALID_RESPONSE', 'Invalid building model response.');
    try { value = JSON.parse(trimmed.slice(start, end + 1)); } catch { throw fail('BUILDINGS_INVALID_RESPONSE', 'Invalid building model response.'); }
  }
  if (!isRecord(value) || !Array.isArray(value.polygons) || value.polygons.length > MAX_BUILDING_POLYGONS
    || (value.truncated !== undefined && typeof value.truncated !== 'boolean')) throw fail('BUILDINGS_INVALID_RESPONSE', 'Invalid building model response.');
  const polygons = [];
  for (const item of value.polygons) {
    if (!isRecord(item) || !Array.isArray(item.points) || item.points.length < 3 || item.points.length > MAX_BUILDING_VERTICES
      || (item.confidence !== null && !(typeof item.confidence === 'number' && Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1))) {
      throw fail('BUILDINGS_INVALID_RESPONSE', 'Invalid building model response.');
    }
    const points = item.points.map((point) => {
      if (!Array.isArray(point) || point.length !== 2 || !point.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1000)) {
        throw fail('BUILDINGS_INVALID_RESPONSE', 'Invalid building model response.');
      }
      return point;
    });
    polygons.push({ points, confidence: item.confidence });
  }
  return { polygons, truncated: value.truncated === true };
}

async function readResponse(response, signal) {
  if (!response?.ok || !response.body) throw fail('BUILDINGS_UPSTREAM_ERROR', 'Building model request failed.');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > MAX_RESPONSE_BYTES) throw fail('BUILDINGS_INVALID_RESPONSE', 'Building model response is too large.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk])))); }
  catch { throw fail('BUILDINGS_INVALID_RESPONSE', 'Invalid building model response.'); }
}

export async function requestBuildingPolygons({ image, config, candidates, fetchImpl = fetch, signal, timeoutMs = BUILDING_MODEL_TIMEOUT_MS } = {}) {
  const resolved = checkedConfig(config);
  const prepared = await prepareImage(image);
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(fail('BUILDINGS_TIMEOUT')), timeoutMs); timer.unref?.();
  const combined = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
  try {
    combined.throwIfAborted();
    const request = makeRequest(resolved, prepared, promptForCandidates(candidates, prepared.width, prepared.height));
    const response = await fetchImpl(request.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...request.headers }, body: JSON.stringify(request.body), signal: combined, redirect: 'error' });
    const payload = await readResponse(response, combined);
    const parsed = parseJsonText(responseText(payload, resolved.provider));
    const polygons = parsed.polygons.map((item) => ({ ...item,
      points: canonicalizeRing(item.points.map(([x, y]) => [x * prepared.width / 1000, y * prepared.height / 1000])) }));
    return { ok: true, task: 'buildings', model: resolved.model, image: { width: prepared.width, height: prepared.height }, polygons, truncated: parsed.truncated };
  } catch (error) {
    if (signal?.aborted) throw fail('BUILDINGS_CANCELLED', 'Building recognition was cancelled.');
    if (timeoutController.signal.aborted) throw fail('BUILDINGS_TIMEOUT', 'Building recognition timed out.');
    if (['BUILDINGS_INVALID_RESPONSE', 'BUILDINGS_UPSTREAM_ERROR'].includes(error?.code)) throw error;
    throw fail('BUILDINGS_CONNECTION_ERROR', 'Unable to connect to the building model.');
  } finally { clearTimeout(timer); }
}
