import { cleanIntelligenceText, intelligenceTimestamp, normalizeBounds, normalizeIntelligenceRecord } from './intelligence.js';

const MAX_LAYERS = 256;
const MAX_RECORDS = 50000;

function validId(value) {
  const id = cleanIntelligenceText(value, 160);
  return id || null;
}

function normalizeLayer(layer) {
  if (!layer || typeof layer !== 'object' || typeof layer.id !== 'string') return null;
  const records = Array.isArray(layer.records) ? layer.records.slice(0, MAX_RECORDS)
    .map((record) => normalizeIntelligenceRecord(record, layer.source)).filter((record) => record.id) : [];
  const unique = [...new Map(records.map((record) => [record.id, record])).values()];
  return Object.freeze({
    id: cleanIntelligenceText(layer.id, 80),
    name: cleanIntelligenceText(layer.name, 120) || cleanIntelligenceText(layer.id, 80),
    enabled: layer.enabled !== false,
    status: cleanIntelligenceText(layer.status, 40) || 'ready',
    truncated: layer.truncated === true,
    coverageBounds: normalizeBounds(layer.coverageBounds),
    source: cleanIntelligenceText(layer.source, 120) || null,
    updatedAt: intelligenceTimestamp(layer.updatedAt),
    records: Object.freeze(unique),
    count: Number.isSafeInteger(layer.count) ? layer.count : unique.length,
    countIsLowerBound: layer.countIsLowerBound === true,
  });
}

export function normalizeSnapshot(snapshot = {}) {
  const layers = Array.isArray(snapshot.layers) ? snapshot.layers.slice(0, MAX_LAYERS).map(normalizeLayer).filter(Boolean) : [];
  return Object.freeze({
    scope: cleanIntelligenceText(snapshot.scope, 40) || 'viewport',
    generatedAt: intelligenceTimestamp(snapshot.generatedAt) ?? Date.now(),
    bounds: normalizeBounds(snapshot.bounds),
    layers: Object.freeze(layers),
  });
}

function recordMap(layer) {
  return new Map((layer?.records || []).map((record) => [record.id, record]));
}

function layerDiff(before, after) {
  const previous = recordMap(before); const current = recordMap(after);
  const added = [...current.keys()].filter((id) => !previous.has(id)).map((id) => current.get(id));
  const removed = [...previous.keys()].filter((id) => !current.has(id)).map((id) => previous.get(id));
  const unchanged = [...current.keys()].filter((id) => previous.has(id));
  return Object.freeze({
    layerId: after?.id || before?.id,
    layerName: after?.name || before?.name,
    added: Object.freeze(added), removed: Object.freeze(removed),
    unchangedCount: unchanged.length,
    beforeCount: before?.count ?? previous.size,
    afterCount: after?.count ?? current.size,
    countDelta: (after?.count ?? current.size) - (before?.count ?? previous.size),
    countIsLowerBound: Boolean(before?.countIsLowerBound || after?.countIsLowerBound),
    comparable: true,
  });
}

/** Compare two viewport snapshots without treating unavailable layers as removals. */
export function diffSnapshots(beforeInput, afterInput) {
  const before = normalizeSnapshot(beforeInput); const after = normalizeSnapshot(afterInput);
  const beforeLayers = new Map(before.layers.map((layer) => [layer.id, layer]));
  const afterLayers = new Map(after.layers.map((layer) => [layer.id, layer]));
  const boundsChanged = JSON.stringify(before.bounds) !== JSON.stringify(after.bounds);
  const layerIds = [...new Set([...beforeLayers.keys(), ...afterLayers.keys()])];
  const layers = layerIds.map((id) => {
    const previous = beforeLayers.get(id); const current = afterLayers.get(id);
    if (!previous || !current || previous.enabled === false || current.enabled === false) {
      return Object.freeze({ layerId: id, layerName: current?.name || previous?.name || id, added: Object.freeze([]), removed: Object.freeze([]), unchangedCount: 0, beforeCount: previous?.count ?? null, afterCount: current?.count ?? null, countDelta: null, unavailable: !previous || !current || previous.enabled === false || current.enabled === false, comparable: false });
    }
    if (previous.status !== 'ready' || current.status !== 'ready' || previous.truncated || current.truncated || boundsChanged) {
      return Object.freeze({ layerId: id, layerName: current.name || previous.name || id, added: Object.freeze([]), removed: Object.freeze([]), unchangedCount: 0, beforeCount: previous.count, afterCount: current.count, countDelta: null, unavailable: previous.status !== 'ready' || current.status !== 'ready', comparable: false });
    }
    return layerDiff(previous, current);
  });
  const addedCount = layers.reduce((sum, item) => sum + item.added.length, 0);
  const removedCount = layers.reduce((sum, item) => sum + item.removed.length, 0);
  const comparable = !boundsChanged && layers.every((layer) => layer.comparable !== false);
  return Object.freeze({
    scope: after.scope,
    beforeAt: before.generatedAt,
    afterAt: after.generatedAt,
    boundsChanged,
    comparable,
    layers: Object.freeze(layers),
    addedCount, removedCount,
  });
}

export function createSnapshotHistory({ limit = 20, now = Date.now } = {}) {
  const max = Math.max(2, Math.min(100, Number(limit) || 20));
  let snapshots = [];
  const capture = (snapshot) => {
    const normalized = normalizeSnapshot({ ...snapshot, generatedAt: snapshot?.generatedAt ?? now() });
    snapshots = [...snapshots, normalized].slice(-max);
    return normalized;
  };
  const list = () => snapshots.slice();
  const latest = () => snapshots.at(-1) || null;
  const compare = (from = 1, to = 0) => {
    const current = snapshots.at(-1 - to); const previous = snapshots.at(-1 - from);
    return current && previous ? diffSnapshots(previous, current) : null;
  };
  const clear = () => { snapshots = []; };
  return Object.freeze({ capture, list, latest, compare, clear });
}
