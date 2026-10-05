import { normalizeSnapshot } from './snapshots.js';

const MAX_ROWS = 50000;

function text(value, max = 500) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

function quoteCsv(value) {
  const isNumeric = typeof value === 'number' && Number.isFinite(value);
  let raw = value == null ? '' : String(value);
  // Prevent spreadsheet formula injection when a feed-controlled text starts with
  // a formula operator. The apostrophe is rendered as a literal text prefix.
  if (!isNumeric && /^[=+\-@]/.test(raw)) raw = `'${raw}`;
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function records(snapshotInput) {
  const snapshot = normalizeSnapshot(snapshotInput);
  const rows = [];
  for (const layer of snapshot.layers) {
    for (const record of layer.records || []) {
      if (rows.length >= MAX_ROWS) return rows;
      rows.push({ layerId: layer.id, layerName: layer.name, ...record });
    }
  }
  return rows;
}

/** Export loaded viewport records as UTF-8 CSV with a stable, spreadsheet-safe schema. */
export function snapshotToCsv(snapshotInput) {
  const fields = ['layerId', 'layerName', 'id', 'name', 'type', 'latitude', 'longitude', 'source', 'updatedAt', 'eventAt', 'simulated'];
  const lines = [fields.join(',')];
  for (const row of records(snapshotInput)) lines.push(fields.map((field) => quoteCsv(row[field] ?? '')).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

function recordFeature(row) {
  if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)
    || row.latitude < -90 || row.latitude > 90 || row.longitude < -180 || row.longitude > 180) return null;
  const properties = {};
  for (const key of ['layerId', 'layerName', 'id', 'name', 'type', 'source', 'updatedAt', 'eventAt', 'simulated']) properties[key] = row[key] ?? null;
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] }, properties };
}

/** Export located viewport records as a GeoJSON FeatureCollection. */
export function snapshotToGeoJson(snapshotInput) {
  const snapshot = normalizeSnapshot(snapshotInput);
  return {
    type: 'FeatureCollection',
    properties: { scope: snapshot.scope, generatedAt: snapshot.generatedAt, bounds: snapshot.bounds },
    features: records(snapshot).map(recordFeature).filter(Boolean),
  };
}

/** Export a snapshot comparison as map-ready points and movement lines. */
export function comparisonToGeoJson(comparisonInput) {
  const comparison = comparisonInput && typeof comparisonInput === 'object' ? comparisonInput : {};
  const features = [];
  const addPoint = (record, change, layerId, layerName) => {
    if (!Number.isFinite(record?.latitude) || !Number.isFinite(record?.longitude)
      || record.latitude < -90 || record.latitude > 90 || record.longitude < -180 || record.longitude > 180) return;
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [record.longitude, record.latitude] }, properties: { change, layerId: layerId || null, layerName: layerName || null, id: record.id || null, name: record.name || null } });
  };
  for (const layer of Array.isArray(comparison.layers) ? comparison.layers : []) {
    for (const record of Array.isArray(layer?.added) ? layer.added : []) addPoint(record, 'added', layer.layerId, layer.layerName);
    for (const record of Array.isArray(layer?.removed) ? layer.removed : []) addPoint(record, 'removed', layer.layerId, layer.layerName);
  }
  for (const item of Array.isArray(comparison.moved) ? comparison.moved.slice(0, 10000) : []) {
    const from = item?.from; const to = item?.to;
    if (![from?.latitude, from?.longitude, to?.latitude, to?.longitude].every(Number.isFinite)) continue;
    if (Math.abs(from.latitude) > 90 || Math.abs(to.latitude) > 90 || Math.abs(from.longitude) > 180 || Math.abs(to.longitude) > 180) continue;
    const id = typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id).slice(0, 160) : null;
    const name = typeof item.name === 'string' ? item.name.slice(0, 500) : null;
    features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[from.longitude, from.latitude], [to.longitude, to.latitude]] }, properties: { change: 'moved', layerId: typeof item.layerId === 'string' ? item.layerId.slice(0, 80) : null, layerName: typeof item.layerName === 'string' ? item.layerName.slice(0, 120) : null, id, name, distanceM: Number.isFinite(item.distanceM) ? item.distanceM : null } });
  }
  return { type: 'FeatureCollection', properties: { beforeAt: comparison.beforeAt ?? null, afterAt: comparison.afterAt ?? null }, features };
}

