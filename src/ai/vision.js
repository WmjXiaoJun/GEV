const failure = (code) => ({ ok: false, available: false, code });
const MAX_IMAGE_CHARS = 7_000_000;
const MAX_AGE_MS = 60_000;
const TASKS = new Set(['detect', 'obb']);

function validResult(payload) {
  const image = payload?.image;
  if (payload?.ok !== true || typeof payload.model !== 'string' || payload.model.length > 100
    || !TASKS.has(payload.task) || !image || ![image.width, image.height].every((n) => Number.isInteger(n) && n > 0 && n <= 4096)
    || !Array.isArray(payload.supportedClasses) || payload.supportedClasses.length > 100
    || !payload.supportedClasses.every((name) => typeof name === 'string' && name.length < 80)
    || !Array.isArray(payload.detections) || payload.detections.length > 300) return false;
  return payload.detections.every((item) => {
    const b = item?.box;
    return typeof item?.class === 'string' && item.class.length < 80 && payload.supportedClasses.includes(item.class)
      && Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1
      && b && [b.x, b.y, b.width, b.height].every(Number.isFinite)
      && b.x >= 0 && b.y >= 0 && b.width > 0 && b.height > 0
      && b.x + b.width <= image.width + 0.1 && b.y + b.height <= image.height + 0.1
      && (item.polygon === undefined || (Array.isArray(item.polygon) && item.polygon.length === 4
        && item.polygon.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)
          && p[0] >= 0 && p[1] >= 0 && p[0] <= image.width && p[1] <= image.height)));
  });
}

export async function detectViewportImage(image, {
  fetchImpl = globalThis.fetch?.bind(globalThis), signal, confidence = 0.25, task = 'obb', timeoutMs = 35000,
} = {}) {
  if (typeof image !== 'string' || image.length > MAX_IMAGE_CHARS
    || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)
    || !Number.isFinite(confidence) || confidence < 0.05 || confidence > 0.95 || !TASKS.has(task)) return failure('VISION_INVALID_REQUEST');
  if (signal?.aborted) return failure('VISION_CANCELLED');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, timeoutMs);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const response = await fetchImpl('/api/vision/detect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, confidence, task }), signal: controller.signal,
    });
    const payload = await response.json();
    if (signal?.aborted || controller.signal.aborted) return failure(signal?.aborted ? 'VISION_CANCELLED' : 'VISION_TIMEOUT');
    if (!response.ok) return failure(typeof payload?.code === 'string' && /^VISION_[A-Z_]{1,40}$/.test(payload.code) ? payload.code : 'VISION_UNAVAILABLE');
    if (!validResult(payload) || payload.task !== task) return failure('VISION_INVALID_RESPONSE');
    return { ok: true, available: true, model: payload.model, task, image: { ...payload.image },
      supportedClasses: [...payload.supportedClasses], truncated: payload.truncated === true,
      detections: payload.detections.map(({ class: name, confidence: score, box, polygon }) => ({
        class: name, confidence: score, box: { x: box.x, y: box.y, width: box.width, height: box.height },
        ...(polygon ? { polygon: polygon.map((p) => [...p]) } : {}),
      })),
    };
  } catch {
    return failure(signal?.aborted ? 'VISION_CANCELLED' : controller.signal.aborted ? 'VISION_TIMEOUT' : 'VISION_CONNECTION_ERROR');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export function summarizeVision(result) {
  if (!result?.available) return failure(result?.code || 'VISION_UNAVAILABLE');
  const detections = result.detections;
  const counts = new Map();
  let confidenceTotal = 0;
  let highConfidenceCount = 0;
  for (const item of detections) {
    counts.set(item.class, (counts.get(item.class) || 0) + 1);
    confidenceTotal += item.confidence;
    if (item.confidence >= 0.7) highConfidenceCount += 1;
  }
  return {
    ok: true, available: true, scope: 'viewport-image-only', model: result.model, task: result.task,
    count: detections.length, countIsLowerBound: result.truncated === true, breakdown: Object.fromEntries(counts),
    averageConfidence: detections.length ? Number((confidenceTotal / detections.length).toFixed(4)) : 0,
    highConfidenceCount,
    supportedClasses: [...result.supportedClasses], absenceIsEvidence: false,
    detections: detections.slice(0, 12).map((item, i) => ({ number: i + 1, class: item.class, confidence: item.confidence })),
    omittedCount: Math.max(0, detections.length - 12),
    limitations: 'The bundled aerial OBB model has no building class and does not provide building footprints. Pretrained classes do not include airport boundaries or runway segmentation. No detection does not prove absence. Satellite scale, map symbols and oblique views can cause false positives or misses. Pixel boxes are not geographic boundaries; do not invent map coordinates.',
  };
}

export function createViewportVision({ capture, getViewKey = () => null, fetchImpl, onChange = () => {}, now = Date.now } = {}) {
  let active = null;
  let last = null;
  let destroyed = false;
  const cancel = () => { active?.abort(); active = null; };
  const getContext = () => {
    if (!last) return failure('VISION_NOT_REQUESTED');
    if (last.viewKey !== getViewKey() || now() - last.capturedAt > MAX_AGE_MS) return failure('VISION_VIEW_CHANGED');
    return { ...last.summary, capturedAt: new Date(last.capturedAt).toISOString() };
  };
  const run = async (args = {}, { signal } = {}) => {
    if (destroyed || signal?.aborted) return failure('VISION_CANCELLED');
    if (active) return failure('VISION_BUSY');
    const controller = new AbortController();
    active = controller;
    last = null;
    const current = () => !destroyed && active === controller && !controller.signal.aborted;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    onChange({ status: 'running' });
    try {
      const frame = await capture?.({ signal: controller.signal });
      if (!current()) return failure('VISION_CANCELLED');
      if (!frame?.image || !frame.viewKey) {
        onChange({ status: 'error', error: 'VISION_CAPTURE_UNAVAILABLE' });
        return failure('VISION_CAPTURE_UNAVAILABLE');
      }
      const result = await detectViewportImage(frame.image, { ...args, fetchImpl, signal: controller.signal });
      if (!current()) return failure('VISION_CANCELLED');
      if (!result.available) {
        onChange({ status: 'error', error: result.code });
        return result;
      }
      const stale = frame.viewKey !== getViewKey() || now() - frame.capturedAt > MAX_AGE_MS;
      onChange({ status: 'done', result, image: frame.image, capturedAt: frame.capturedAt, stale });
      if (stale) return failure('VISION_VIEW_CHANGED');
      last = { viewKey: frame.viewKey, capturedAt: frame.capturedAt, summary: summarizeVision(result) };
      return getContext();
    } catch {
      if (!current()) return failure('VISION_CANCELLED');
      onChange({ status: 'error', error: 'VISION_CAPTURE_UNAVAILABLE' });
      return failure('VISION_CAPTURE_UNAVAILABLE');
    } finally {
      signal?.removeEventListener('abort', abort);
      if (active === controller) active = null;
    }
  };
  return Object.freeze({ run, getContext, cancel, clear: () => { cancel(); last = null; }, destroy: () => { cancel(); last = null; destroyed = true; } });
}
