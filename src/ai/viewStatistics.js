import { buildViewBrief, isIntelligenceLayerReady, normalizeIntelligenceRecord } from './intelligence.js';
import { validToolCall } from './tools.js';

const ACTION = 'get_view_statistics';

/** Flatten the loaded records that belong to the current viewport. */
export function flattenViewportRecords(snapshot) {
  if (snapshot?.scope !== 'viewport' || snapshot?.viewport?.available !== true || !Array.isArray(snapshot.layers)) return [];
  return snapshot.layers.filter((layer) => isIntelligenceLayerReady(layer))
    .flatMap((layer) => layer.records.map((record) => ({
      ...normalizeIntelligenceRecord(record, layer.source),
      layerId: typeof layer.id === 'string' ? layer.id : null,
      layerName: typeof layer.name === 'string' && layer.name ? layer.name : layer.id,
    })));
}

const RECORD_FIELDS = ['name', 'id', 'type', 'category', 'operator', 'country', 'usage', 'layerName'];

function sortViewportRecords(all, { query = '', layerId = 'all', sortBy = 'name', sortDir = 'asc' } = {}) {
  const needle = String(query ?? '').trim().toLocaleLowerCase();
  const filtered = all.filter((record) => (layerId === 'all' || record.layerId === layerId)
    && (!needle || RECORD_FIELDS.some((field) => String(record[field] ?? '').toLocaleLowerCase().includes(needle))));
  const key = RECORD_FIELDS.includes(sortBy) || ['eventAt', 'updatedAt'].includes(sortBy) ? sortBy : 'name';
  const direction = sortDir === 'desc' ? -1 : 1;
  return [...filtered].sort((a, b) => {
    const av = a[key] ?? ''; const bv = b[key] ?? '';
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * direction;
    return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * direction
      || String(a.id ?? '').localeCompare(String(b.id ?? ''), undefined, { numeric: true })
      || String(a.layerId ?? '').localeCompare(String(b.layerId ?? ''));
  });
}

export function getViewportRecords(snapshot, options = {}) {
  return sortViewportRecords(flattenViewportRecords(snapshot), options);
}

/** Return a stable, client-side page over loaded viewport records only. */
export function getViewportRecordPage(snapshot, {
  query = '', layerId = 'all', sortBy = 'name', sortDir = 'asc', page = 1, pageSize = 25,
} = {}) {
  const sorted = getViewportRecords(snapshot, { query, layerId, sortBy, sortDir });
  const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 200) : 25;
  const pageCount = Math.max(1, Math.ceil(sorted.length / size));
  const currentPage = Number.isSafeInteger(page) && page > 0 ? Math.min(page, pageCount) : 1;
  return {
    records: sorted.slice((currentPage - 1) * size, currentPage * size),
    total: sorted.length, page: currentPage, pageSize: size, pageCount,
    hasPrevious: currentPage > 1, hasNext: currentPage < pageCount,
  };
}

function csvCell(value) {
  const raw = value == null ? '' : String(value);
  const text = /^[\t\r\n ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Serialize a viewport page/list to CSV without including secrets or raw audio. */
export function viewportRecordsToCsv(records = []) {
  const columns = ['layerName', 'id', 'name', 'type', 'category', 'operator', 'country', 'usage', 'latitude', 'longitude', 'eventAt', 'updatedAt', 'simulated'];
  return [columns.join(','), ...records.map((record) => columns.map((column) => csvCell(record?.[column])).join(','))].join('\r\n');
}
const unavailableSnapshot = () => ({
  scope: 'viewport', bounds: null, generatedAt: null, layers: [],
  viewport: { available: false, width: null, height: null, method: 'camera-frustum-and-ellipsoid', geometry: 'record-anchor', reason: 'viewport-unavailable' },
});

/** Geographic watch bounds are not evidence that a record is on screen. */
export async function readViewSnapshot(workspace) {
  try {
    const snapshot = await workspace?.getViewSnapshot?.();
    const viewport = snapshot?.viewport;
    if (snapshot?.scope !== 'viewport' || viewport?.available !== true || !Array.isArray(snapshot.layers)
      || !Number.isFinite(viewport.width) || viewport.width <= 0
      || !Number.isFinite(viewport.height) || viewport.height <= 0) return unavailableSnapshot();
    return snapshot;
  } catch { return unavailableSnapshot(); }
}

export async function getViewStatistics(workspace, args = {}) {
  if (!validToolCall({ id: 'statistics', name: ACTION, arguments: args })) return { ok: false, action: ACTION, error: 'Invalid viewport statistics request' };
  const snapshot = await readViewSnapshot(workspace);
  if (!snapshot.viewport.available) return {
    ok: false, action: ACTION, available: false, scope: 'viewport-loaded-data-only',
    viewport: snapshot.viewport, bounds: null, generatedAt: null, totalCount: null, layers: [], error: 'Viewport statistics unavailable',
  };
  const targeted = args.layerId && args.layerId !== 'all';
  const layers = snapshot.layers
    .filter((layer) => layer && (targeted ? layer.id === args.layerId : layer.enabled === true));
  if (targeted && !layers.length) return { ok: false, action: ACTION, available: false, scope: 'viewport-loaded-data-only', totalCount: null, layers: [], error: 'Requested layer unavailable' };
  // Filter before context compaction so a requested layer retains its breakdown.
  const brief = buildViewBrief({ ...snapshot, layers }, { sampleLimit: args.limit });
  const evidence = JSON.parse(brief.context);
  const available = evidence.layers.some((layer) => Number.isFinite(layer.count) && layer.count >= 0);
  return {
    ...evidence, ok: available, action: ACTION, available,
    ...(!available ? { totalCount: null, simulatedCount: null, error: 'No countable viewport data available' } : {}),
    layers: evidence.layers.map((layer) => {
      const sample = Array.isArray(layer.sample) ? layer.sample : [];
      return { ...layer, sample, sampleCount: sample.length,
        omittedRecordCount: Number.isSafeInteger(layer.count) ? Math.max(0, layer.count - sample.length) : null,
      };
    }),
  };
}

function loadedCounts(layers) {
  return layers.map((layer) => {
    if (!layer || typeof layer !== 'object' || !Object.hasOwn(layer, 'count')) return layer;
    const { count, ...rest } = layer;
    return { ...rest, loadedCount: count, countScope: 'loaded-layer-total' };
  });
}

function labelLegacyCounts(result, name) {
  if (!result || typeof result !== 'object') return result;
  const { count, ...rest } = result;
  return {
    ...(name === 'get_entity_context' ? { ...rest, ...(count !== undefined ? { sampleCount: count } : {}), countScope: 'entity-sample' } : result),
    ...(Array.isArray(result.layers) ? { layers: loadedCounts(result.layers) } : {}),
    ...(Array.isArray(result.scene?.enabledLayers) ? { scene: { ...result.scene, enabledLayers: loadedCounts(result.scene.enabledLayers) } } : {}),
  };
}

export function createViewStatisticsRunner({ runAction, workspace }) {
  return async (name, args = {}, options = {}) => {
    if (name === ACTION) {
      if (options.signal?.aborted || options.isCurrent?.() === false) return { ok: false, cancelled: true, action: ACTION };
      const result = await getViewStatistics(workspace, args);
      return options.signal?.aborted || options.isCurrent?.() === false ? { ok: false, cancelled: true, action: ACTION } : result;
    }
    const result = await runAction(name, args, options);
    return ['get_current_view_state', 'get_entity_context'].includes(name) ? labelLegacyCounts(result, name) : result;
  };
}