export function snapshotToJson(snapshotInput, space = 2) {
  const snapshot = normalizeSnapshot(snapshotInput);
  const indent = Number.isInteger(space) ? Math.max(0, Math.min(space, 8)) : 2;
  return JSON.stringify(snapshot, null, indent);
}

function escapeHtml(value) {
  return text(value, 20000).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Build a self-contained, printable HTML report. Calling window.print() on the
 * resulting document produces PDF in every modern browser; no server or key is involved.
 */
export function reportToHtml({ snapshot: snapshotInput, comparison = null, title, locale = 'zh-CN' } = {}) {
  const snapshot = normalizeSnapshot(snapshotInput);
  const zh = String(locale).toLowerCase().startsWith('zh');
  const labels = zh
    ? { defaultTitle: '视口情报报告', scope: '范围', generated: '生成时间', records: '记录数', changes: '变化', added: '新增', removed: '消失', moved: '移动', print: '打印或保存为 PDF', visible: '当前视口目标', layer: '图层', name: '名称', type: '类型', lat: '纬度', lon: '经度' }
    : { defaultTitle: 'Viewport Intelligence Report', scope: 'Scope', generated: 'Generated', records: 'Records', changes: 'Changes', added: 'Added', removed: 'Removed', moved: 'Moved', print: 'Print / Save PDF', visible: 'Visible records', layer: 'Layer', name: 'Name', type: 'Type', lat: 'Latitude', lon: 'Longitude' };
  const reportTitle = title || labels.defaultTitle;
  const rows = records(snapshot);
  const generated = snapshot.generatedAt != null ? new Date(snapshot.generatedAt).toISOString() : 'Unknown';
  const table = rows.slice(0, 2000).map((row) => `<tr><td>${escapeHtml(row.layerName)}</td><td>${escapeHtml(row.name || row.id)}</td><td>${escapeHtml(row.type)}</td><td>${row.latitude ?? ''}</td><td>${row.longitude ?? ''}</td></tr>`).join('');
  const safeCount = (value) => Number.isSafeInteger(value) && value >= 0 ? String(value) : '0';
  const comparisonBlock = comparison ? `<section><h2>${labels.changes}</h2><p>${labels.added}: ${safeCount(comparison.addedCount)} | ${labels.removed}: ${safeCount(comparison.removedCount)} | ${labels.moved}: ${safeCount(comparison.movedCount)}</p></section>` : '';
  return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(reportTitle)}</title><style>body{font-family:system-ui,sans-serif;margin:32px;color:#17202a}h1{margin-bottom:4px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #ccd3da;padding:6px;text-align:left}th{background:#eef2f5}@media print{button{display:none}}</style></head><body><h1>${escapeHtml(reportTitle)}</h1><p>${labels.scope}: ${escapeHtml(snapshot.scope)}<br>${labels.generated}: ${escapeHtml(generated)}<br>${labels.records}: ${rows.length}</p>${comparisonBlock}<button onclick="window.print()">${labels.print}</button><h2>${labels.visible}</h2><table><thead><tr><th>${labels.layer}</th><th>${labels.name}</th><th>${labels.type}</th><th>${labels.lat}</th><th>${labels.lon}</th></tr></thead><tbody>${table}</tbody></table></body></html>`;
}

/** Return browser-download metadata without touching the DOM (easy to test/use in any UI). */
export function createReportExports(snapshot, comparison = null, { locale = 'zh-CN', title } = {}) {
  return Object.freeze({
    json: { content: snapshotToJson(snapshot), mimeType: 'application/json;charset=utf-8', extension: 'json' },
    csv: { content: snapshotToCsv(snapshot), mimeType: 'text/csv;charset=utf-8', extension: 'csv' },
    geojson: { content: JSON.stringify(snapshotToGeoJson(snapshot), null, 2), mimeType: 'application/geo+json;charset=utf-8', extension: 'geojson' },
    html: { content: reportToHtml({ snapshot, comparison, locale, title }), mimeType: 'text/html;charset=utf-8', extension: 'html' },
  });
}
