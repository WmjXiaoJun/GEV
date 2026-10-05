import {
  boundsCover, cleanIntelligenceText, intelligenceTimestamp, isIntelligenceLayerReady,
  normalizeBounds, normalizeIntelligenceRecord, pointInBounds,
} from './intelligence.js';

const VERSION = 1;
const MAX_AREAS = 10;
const MAX_ALERTS = 100;
const MAX_IDS = 50000;
const MAX_STORAGE = 16 * 1024 * 1024;
const LAYER_ID = /^[a-zA-Z0-9_-]{1,80}$/;

function invalid(code = 'WATCH_INVALID_INPUT') {
  return Object.assign(new Error(code), { code });
}

function normalizeRules(value = {}) {
  const countThreshold = value.countThreshold == null ? null : Number(value.countThreshold);
  if (countThreshold !== null && (!Number.isSafeInteger(countThreshold) || countThreshold < 1 || countThreshold > MAX_IDS)) throw invalid();
  const categories = Array.isArray(value.categories)
    ? [...new Set(value.categories.map((item) => cleanIntelligenceText(item, 80)).filter(Boolean))].slice(0, 64) : [];
  const sustainedMs = value.sustainedMs == null ? 0 : Number(value.sustainedMs);
  if (!Number.isFinite(sustainedMs) || sustainedMs < 0 || sustainedMs > 7 * 24 * 60 * 60 * 1000) throw invalid();
  const quietHours = value.quietHours && typeof value.quietHours === 'object' ? value.quietHours : null;
  let quiet = null;
  if (quietHours) {
    const start = Number(quietHours.start); const end = Number(quietHours.end);
    if (![start, end].every((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)) throw invalid();
    quiet = { start, end };
  }
  return { countThreshold, categories, sustainedMs, quietHours: quiet };
}

function areaInput(value) {
  const name = cleanIntelligenceText(value?.name, 80);
  const bounds = normalizeBounds(value?.bounds);
  const layerIds = Array.isArray(value?.layerIds) ? [...new Set(value.layerIds)] : [];
  if (!name || !bounds || !layerIds.length || layerIds.length > 32 || !layerIds.every((id) => typeof id === 'string' && LAYER_ID.test(id))) throw invalid();
  return { name, bounds, layerIds, rules: normalizeRules(value?.rules || value?.conditions) };
}

function defaultStorage() {
  return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
}

function readSaved(raw) {
  if (!raw) return { areas: [], alerts: [], baselines: [] };
  if (typeof raw !== 'string' || raw.length > MAX_STORAGE) throw invalid('WATCH_STORAGE_INVALID');
  const value = JSON.parse(raw);
  if (value?.version !== VERSION || !Array.isArray(value.areas)) throw invalid('WATCH_STORAGE_INVALID');
  const areas = value.areas.slice(0, MAX_AREAS).flatMap((area) => {
    try {
      if (typeof area?.id !== 'string' || !LAYER_ID.test(area.id) || typeof area.enabled !== 'boolean' || intelligenceTimestamp(area.createdAt) === null) return [];
    return [{ ...areaInput(area), id: area.id, enabled: area.enabled, createdAt: intelligenceTimestamp(area.createdAt) }];
    } catch { return []; }
  }).filter((area, index, all) => all.findIndex((item) => item.id === area.id) === index);
  const alerts = (Array.isArray(value.alerts) ? value.alerts : []).slice(0, MAX_ALERTS).flatMap((alert) => {
    const area = areas.find((item) => item.id === alert?.areaId && item.enabled);
    if (!area || !area.layerIds.includes(alert.layerId) || typeof alert.id !== 'string' || !alert.id || intelligenceTimestamp(alert.observedAt) === null) return [];
    const record = normalizeIntelligenceRecord({ id: alert.recordId, name: alert.name, source: alert.source, eventAt: alert.eventAt, simulated: alert.simulated });
    if (!record.id) return [];
    return [{ id: cleanIntelligenceText(alert.id, 160), areaId: area.id, areaName: area.name, layerId: alert.layerId, layerName: cleanIntelligenceText(alert.layerName), recordId: record.id, name: record.name, source: record.source, eventAt: record.eventAt, observedAt: intelligenceTimestamp(alert.observedAt), simulated: record.simulated, read: alert.read === true, processed: alert.processed === true, note: cleanIntelligenceText(alert.note, 500) || null }];
  });
  const baselines = (Array.isArray(value.baselines) ? value.baselines : []).slice(0, MAX_AREAS * 32).flatMap((baseline) => {
    const area = areas.find((item) => item.id === baseline?.areaId && item.enabled);
    if (!area || !area.layerIds.includes(baseline.layerId) || !Array.isArray(baseline.ids)) return [];
    return [{ areaId: area.id, layerId: baseline.layerId, source: cleanIntelligenceText(baseline.source, 120) || null, ids: [...new Set(baseline.ids.filter((id) => typeof id === 'string' && id && id.length <= 160).slice(0, MAX_IDS))], saturated: baseline.saturated === true, count: Number.isSafeInteger(baseline.count) ? baseline.count : 0, conditionSince: intelligenceTimestamp(baseline.conditionSince), alertedAt: intelligenceTimestamp(baseline.alertedAt) }];
  });
  return { areas, alerts, baselines };
}

function quietNow(rules, timestamp) {
  if (!rules.quietHours) return false;
  const hour = new Date(timestamp).getHours();
  const { start, end } = rules.quietHours;
  return start === end ? true : start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function observeLayer(area, layer, snapshot, previous, makeId, now) {
  const source = cleanIntelligenceText(layer.source, 120) || null;
  const sameSource = previous?.source === source;
  const known = new Set(sameSource ? previous.ids : []);
  const records = layer.records.map((record) => normalizeIntelligenceRecord(record, source)).filter((record) => record.id);
  const uniqueRecords = [...new Map(records.map((record) => [record.id, record])).values()];
  const newRecords = uniqueRecords.filter((record) => !known.has(record.id));
  const inArea = uniqueRecords.filter((record) => pointInBounds(area.bounds, record.latitude, record.longitude));
  const rules = area.rules || normalizeRules();
  const matchesCategory = (record) => rules.categories.length === 0 || rules.categories.includes(record.category) || rules.categories.includes(record.type);
  const categoryMatch = rules.categories.length === 0 || inArea.some(matchesCategory);
  const thresholdMatch = rules.countThreshold === null || inArea.length >= rules.countThreshold;
  const conditionMatch = thresholdMatch && categoryMatch;
  const observedAt = intelligenceTimestamp(snapshot.generatedAt) ?? now();
  const conditionSince = conditionMatch ? (previous?.conditionSince ?? observedAt) : null;
  const sustained = conditionMatch && observedAt - conditionSince >= rules.sustainedMs;
  const loadedIds = Array.isArray(layer.knownRecordIds) ? layer.knownRecordIds.slice(0, MAX_IDS + 1).filter((id) => typeof id === 'string' && id && id.length <= 160) : [];
  const mergedIds = [...new Set([...known, ...newRecords.map((record) => record.id), ...loadedIds])];
  const saturated = (sameSource && previous?.saturated) || mergedIds.length > MAX_IDS;
  const baseline = { areaId: area.id, layerId: layer.id, source, ids: mergedIds.slice(0, MAX_IDS), saturated: Boolean(saturated), count: inArea.length, conditionSince, alertedAt: previous?.alertedAt ?? null };
  if (!previous || !sameSource || saturated) return { baseline, alerts: [] };
  const ruleActive = rules.countThreshold !== null || rules.categories.length > 0;
  const canAlert = sustained && !quietNow(rules, observedAt) && (!ruleActive || previous?.alertedAt !== conditionSince);
  if (canAlert && ruleActive) baseline.alertedAt = observedAt;
  const candidates = newRecords.filter((record) => pointInBounds(area.bounds, record.latitude, record.longitude) && matchesCategory(record));
  const alerts = (canAlert ? (ruleActive ? candidates.slice(-1) : candidates) : []).map((record) => ({
    id: makeId('alert'), areaId: area.id, areaName: area.name,
    layerId: layer.id, layerName: cleanIntelligenceText(layer.name) || layer.id,
    recordId: record.id, name: record.name, source: record.source,
    eventAt: record.eventAt, observedAt,
    simulated: record.simulated, read: false, processed: false, note: null,
  }));
  return { baseline, alerts };
}

/** Local, loaded-feed monitoring: source failures and coverage gaps require a new baseline. */
export function createWatchlist({ storage, key = 'gev.ai.watchlist.v1', now = Date.now, onChange = () => {} } = {}) {
  let persistence = storage;
  let storageError = null;
  let state = { areas: [], alerts: [], baselines: [] };
  let sequence = 0;
  try {
    if (persistence === undefined) persistence = defaultStorage();
    if (!persistence) storageError = 'WATCH_STORAGE_UNAVAILABLE';
    state = readSaved(persistence?.getItem(key));
  } catch { storageError = 'WATCH_STORAGE_UNAVAILABLE'; }

  const getState = () => ({ version: VERSION, areas: structuredClone(state.areas), alerts: structuredClone(state.alerts), storageError });
  const makeId = (prefix) => `${prefix}-${now().toString(36)}-${++sequence}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
  const commit = (next) => {
    state = next;
    try {
      const serialized = JSON.stringify({ version: VERSION, ...state });
      if (serialized.length > MAX_STORAGE) throw invalid('WATCH_STORAGE_LIMIT');
      persistence?.setItem(key, serialized);
      storageError = persistence ? null : 'WATCH_STORAGE_UNAVAILABLE';
    } catch { storageError = 'WATCH_STORAGE_UNAVAILABLE'; }
    onChange(getState());
  };

  const add = (input) => {
    if (state.areas.length >= MAX_AREAS) throw invalid('WATCH_LIMIT');
    const area = { ...areaInput(input), id: makeId('area'), enabled: true, createdAt: now() };
    commit({ ...state, areas: [...state.areas, area] });
    return structuredClone(area);
  };
  const remove = (id) => {
    if (!state.areas.some((area) => area.id === id)) return false;
    commit({ areas: state.areas.filter((area) => area.id !== id), alerts: state.alerts.filter((alert) => alert.areaId !== id), baselines: state.baselines.filter((item) => item.areaId !== id) });
    return true;
  };
  const rename = (id, value) => {
    const name = cleanIntelligenceText(value, 80);
    if (!name) throw invalid();
    if (!state.areas.some((area) => area.id === id)) return false;
    commit({ ...state, areas: state.areas.map((area) => area.id === id ? { ...area, name } : area), alerts: state.alerts.map((alert) => alert.areaId === id ? { ...alert, areaName: name } : alert) });
    return true;
  };
  const updateRules = (id, rules) => {
    const area = state.areas.find((item) => item.id === id);
    if (!area) return false;
    const normalized = normalizeRules(rules);
    commit({ ...state, areas: state.areas.map((item) => item.id === id ? { ...item, rules: normalized } : item), baselines: state.baselines.filter((item) => item.areaId !== id) });
    return true;
  };
  const toggle = (id, enabled) => {
    const area = state.areas.find((item) => item.id === id);
    if (!area) return false;
    if (enabled !== undefined && typeof enabled !== 'boolean') throw invalid();
    const nextEnabled = enabled ?? !area.enabled;
    if (nextEnabled === area.enabled) return true;
    commit({ areas: state.areas.map((item) => item.id === id ? { ...item, enabled: nextEnabled } : item), alerts: state.alerts.filter((alert) => alert.areaId !== id), baselines: state.baselines.filter((item) => item.areaId !== id) });
    return true;
  };
  const observe = (snapshot) => {
    const layers = Array.isArray(snapshot?.layers) ? snapshot.layers : [];
    const observations = state.areas.filter((area) => area.enabled).flatMap((area) => area.layerIds.flatMap((layerId) => {
      const layer = layers.find((item) => item?.id === layerId);
      if (!isIntelligenceLayerReady(layer) || layer.truncated === true || layer.knownRecordIdsTruncated === true || !boundsCover(layer.coverageBounds || snapshot?.bounds, area.bounds)) return [];
      const previous = state.baselines.find((item) => item.areaId === area.id && item.layerId === layerId);
      return [observeLayer(area, layer, snapshot, previous, makeId, now)];
    }));
    const additions = observations.flatMap((item) => item.alerts).slice(-MAX_ALERTS).reverse();
    commit({ ...state, baselines: observations.map((item) => item.baseline), alerts: [...additions, ...state.alerts].slice(0, MAX_ALERTS) });
    return structuredClone(additions);
  };
  const markRead = (id) => commit({ ...state, alerts: state.alerts.map((alert) => id === undefined || alert.id === id ? { ...alert, read: true } : alert) });
  const markProcessed = (id, note = null) => {
    if (id !== undefined && !state.alerts.some((alert) => alert.id === id)) return false;
    const cleanNote = note == null ? null : cleanIntelligenceText(note, 500) || null;
    commit({ ...state, alerts: state.alerts.map((alert) => id === undefined || alert.id === id ? { ...alert, processed: true, note: cleanNote ?? alert.note ?? null } : alert) });
    return true;
  };
  const clearAlerts = (areaId) => commit({ ...state, alerts: areaId === undefined ? [] : state.alerts.filter((alert) => alert.areaId !== areaId) });
  return { add, remove, rename, updateRules, toggle, getState, observe, markRead, markProcessed, clearAlerts };
}
