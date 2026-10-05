import { getLocale, subscribeLocale, t } from '../i18n.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_OPTIONS = Object.freeze({ task: 'obb', confidence: 0.25 });
const MAX_DETECTIONS = 300;
const ERROR_KEYS = Object.freeze({
  VISION_CAPTURE_UNAVAILABLE: 'capture', VISION_VIEW_CHANGED: 'viewChanged',
  VISION_TIMEOUT: 'timeout', VISION_CANCELLED: 'cancelled',
  VISION_CONNECTION_ERROR: 'unavailable', VISION_UNAVAILABLE: 'unavailable',
  VISION_INVALID_RESPONSE: 'invalidResponse', VISION_IMAGE_TOO_LARGE: 'imageTooLarge',
  VISION_BUSY: 'busy', VISION_INVALID_IMAGE: 'invalidImage',
  VISION_INVALID_REQUEST: 'invalidImage', VISION_REQUEST_TOO_LARGE: 'imageTooLarge',
  VISION_LOCAL_ONLY: 'localOnly', VISION_CONTENT_TYPE: 'invalidImage', VISION_RATE_LIMITED: 'rateLimited',
  VISION_INFERENCE_FAILED: 'generic', VISION_UPSTREAM_ERROR: 'unavailable',
});

function classLabel(value) {
  const label = typeof value === 'string' ? value.slice(0, 100) : '';
  const key = `vision.class.${label.toLowerCase().replaceAll(' ', '-').replaceAll('_', '-')}`;
  const translated = t(key);
  return translated === key ? label || t('vision.unknownClass') : translated;
}

function imageSize(result) {
  const { width, height } = result?.image || {};
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    && width <= 16384 && height <= 16384 ? { width, height } : null;
}

function validImage(image) {
  return typeof image === 'string' && image.length <= 16 * 1024 * 1024
    && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image);
}

function detectionGeometry(detection, size) {
  if (!detection || !Number.isFinite(detection.confidence) || detection.confidence < 0 || detection.confidence > 1) return null;
  const clamp = ([x, y]) => [Math.max(0, Math.min(size.width, x)), Math.max(0, Math.min(size.height, y))];
  const polygon = Array.isArray(detection.polygon) ? detection.polygon.map((point) => (
    Array.isArray(point) ? point : [point?.x, point?.y]
  )) : null;
  if (Array.isArray(polygon) && polygon.length >= 3 && polygon.length <= 32
    && polygon.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) {
    const points = polygon.map(clamp);
    const twiceArea = points.reduce((sum, [x, y], index) => {
      const [nextX, nextY] = points[(index + 1) % points.length];
      return sum + x * nextY - nextX * y;
    }, 0);
    if (Math.abs(twiceArea) > 0.01) return { kind: 'polygon', points };
  }
  const { x, y, width, height } = detection.box || {};
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const [left, top] = clamp([x, y]); const [right, bottom] = clamp([x + width, y + height]);
  return right > left && bottom > top ? { kind: 'rect', x: left, y: top, width: right - left, height: bottom - top } : null;
}

