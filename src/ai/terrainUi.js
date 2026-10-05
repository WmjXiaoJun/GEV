import { getLocale, subscribeLocale, t } from '../i18n.js';
import { SLOPE_BANDS, slopeBand } from '../annotations/terrainStyle.js';

const MAX_SAMPLES = 512;
const METRIC_KEYS = ['sampleCount', 'missingCount', 'minElevation', 'maxElevation', 'meanElevation', 'relief', 'meanSlope', 'maxSlope', 'terrainClass', 'dominantAspect'];

function finiteMetric(value, { min = -1e7, max = 1e7 } = {}) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : null;
}

function unwrap(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const root = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : payload;
  const analysis = root.analysis && typeof root.analysis === 'object' ? root.analysis : root;
  return { ...root, ...analysis };
}

export function normalizeTerrainResult(payload) {
  const root = unwrap(payload);
  const stats = root.stats && typeof root.stats === 'object' ? root.stats : {};
  const values = root.metrics && typeof root.metrics === 'object' ? { ...root, ...root.metrics } : root;
  const first = (...values) => values.find((value) => value !== undefined && value !== null);
  const metrics = Object.fromEntries(METRIC_KEYS.map((key) => {
    const source = key === 'sampleCount' ? first(values[key], stats.sampleCount)
      : key === 'missingCount' ? first(values[key], stats.missingCount)
      : key === 'minElevation' ? first(values[key], stats.minM, stats.min, stats.minElevation)
      : key === 'maxElevation' ? first(values[key], stats.maxM, stats.max, stats.maxElevation)
        : key === 'meanElevation' ? first(values[key], stats.meanM, stats.mean, stats.meanElevation)
          : key === 'relief' ? first(values[key], stats.rangeM, stats.range, stats.relief)
            : key === 'meanSlope' ? first(values[key], stats.meanSlopeDeg, stats.meanSlope, stats.slopeDeg)
              : key === 'maxSlope' ? first(values[key], stats.maxSlopeDeg, stats.maxSlope)
                : key === 'terrainClass' ? first(values[key], stats.terrainClass, values.terrainClass)
                  : first(values[key], stats.dominantAspect, stats.aspect);
    return [key, key === 'terrainClass' || key === 'dominantAspect'
      ? (typeof source === 'string' ? source.trim().slice(0, 32) || null : null)
      : finiteMetric(source, key.endsWith('Slope') ? { min: 0, max: 90 } : {})];
  }).filter(([, value]) => value !== null));
  const source = Array.isArray(root.samples) ? root.samples
    : Array.isArray(root.profile) ? root.profile
      : Array.isArray(root.profiles?.westEast) ? root.profiles.westEast
        : Array.isArray(root.grid?.values) ? root.grid.values : [];
  const samples = source.slice(0, MAX_SAMPLES).map((sample) => typeof sample === 'number' ? sample : sample?.elevation ?? sample?.heightM)
    .map((value) => finiteMetric(value, { min: -12000, max: 12000 })).filter((value) => value !== null);
  return {
    metrics,
    samples,
    summary: typeof root.summary === 'string' ? root.summary.trim().slice(0, 2000) : '',
    overlay: root.overlay && typeof root.overlay === 'object' ? root.overlay : root.geometry && typeof root.geometry === 'object' ? root.geometry : {
      points: root.grid?.points || [], contours: root.contours || [],
    },
    generatedAt: root.generatedAt || root.updatedAt || null,
    source: typeof root.source === 'string' ? root.source.slice(0, 200) : '',
  };
}

export function buildTerrainProfilePath(samples, width = 180, height = 80) {
  if (!Array.isArray(samples) || samples.length === 0 || !Number.isFinite(width) || !Number.isFinite(height)) return '';
  const values = samples.map(Number).filter(Number.isFinite);
  if (!values.length) return '';
  const min = Math.min(...values); const span = Math.max(1, Math.max(...values) - min);
  return values.map((value, index) => {
    const x = values.length === 1 ? 0 : (index / (values.length - 1)) * width;
    const y = height - ((value - min) / span) * height;
    return `${index === 0 ? 'M' : 'L'} ${Math.round(x * 100) / 100} ${Math.round(y * 100) / 100}`;
  }).join(' ');
}

