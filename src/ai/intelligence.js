const SUCCESS_STATES = new Set(['ready', 'ok', 'live', 'nominal', 'empty', 'fallback']);
const MAX_LAYERS = 32;
const MAX_SAMPLE = 5;
const MAX_REQUESTED_SAMPLE = 12;
const MAX_CONTEXT = 14000;
const CLASSIFICATION_FIELDS = ['category', 'operator', 'country', 'usage'];
const MAX_CATEGORIES = 10;

export function summarizeClassification(records) {
  return Object.fromEntries(CLASSIFICATION_FIELDS.map((field) => {
    const counts = new Map();
    let unknownCount = 0;
    for (const record of records) {
      const value = cleanIntelligenceText(record?.[field], 120);
      if (!value) unknownCount += 1;
      else counts.set(value, (counts.get(value) || 0) + 1);
    }
    const values = [...counts].map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    return [field, {
      values: values.slice(0, MAX_CATEGORIES), unknownCount,
      otherCount: values.slice(MAX_CATEGORIES).reduce((sum, entry) => sum + entry.count, 0),
      otherCategoryCount: Math.max(0, values.length - MAX_CATEGORIES),
    }];
  }));
}

export function cleanIntelligenceText(value, limit = 160) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
}

export function intelligenceTimestamp(value) {
  const time = typeof value === 'string' && value.trim() ? Date.parse(value) : value;
  return typeof time === 'number' && Number.isFinite(time) && time >= 0 ? time : null;
}

export function normalizeBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const { west, south, east, north } = value;
  if (![west, south, east, north].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  if (Math.abs(west) > 180 || Math.abs(east) > 180 || Math.abs(south) > 90 || Math.abs(north) > 90 || south > north) return null;
  return { west, south, east, north };
}

