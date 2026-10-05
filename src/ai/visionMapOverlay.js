const MAX_MAP_MARKS = 60;
const CLASS_LABELS = Object.freeze({
  airplane: '飞机', plane: '飞机', car: '汽车', truck: '卡车', bus: '公交车',
  motorcycle: '摩托车', bicycle: '自行车', boat: '船', person: '人员', bird: '鸟类',
  storage_tank: '储罐', 'storage tank': '储罐', airport: '机场', runway: '跑道', road: '道路',
});

function finiteBox(box) {
  return box && [box.x, box.y, box.width, box.height].every(Number.isFinite)
    && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0;
}

function normalize(value, max) {
  return Math.max(0, Math.min(1, value / max));
}

function classKey(value) {
  return String(value || '').trim().toLowerCase().replaceAll('-', '_');
}

function colorFor(value) {
  const key = classKey(value);
  if (['plane', 'airplane', 'boat', 'bird'].includes(key)) return 'cyan';
  if (['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'storage_tank'].includes(key)) return 'amber';
  if (['person'].includes(key)) return 'red';
  if (['airport', 'runway', 'road'].includes(key)) return 'green';
  return 'primary';
}

function labelFor(value, confidence) {
  const raw = String(value || '').trim().slice(0, 50);
  const label = CLASS_LABELS[classKey(raw)] || raw || '目标';
  return `${label} ${Math.round(confidence * 100)}%`;
}

/**
 * Convert bounded local-vision boxes into annotation-engine screen anchors.
 * The annotation resolver performs the depth-aware Cesium pick on the current
 * frame, so these marks track the world instead of remaining as screenshot UI.
 * A box is deliberately represented by its center: pixel corners do not carry
 * reliable depth and must not be presented as a geographic footprint.
 */
export function buildVisionAnnotations(result, { maxMarks = MAX_MAP_MARKS } = {}) {
  const width = Number(result?.image?.width);
  const height = Number(result?.image?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return [];
  if (!Array.isArray(result?.detections)) return [];
  const cap = Number.isInteger(maxMarks) ? Math.max(0, Math.min(MAX_MAP_MARKS, maxMarks)) : MAX_MAP_MARKS;
  const marks = [];
  for (const detection of result.detections) {
    if (marks.length >= cap) break;
    const confidence = Number(detection?.confidence);
    if (typeof detection?.class !== 'string' || !detection.class.trim()
      || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 || !finiteBox(detection.box)) continue;
    const centerX = detection.box.x + detection.box.width / 2;
    const centerY = detection.box.y + detection.box.height / 2;
    marks.push({
      type: 'pin', screenX: normalize(centerX, width), screenY: normalize(centerY, height),
      color: colorFor(detection.class), label: labelFor(detection.class, confidence), persist: true,
    });
  }
  return marks;
}

export const VISION_MAP_MARK_LIMIT = MAX_MAP_MARKS;