export function initTerrainUi({ documentRef = globalThis.document, fetchImpl = globalThis.fetch?.bind(globalThis), getViewSnapshot = async () => null, analyzeTerrain, onDraw = () => {} } = {}) {
  const host = documentRef?.getElementById('ai-intelligence-panel');
  if (!host) return { analyze: async () => null, render() {}, destroy() {} };
  const section = documentRef.createElement('section'); section.className = 'terrain-analysis'; section.id = 'ai-terrain-analysis';
  const heading = documentRef.createElement('div'); heading.className = 'terrain-analysis-heading';
  const title = documentRef.createElement('h3'); const button = documentRef.createElement('button'); button.type = 'button'; button.className = 'intel-command';
  const icon = documentRef.createElement('span'); icon.className = 'material-symbols-outlined'; icon.textContent = 'terrain'; icon.setAttribute('aria-hidden', 'true');
  const buttonLabel = documentRef.createElement('span'); button.append(icon, buttonLabel); heading.append(title, button);
  const status = documentRef.createElement('p'); status.className = 'terrain-analysis-status'; status.setAttribute('role', 'status');
  const makeLegend = () => {
    const node = documentRef.createElement('div'); node.className = 'terrain-grade-legend'; node.hidden = true;
    return node;
  };
  const legend = makeLegend();
  const chatLegend = makeLegend(); chatLegend.id = 'terrain-chat-legend';
  const chat = documentRef.getElementById('ai-conversation-panel');
  if (chat?.insertBefore) chat.insertBefore(chatLegend, documentRef.getElementById('ai-message-form'));
  const summary = documentRef.createElement('p'); summary.className = 'terrain-analysis-summary';
  const metrics = documentRef.createElement('dl'); metrics.className = 'terrain-analysis-metrics';
  const chart = documentRef.createElement('div'); chart.className = 'terrain-analysis-chart';
  const svg = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 180 80'); svg.setAttribute('role', 'img');
  const path = documentRef.createElementNS('http://www.w3.org/2000/svg', 'path'); path.classList?.add('terrain-analysis-profile');
  const empty = documentRef.createElement('p'); empty.className = 'terrain-analysis-empty';
  svg.append(path); chart.append(svg, empty); section.append(heading, status, summary, legend, metrics, chart);
  if (typeof host.prepend === 'function') host.prepend(section);
  else if (typeof host.insertBefore === 'function') host.insertBefore(section, host.firstChild || null);
  else if (typeof host.append === 'function') host.append(section);
  let busy = false; let destroyed = false; let controller = null; let current = null;
  const cleanups = [];
  const on = (node, event, callback) => { node.addEventListener(event, callback); cleanups.push(() => node.removeEventListener(event, callback)); };
  const translate = () => {
    title.textContent = t('terrain.title'); buttonLabel.textContent = t('terrain.analyze'); button.title = t('terrain.analyze'); button.setAttribute('aria-label', t('terrain.analyze'));
    empty.textContent = t('terrain.empty'); svg.setAttribute('aria-label', t('terrain.profile'));
    for (const node of [legend, chatLegend]) {
      node.replaceChildren(); node.setAttribute('aria-label', t('terrain.legend'));
      const heading = documentRef.createElement('span'); heading.textContent = t('terrain.legend'); node.append(heading);
      for (const band of [...SLOPE_BANDS, slopeBand(null)]) {
        const item = documentRef.createElement('span'); item.className = 'terrain-grade-item';
        const swatch = documentRef.createElement('i'); swatch.style.backgroundColor = band.color; swatch.setAttribute('aria-hidden', 'true');
        const label = documentRef.createElement('span'); label.textContent = band.range || t('terrain.legendUnknown');
        item.append(swatch, label); node.append(item);
      }
      const points = documentRef.createElement('span'); points.className = 'terrain-point-legend'; points.textContent = t('terrain.legendPoints'); node.append(points);
    }
  };
  const metricLabel = (key) => t(`terrain.metric.${key}`);
  const terrainClassLabel = (value) => {
    if (getLocale() !== 'zh-CN') return value;
    return ({ flat: '平坦', rolling: '起伏', mountainous: '山地' })[value] || value;
  };
  function render(result) {
    current = result ? normalizeTerrainResult(result) : null;
    legend.hidden = !current; chatLegend.hidden = !current;
    metrics.replaceChildren(); summary.textContent = current?.summary || '';
    if (!current) { path.setAttribute('d', ''); empty.hidden = false; return; }
    for (const key of METRIC_KEYS) {
      if (current.metrics[key] == null) continue;
      const row = documentRef.createElement('div'); row.className = 'terrain-analysis-metric';
      const label = documentRef.createElement('dt'); label.textContent = metricLabel(key);
      const value = documentRef.createElement('dd');
      const unit = ['minElevation', 'maxElevation', 'meanElevation', 'relief'].includes(key) ? ' m'
        : ['meanSlope', 'maxSlope'].includes(key) ? '\u00b0' : '';
      value.textContent = `${key === 'terrainClass' ? terrainClassLabel(current.metrics[key]) : current.metrics[key]}${unit}`;
      row.append(label, value); metrics.append(row);
    }
    const d = buildTerrainProfilePath(current.samples); path.setAttribute('d', d); empty.hidden = Boolean(d);
  }
  async function analyze() {
    if (busy || destroyed || (typeof analyzeTerrain !== 'function' && typeof fetchImpl !== 'function')) return null;
    busy = true; button.disabled = true; status.textContent = t('terrain.running'); controller?.abort(); controller = new AbortController();
    try {
      const viewport = await getViewSnapshot();
      const raw = typeof analyzeTerrain === 'function'
        ? await analyzeTerrain({ viewport, signal: controller.signal })
        : await fetchImpl('/api/terrain/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ viewport }), signal: controller.signal }).then(async (response) => {
          if (!response.ok) throw new Error(`terrain ${response.status}`);
          return response.json();
        });
      if (destroyed || controller.signal.aborted) return null;
      const result = normalizeTerrainResult(raw);
      render(result); status.textContent = raw?.stale ? t('terrain.stale') : t('terrain.complete');
      if (!raw?.stale) await onDraw(raw);
      return result;
    } catch (error) {
      if (error?.name !== 'AbortError') { status.textContent = t('terrain.unavailable'); render(null); }
      return null;
    } finally { busy = false; button.disabled = destroyed; }
  }
  on(button, 'click', () => { void analyze(); });
  cleanups.push(subscribeLocale(translate)); translate(); render(null);
  return { analyze, render, destroy() {
    destroyed = true; controller?.abort(); cleanups.forEach((cleanup) => cleanup());
    chatLegend.remove?.();
    if (typeof section.remove === 'function') section.remove();
    else if (section.parentNode?.removeChild) section.parentNode.removeChild(section);
  } };
}