export function pointInBounds(value, latitude, longitude) {
  const bounds = normalizeBounds(value);
  if (!bounds || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return false;
  const longitudeInside = bounds.west <= bounds.east
    ? longitude >= bounds.west && longitude <= bounds.east
    : longitude >= bounds.west || longitude <= bounds.east;
  return latitude >= bounds.south && latitude <= bounds.north && longitudeInside;
}

function longitudeSegments(bounds) {
  return bounds.west <= bounds.east ? [[bounds.west, bounds.east]] : [[bounds.west, 180], [-180, bounds.east]];
}

export function boundsCover(outerValue, innerValue) {
  const outer = normalizeBounds(outerValue);
  const inner = normalizeBounds(innerValue);
  if (!outer || !inner || outer.south > inner.south || outer.north < inner.north) return false;
  return longitudeSegments(inner).every(([west, east]) => longitudeSegments(outer).some(([left, right]) => left <= west && right >= east));
}

export function isIntelligenceLayerReady(layer) {
  return layer?.enabled === true && !layer.error && SUCCESS_STATES.has(layer.status) && Array.isArray(layer.records);
}

export function normalizeIntelligenceRecord(record, layerSource = null) {
  const rawId = typeof record?.id === 'number' && Number.isFinite(record.id) ? String(record.id) : record?.id;
  return {
    id: cleanIntelligenceText(rawId, 160) || null,
    name: cleanIntelligenceText(record?.name) || null,
    type: cleanIntelligenceText(record?.type, 60) || null,
    latitude: Number.isFinite(record?.latitude) ? record.latitude : null,
    longitude: Number.isFinite(record?.longitude) ? record.longitude : null,
    source: cleanIntelligenceText(record?.source, 120) || layerSource || null,
    updatedAt: intelligenceTimestamp(record?.updatedAt),
    loadedAt: intelligenceTimestamp(record?.loadedAt),
    sourceUpdatedAt: intelligenceTimestamp(record?.sourceUpdatedAt),
    eventAt: intelligenceTimestamp(record?.eventAt),
    simulated: record?.simulated === true,
    ...Object.fromEntries(CLASSIFICATION_FIELDS.map((field) => [field, cleanIntelligenceText(record?.[field], 120) || null])),
  };
}

function normalizeBreakdown(input, count) {
  return Object.fromEntries(CLASSIFICATION_FIELDS.map((field) => {
    const group = input?.[field];
    const values = Array.isArray(group?.values) ? group.values.filter((entry) =>
      cleanIntelligenceText(entry?.value) && Number.isSafeInteger(entry.count) && entry.count > 0)
      .map((entry) => ({ value: cleanIntelligenceText(entry.value, 120), count: entry.count })) : [];
    const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    return [field, {
      values: values.slice(0, MAX_CATEGORIES),
      unknownCount: group ? nonnegative(group.unknownCount) : count,
      otherCount: nonnegative(group?.otherCount) + values.slice(MAX_CATEGORIES).reduce((sum, entry) => sum + entry.count, 0),
      otherCategoryCount: nonnegative(group?.otherCategoryCount) + Math.max(0, values.length - MAX_CATEGORIES),
    }];
  }));
}

function briefLayer(layer, bounds, viewport = null, sampleLimit = MAX_SAMPLE) {
  const ready = isIntelligenceLayerReady(layer) && (viewport ? viewport.available === true : bounds !== null);
  const records = ready ? (viewport ? layer.records : layer.records.filter((record) => pointInBounds(bounds, record?.latitude, record?.longitude))) : [];
  const source = cleanIntelligenceText(layer.source, 120) || null;
  const exactCount = viewport && Number.isSafeInteger(layer.count) && layer.count >= 0 ? layer.count : null;
  const count = ready ? (viewport ? exactCount : records.length) : null;
  return {
    id: cleanIntelligenceText(layer.id, 80),
    name: cleanIntelligenceText(layer.name) || cleanIntelligenceText(layer.id, 80),
    enabled: layer.enabled === true,
    status: layer.enabled === false ? 'disabled' : cleanIntelligenceText(layer.status, 40) || 'unknown',
    error: cleanIntelligenceText(layer.error, 160) || (layer.error ? 'DATA_UNAVAILABLE' : null),
    source,
    lastUpdated: intelligenceTimestamp(layer.updatedAt),
    ...(viewport ? { loadedAt: intelligenceTimestamp(layer.loadedAt), sourceUpdatedAt: intelligenceTimestamp(layer.sourceUpdatedAt) } : {}),
    count,
    countIsLowerBound: ready && (viewport ? layer.countIsLowerBound === true : layer.truncated === true),
    simulatedCount: ready ? (viewport && Number.isSafeInteger(layer.simulatedCount) ? layer.simulatedCount : records.filter((record) => record?.simulated === true).length) : null,
    ...(viewport ? {
      breakdown: count === null ? null : normalizeBreakdown(layer.breakdown, count),
      unlocatedRecordCount: Number.isSafeInteger(layer.unlocatedRecordCount) && layer.unlocatedRecordCount >= 0 ? layer.unlocatedRecordCount : null,
    } : {}),
    sample: records.slice(0, sampleLimit).map((record) => normalizeIntelligenceRecord(record, source)),
    truncated: layer.truncated === true || (ready && records.length > sampleLimit),
  };
}

function contextForBrief(summary) {
  const full = JSON.stringify(summary);
  if (full.length <= MAX_CONTEXT) return full;
  let compact = {
    ...summary, truncated: true,
    layers: summary.layers.map((layer) => ({
      id: layer.id.slice(0, 40), name: layer.name.slice(0, 40), enabled: layer.enabled,
      status: layer.status.slice(0, 20), source: layer.source?.slice(0, 60) ?? null,
      lastUpdated: layer.lastUpdated, count: layer.count, countIsLowerBound: layer.countIsLowerBound,
      simulatedCount: layer.simulatedCount, error: Boolean(layer.error),
      sample: layer.sample.map(({ id, name, type, simulated }) => ({ id, name, type, simulated })),
      ...(layer.breakdown ? { breakdown: layer.breakdown } : {}),
      ...(summary.viewport ? { loadedAt: layer.loadedAt, sourceUpdatedAt: layer.sourceUpdatedAt, unlocatedRecordCount: layer.unlocatedRecordCount } : {}),
    })),
  };
  while (JSON.stringify(compact).length > MAX_CONTEXT) {
    // Preserve identities from every layer before sacrificing any count evidence.
    const sampleLayerIndex = compact.layers.reduce((selected, layer, index) =>
      layer.sample.length > (compact.layers[selected]?.sample.length ?? 0) ? index : selected, -1);
    compact = sampleLayerIndex < 0
      ? { ...compact, layers: compact.layers.slice(0, -1), omittedLayerCount: (compact.omittedLayerCount || 0) + 1 }
      : { ...compact, layers: compact.layers.map((layer, index) => index === sampleLayerIndex
        ? { ...layer, sample: layer.sample.slice(0, -1) } : layer) };
  }
  return JSON.stringify(compact);
}

/** Summaries describe loaded evidence, never infer missing feeds or invented freshness. */
export function buildViewBrief(snapshot, { sampleLimit: requestedLimit = MAX_SAMPLE } = {}) {
  const sampleLimit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, MAX_REQUESTED_SAMPLE) : MAX_SAMPLE;
  const bounds = normalizeBounds(snapshot?.bounds);
  const viewport = snapshot?.scope === 'viewport' ? {
    available: snapshot.viewport?.available === true,
    method: cleanIntelligenceText(snapshot.viewport?.method, 60) || null,
    geometry: cleanIntelligenceText(snapshot.viewport?.geometry, 60) || null,
    width: Number.isFinite(snapshot.viewport?.width) ? snapshot.viewport.width : null,
    height: Number.isFinite(snapshot.viewport?.height) ? snapshot.viewport.height : null,
    reason: cleanIntelligenceText(snapshot.viewport?.reason, 80) || null,
  } : null;
  const inputLayers = Array.isArray(snapshot?.layers) ? snapshot.layers : [];
  const validLayers = inputLayers.filter((layer) => layer && typeof layer.id === 'string' && layer.id);
  const orderedLayers = viewport ? validLayers.toSorted((a, b) => Number(b.enabled === true) - Number(a.enabled === true)) : validLayers;
  const layers = orderedLayers.slice(0, MAX_LAYERS).map((layer) => briefLayer(layer, bounds, viewport, sampleLimit));
  const countableLayers = layers.filter((layer) => layer.count !== null);
  const totalCount = viewport && !countableLayers.length ? null : countableLayers.reduce((sum, layer) => sum + layer.count, 0);
  const partialCoverage = Boolean(viewport && (layers.some((layer) => layer.enabled && (layer.count === null || layer.countIsLowerBound)) ||
    orderedLayers.slice(MAX_LAYERS).some((layer) => layer.enabled === true)));
  const summary = {
    bounds,
    generatedAt: intelligenceTimestamp(snapshot?.generatedAt),
    scope: viewport ? 'viewport-loaded-data-only' : 'loaded-data-only',
    ...(viewport ? { viewport, partialCoverage, totalCountIsLowerBound: totalCount !== null && partialCoverage } : {}),
    totalCount,
    simulatedCount: viewport && !countableLayers.length ? null : countableLayers.reduce((sum, layer) => sum + (layer.simulatedCount ?? 0), 0),
    layers,
    truncated: inputLayers.length > layers.length,
  };
  return { ...summary, rows: layers.map((layer) => ({ ...layer, sample: layer.sample.map((record) => ({ ...record })) })), context: contextForBrief(summary) };
}
