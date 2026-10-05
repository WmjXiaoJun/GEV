import { diffSnapshots, createSnapshotHistory, normalizeSnapshot } from './snapshots.js';

const EARTH_RADIUS_M = 6371008.8;
const MAX_MOVED = 10000;

function finiteCoordinate(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/** Great-circle distance in metres. Returns null for records without coordinates. */
export function distanceBetweenRecords(a, b) {
  if (!finiteCoordinate(a?.latitude, -90, 90) || !finiteCoordinate(b?.latitude, -90, 90)
    || !finiteCoordinate(a?.longitude, -180, 180) || !finiteCoordinate(b?.longitude, -180, 180)) return null;
  const rad = Math.PI / 180;
  const p1 = a.latitude * rad; const p2 = b.latitude * rad;
  const dp = (b.latitude - a.latitude) * rad;
  const dl = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function recordsByLayer(snapshot) {
  return new Map((snapshot?.layers || []).map((layer) => [layer.id, layer]));
}

/**
 * Compare two snapshots and additionally report targets that moved in place.
 * A movement is only reported for the same stable record id and ready,
 * comparable layers, so missing feeds cannot be mistaken for movement.
 */
export function diffViewportSnapshots(beforeInput, afterInput, { moveThresholdM = 100 } = {}) {
  const before = normalizeSnapshot(beforeInput);
  const after = normalizeSnapshot(afterInput);
  const threshold = Number.isFinite(moveThresholdM) && moveThresholdM >= 0 ? Math.min(moveThresholdM, 1000000) : 100;
  const base = diffSnapshots(before, after);
  const previousLayers = recordsByLayer(before); const currentLayers = recordsByLayer(after);
  const moved = [];
  // A camera move changes the sampled population; never infer movement across it.
  if (base.boundsChanged) return Object.freeze({ ...base, moved: Object.freeze([]), movedCount: 0, moveThresholdM: threshold });
  for (const [layerId, currentLayer] of currentLayers) {
    const previousLayer = previousLayers.get(layerId);
    if (!previousLayer || previousLayer.enabled === false || currentLayer.enabled === false
      || previousLayer.status !== 'ready' || currentLayer.status !== 'ready'
      || previousLayer.truncated || currentLayer.truncated) continue;
    const previousRecords = new Map((previousLayer.records || []).map((record) => [record.id, record]));
    for (const record of currentLayer.records || []) {
      const old = previousRecords.get(record.id);
      if (!old) continue;
      const distanceM = distanceBetweenRecords(old, record);
      if (distanceM !== null && distanceM > threshold) {
        moved.push(Object.freeze({
          layerId, layerName: currentLayer.name || previousLayer.name || layerId,
          id: record.id, name: record.name || old.name || record.id,
          from: Object.freeze({ latitude: old.latitude, longitude: old.longitude }),
          to: Object.freeze({ latitude: record.latitude, longitude: record.longitude }),
          distanceM,
          before: old, after: record,
        }));
        if (moved.length >= MAX_MOVED) break;
      }
    }
    if (moved.length >= MAX_MOVED) break;
  }
  const movedByLayer = new Map();
  for (const item of moved) movedByLayer.set(item.layerId, (movedByLayer.get(item.layerId) || 0) + 1);
  const layers = base.layers.map((layer) => Object.freeze({ ...layer, movedCount: movedByLayer.get(layer.layerId) || 0 }));
  return Object.freeze({ ...base, layers: Object.freeze(layers), moved: Object.freeze(moved), movedCount: moved.length, moveThresholdM: threshold });
}

/** Bounded in-memory store for viewport snapshots, suitable for a UI session. */
export function createViewportSnapshotStore(options = {}) {
  const history = createSnapshotHistory(options);
  const capture = (snapshot) => history.capture(snapshot);
  const compareLatest = (optionsForDiff = {}) => {
    const list = history.list();
    if (list.length < 2) return null;
    return diffViewportSnapshots(list[list.length - 2], list[list.length - 1], optionsForDiff);
  };
  return Object.freeze({ capture, list: history.list, latest: history.latest, compare: history.compare, compareLatest, clear: history.clear });
}