export function initVisionUi({ documentRef = globalThis.document, onScan = () => {}, onCancel = () => {}, onAsk = () => {} } = {}) {
  const panel = documentRef?.getElementById('ai-vision-panel');
  const scan = documentRef?.getElementById('ai-vision-scan');
  if (!panel || !scan) return { render() {}, setBusy() {}, clear() {}, destroy() {}, getOptions: () => ({ ...DEFAULT_OPTIONS }) };
  let state = null;
  let busy = false;
  let zoomed = false;
  let destroyed = false;
  const cleanup = [];
  const node = (tag, id = '', className = '') => {
    const element = documentRef.createElement(tag);
    element.id = id; element.className = className;
    return element;
  };
  const listen = (element, name, callback) => {
    element.addEventListener(name, callback);
    cleanup.push(() => element.removeEventListener(name, callback));
  };
  const summary = node('summary', 'ai-vision-summary');
  const body = node('div', '', 'ai-vision-body');
  const controls = node('div', '', 'ai-vision-controls');
  const taskLabel = node('label'); taskLabel.htmlFor = 'ai-vision-task';
  const task = node('select', 'ai-vision-task');
  const aerial = node('option'); aerial.value = 'obb';
  const general = node('option'); general.value = 'detect';
  task.append(aerial, general); task.value = DEFAULT_OPTIONS.task;
  const thresholdLabel = node('label'); thresholdLabel.htmlFor = 'ai-vision-confidence';
  const thresholdText = node('span');
  const thresholdValue = node('output', 'ai-vision-confidence-value');
  thresholdValue.setAttribute('for', 'ai-vision-confidence');
  thresholdLabel.append(thresholdText, thresholdValue);
  const confidence = node('input', 'ai-vision-confidence');
  confidence.type = 'range'; confidence.min = '0.05'; confidence.max = '0.95'; confidence.step = '0.05'; confidence.value = '0.25';
  const cancel = node('button', 'ai-vision-cancel', 'ai-icon-button'); cancel.type = 'button';
  const cancelIcon = node('span', '', 'material-symbols-outlined'); cancelIcon.textContent = 'stop'; cancelIcon.setAttribute('aria-hidden', 'true');
  cancel.append(cancelIcon); cancel.hidden = true;
  const zoom = node('button', 'ai-vision-zoom', 'ai-icon-button'); zoom.type = 'button';
  const zoomIcon = node('span', '', 'material-symbols-outlined'); zoomIcon.setAttribute('aria-hidden', 'true'); zoom.append(zoomIcon);
  const ask = node('button', 'ai-vision-ask', 'ai-vision-ask'); ask.type = 'button';
  const status = node('p', 'ai-vision-status', 'ai-vision-status'); status.setAttribute('role', 'status');
  const stale = node('p', 'ai-vision-stale', 'ai-vision-stale'); stale.hidden = true;
  const preview = node('div', 'ai-vision-preview', 'ai-vision-preview'); preview.hidden = true;
  const image = node('img', 'ai-vision-image'); image.draggable = false;
  const overlay = documentRef.createElementNS(SVG_NS, 'svg'); overlay.id = 'ai-vision-overlay'; overlay.setAttribute('aria-hidden', 'true');
  const meta = node('p', 'ai-vision-meta', 'ai-vision-meta');
  const breakdown = node('p', 'ai-vision-breakdown', 'ai-vision-breakdown');
  const list = node('ol', 'ai-vision-detections', 'ai-vision-detections');
  const limit = node('p', 'ai-vision-limit', 'ai-vision-limit');
  controls.append(taskLabel, task, thresholdLabel, confidence, cancel, zoom);
  preview.append(image, overlay); body.append(controls, ask, status, stale, preview, meta, breakdown, list, limit);
  panel.replaceChildren(summary, body); panel.hidden = true;

  function getOptions() {
    const value = confidence.value === '' ? NaN : Number(confidence.value);
    return { task: task.value === 'detect' ? 'detect' : 'obb',
      confidence: Number.isFinite(value) ? Math.max(0.05, Math.min(0.95, value)) : DEFAULT_OPTIONS.confidence };
  }

  function setBusy(value) {
    if (destroyed) return;
    busy = Boolean(value);
    scan.disabled = busy; task.disabled = busy; confidence.disabled = busy; ask.disabled = busy; zoom.disabled = busy;
    cancel.hidden = !busy; panel.setAttribute('aria-busy', String(busy));
  }

  function translate() {
    scan.title = t('vision.scan'); scan.setAttribute('aria-label', t('vision.scan'));
    taskLabel.textContent = t('vision.task'); aerial.textContent = t('vision.task.obb'); general.textContent = t('vision.task.detect');
    thresholdText.textContent = t('vision.confidence'); thresholdValue.textContent = `${Math.round(getOptions().confidence * 100)}%`;
    cancel.title = t('vision.cancel'); cancel.setAttribute('aria-label', t('vision.cancel'));
    zoomIcon.textContent = zoomed ? 'zoom_out' : 'zoom_in';
    zoom.title = zoomed ? t('vision.zoomOut') : t('vision.zoomIn'); zoom.setAttribute('aria-label', zoom.title);
    ask.textContent = t('vision.ask'); ask.title = t('vision.ask'); ask.setAttribute('aria-label', t('vision.ask'));
    stale.textContent = t('vision.stale'); limit.textContent = t('vision.limit'); image.alt = t('vision.snapshot');
    list.setAttribute('aria-label', t('vision.detections'));
  }

  function drawDetection(detection, geometry, index, size) {
    const group = documentRef.createElementNS(SVG_NS, 'g');
    const shape = documentRef.createElementNS(SVG_NS, geometry.kind);
    const title = documentRef.createElementNS(SVG_NS, 'title');
    const label = `${index + 1}. ${classLabel(detection.class)} ${Math.round(detection.confidence * 100)}%`;
    title.textContent = label;
    if (geometry.kind === 'polygon') shape.setAttribute('points', geometry.points.map((point) => point.join(',')).join(' '));
    else for (const key of ['x', 'y', 'width', 'height']) shape.setAttribute(key, geometry[key]);
    shape.setAttribute('vector-effect', 'non-scaling-stroke');
    const marker = documentRef.createElementNS(SVG_NS, 'text');
    const fontSize = size.width * 0.038;
    const left = geometry.kind === 'polygon' ? Math.min(...geometry.points.map(([x]) => x)) : geometry.x;
    const top = geometry.kind === 'polygon' ? Math.min(...geometry.points.map(([, y]) => y)) : geometry.y;
    marker.textContent = String(index + 1);
    marker.setAttribute('x', Math.min(size.width - fontSize * marker.textContent.length, left + fontSize * 0.2));
    marker.setAttribute('y', Math.min(size.height - fontSize * 0.2, Math.max(fontSize, top + fontSize)));
    marker.setAttribute('font-size', fontSize); marker.setAttribute('stroke-width', fontSize * 0.17);
    const item = node('li'); item.textContent = label;
    group.append(title, shape, marker); overlay.append(group); list.append(item);
  }

  function renderContent() {
    translate();
    image.removeAttribute('src'); overlay.replaceChildren(); list.replaceChildren();
    preview.className = `ai-vision-preview${zoomed ? ' is-zoomed' : ''}`;
    preview.hidden = true; meta.textContent = ''; breakdown.textContent = ''; status.textContent = '';
    stale.hidden = !state?.stale; limit.hidden = state?.status !== 'done';
    summary.textContent = t('vision.title');
    if (!state) return;
    const size = imageSize(state.result);
    const hasImage = size && validImage(state.image);
    const detections = Array.isArray(state.result?.detections) ? state.result.detections.slice(0, MAX_DETECTIONS) : [];
    if (hasImage && state.status === 'done') {
      image.src = state.image; image.width = size.width; image.height = size.height;
      overlay.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`); preview.hidden = false;
      for (const detection of detections) {
        const geometry = detectionGeometry(detection, size);
        if (geometry) drawDetection(detection, geometry, list.children.length, size);
      }
    }
    if (state.status === 'running') status.textContent = t('vision.running');
    else if (state.status === 'error') status.textContent = t(`vision.error.${Object.hasOwn(ERROR_KEYS, state.error) ? ERROR_KEYS[state.error] : 'generic'}`);
    else if (state.status === 'done') {
      const truncated = state.result?.truncated === true || state.result?.detections?.length > MAX_DETECTIONS;
      const countKey = truncated ? 'vision.countTruncated' : list.children.length ? 'vision.count' : 'vision.empty';
      status.textContent = hasImage ? t(countKey, { count: list.children.length }) : t('vision.error.invalidResponse');
      if (hasImage) summary.textContent = t(truncated ? 'vision.summaryTruncated' : 'vision.summary', { count: list.children.length });
      const date = new Date(state.capturedAt);
      const timestamp = state.capturedAt != null && Number.isFinite(date.getTime()) ? date.toLocaleTimeString(getLocale(), { hour12: false }) : '';
      meta.textContent = [String(state.result?.model || '').slice(0, 100), timestamp].filter(Boolean).join(' / ');
      const classes = state.result?.supportedClasses;
      meta.title = Array.isArray(classes) ? classes.slice(0, 100).map(classLabel).join(', ') : '';
      const counts = new Map();
      let confidenceTotal = 0;
      for (const detection of detections) {
        const key = classLabel(detection.class);
        counts.set(key, (counts.get(key) || 0) + 1);
        confidenceTotal += Number.isFinite(detection.confidence) ? detection.confidence : 0;
      }
      const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const grouped = groups.map(([label, count]) => `${label} ${count}`).join('，');
      const average = detections.length ? Math.round((confidenceTotal / detections.length) * 100) : 0;
      breakdown.textContent = t('vision.statistics', { groups: grouped || t('vision.empty'), average });
    }
    status.setAttribute('data-error', String(state.status === 'error' || (state.status === 'done' && !hasImage)));
  }

  function render(next) {
    if (destroyed) return;
    const expand = !state || state.status !== next?.status || state.capturedAt !== next?.capturedAt;
    state = next ? { ...next } : null;
    panel.hidden = !state;
    if (expand && state) panel.open = true;
    setBusy(state?.status === 'running'); renderContent();
  }

  function clear() {
    zoomed = false;
    render(null); panel.open = false;
  }

  listen(confidence, 'input', () => { thresholdValue.textContent = `${Math.round(getOptions().confidence * 100)}%`; });
  listen(image, 'error', () => {
    if (state?.status === 'done') render({ status: 'error', error: 'VISION_INVALID_RESPONSE' });
  });
  listen(scan, 'click', async () => {
    if (busy || destroyed) return;
    panel.hidden = false; panel.open = true; setBusy(true);
    try { await onScan(getOptions()); } catch {
      render({ status: 'error', error: 'VISION_UNKNOWN' });
    }
  });
  listen(cancel, 'click', async () => {
    try { await onCancel(); } catch { render({ status: 'error', error: 'VISION_UNKNOWN' }); }
  });
  listen(zoom, 'click', () => {
    if (busy || destroyed || state?.status !== 'done') return;
    zoomed = !zoomed;
    renderContent();
  });
  listen(ask, 'click', async () => {
    if (busy || destroyed) return;
    try { await onAsk(); } catch { /* The assistant renders the localized request failure. */ }
  });
  cleanup.push(subscribeLocale(renderContent)); renderContent();
  return { render, setBusy, clear, getOptions, destroy() {
    clear(); destroyed = true; cleanup.forEach((remove) => remove());
  } };
}
