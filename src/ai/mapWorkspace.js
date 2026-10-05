import * as Cesium from 'cesium';
import { cleanIntelligenceText, intelligenceTimestamp, normalizeBounds, pointInBounds, summarizeClassification } from './intelligence.js';
import { createViewportFilter, hasGeographicAnchor } from './viewportGeometry.js';
import { captureViewportFrame, viewportFrameKey } from './viewportCapture.js';
import { buildVisionAnnotations } from './visionMapOverlay.js';
import { createBuildingPolygonLayer } from './buildingPolygons.js';
import { clearOverlaySource, setOverlayEntries } from '../overlays/worldOverlay.js';
import { slopeBand } from '../annotations/terrainStyle.js';

const CAMERA_ACTIONS = new Set(['fly_to_location', 'adjust_camera_zoom', 'zoom_to_globe']);
const ANNOTATION_ACTIONS = new Set(['annotate_map', 'clear_annotations']);
const CONTEXT_LAYERS = new Set(['military-awareness', 'rocket-launches']);
const FAILED_STATES = new Set(['error', 'unavailable', 'source-unavailable', 'offline', 'down', 'degraded']);
const VISUAL_KEYS = ['style', 'bloom', 'sharpen', 'hud', 'detection', 'styleParams'];
const MAX_RECORDS = 2000;
const MAX_LOADED_RECORDS = 500000;
const MAX_KNOWN_IDS = 50000;
const MOVING_LAYERS = new Set(['flights', 'military', 'ais-live-vessels']);
const validTime = (value) => (intelligenceTimestamp(value) || null);
const text = (value) => cleanIntelligenceText(typeof value === 'number' && Number.isFinite(value) ? String(value) : value) || null;

function sourceStatus(layer, module) {
  const stats = layer.stats || {};
  if (!layer.enabled) return 'disabled';
  if (layer.lifecycleUncertain || ['enabling', 'disabling'].includes(layer.lifecycleState) || stats.loading || stats.status === 'loading') return 'loading';
  if (stats.stale || stats.status === 'stale') return 'stale';
  if (stats.error || stats.lastError || stats.managerRefreshError || stats.available === false || stats.unavailable === true || FAILED_STATES.has(stats.status) || (Number.isFinite(stats.status) && stats.status >= 400)) return 'error';
  if (['unknown', 'idle', 'zoom-in'].includes(stats.status)) return 'unknown';
  return typeof module?.getAnalystRecords === 'function' ? 'ready' : 'unsupported';
}

function stableRecordId(record, layerId, latitude, longitude, eventAt) {
  const id = text(record.icao24) || text(record.mmsi) || text(record.id);
  const indexedFire = layerId === 'local-firms' || layerId === 'firms';
  const indexedQuake = layerId === 'earthquakes' && (!id || /^QUAKE-\d+$/.test(id));
  if (!indexedFire && !indexedQuake) return id;
  if (!eventAt || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return `${indexedFire ? 'fire' : 'quake'}:${latitude}:${longitude}:${eventAt}:${text(record.satellite)?.slice(0, 40) || ''}`;
}

function mapRecord(record, layer) {
  const stats = layer.stats || {};
  const latitude = Number.isFinite(record.lat) ? record.lat : record.latitude;
  const longitude = Number.isFinite(record.lon) ? record.lon : record.longitude;
  const eventAt = validTime(record.timeMs) || validTime(record.eventAt) || validTime(record.acqTime);
  return {
    id: stableRecordId(record, layer.id, latitude, longitude, eventAt),
    name: text(record.callsign || record.name || record.place || record.id), type: layer.id,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    source: text(record.source) || text(stats.source) || text(layer.source),
    updatedAt: validTime(record.updatedAt), eventAt,
    loadedAt: validTime(record.loadedAt), sourceUpdatedAt: validTime(record.sourceUpdatedAt),
    category: text(record.category), operator: text(record.operator), country: text(record.country), usage: text(record.usage),
    simulated: record.simulated === true || stats.simulated === true || stats.mode === 'sim' || layer.id === 'traffic',
  };
}

function layerSnapshot(layer, module, bounds, viewport = null) {
  const stats = layer.stats || {};
  let status = sourceStatus(layer, module);
  let records = [];
  let truncated = false;
  let knownRecordIds = [];
  let knownRecordIdsTruncated = false;
  let viewportStats = { count: null, countIsLowerBound: false, simulatedCount: null, breakdown: null, unlocatedRecordCount: null };
  if (viewport && !viewport.metadata.available && status === 'ready') status = 'unavailable';
  if (status === 'ready') {
    try {
      // Readers expose their loaded in-memory collections; cap only after spatial filtering.
      const raw = module.getAnalystRecords(MAX_LOADED_RECORDS + 1);
      if (!Array.isArray(raw)) throw new Error('Invalid records');
      const loaded = raw.slice(0, MAX_LOADED_RECORDS).filter((record) => record && typeof record === 'object' && !Array.isArray(record));
      if (!loaded.length && !validTime(stats.lastUpdate) && !['ready', 'empty', 'ok', 'nominal'].includes(stats.status)) status = 'unknown';
      const regional = loaded.filter((record) => viewport ? viewport.contains(record) : pointInBounds(bounds, record.lat ?? record.latitude, record.lon ?? record.longitude));
      truncated = raw.length > MAX_LOADED_RECORDS || regional.length > MAX_RECORDS;
      records = regional.slice(0, MAX_RECORDS).map((record) => mapRecord(record, layer));
      if (viewport && status === 'ready') {
        const unlocatedRecordCount = (Number.isSafeInteger(stats.unlocatedRecordCount) && stats.unlocatedRecordCount > 0 ? stats.unlocatedRecordCount : 0)
          + Math.min(raw.length, MAX_LOADED_RECORDS) - loaded.length + loaded.filter((record) => !hasGeographicAnchor(record)).length;
        viewportStats = {
          count: regional.length, countIsLowerBound: raw.length > MAX_LOADED_RECORDS || unlocatedRecordCount > 0,
          unlocatedRecordCount,
          simulatedCount: regional.filter((record) => record.simulated === true || stats.simulated === true || stats.mode === 'sim' || layer.id === 'traffic').length,
          breakdown: summarizeClassification(regional),
        };
      }
      if (!viewport && MOVING_LAYERS.has(layer.id)) {
        const ids = [...new Set(loaded.map((record) => text(record.icao24) || text(record.mmsi) || text(record.id)).filter(Boolean))];
        knownRecordIds = ids.slice(0, MAX_KNOWN_IDS);
        knownRecordIdsTruncated = raw.length > MAX_LOADED_RECORDS || ids.length > MAX_KNOWN_IDS;
      }
    } catch { status = 'error'; }
  }
  return {
    id: layer.id, name: layer.name, enabled: layer.enabled, status,
    error: status === 'error' ? 'source-unavailable' : null,
    source: text(stats.source || layer.source),
    updatedAt: stats.isStatic === true ? validTime(stats.sourceUpdatedAt) : validTime(stats.lastUpdate),
    loadedAt: validTime(stats.loadedAt), sourceUpdatedAt: validTime(stats.sourceUpdatedAt),
    records, truncated, knownRecordIds, knownRecordIdsTruncated,
    ...(viewport ? viewportStats : {}),
  };
}

function validCamera(camera) {
  return camera && [camera.position?.x, camera.position?.y, camera.position?.z, camera.heading, camera.pitch, camera.roll].every(Number.isFinite);
}

function visualSnapshot(styleManager) {
  const visual = styleManager.getVisualState?.();
  return visual ? structuredClone(Object.fromEntries(VISUAL_KEYS.filter((key) => Object.hasOwn(visual, key)).map((key) => [key, visual[key]]))) : null;
}

const VISION_SOURCE = 'vision';

// Detail budget for analytical terrain overlays. Camera altitude is a stable,
// renderer-independent proxy for how much of the map is in view. The far band
// intentionally omits contour lines entirely; the range outline and extrema
// still communicate where the analysis applies without a green mesh of dashes.
export function terrainDisplayProfile(cameraHeight) {
  const h = Number(cameraHeight);
  if (!Number.isFinite(h) || h < 8_000) return {
    band: 'near', contourLimit: 12, segmentLimit: 5,
    showSamples: true, sampleLimit: 16, showSlope: true, slopeLimit: 12, featureLimit: 8,
  };
  if (h < 40_000) return {
    band: 'mid', contourLimit: 7, segmentLimit: 7,
    showSamples: true, sampleLimit: 25, showSlope: true, slopeLimit: 8, featureLimit: 6,
  };
  return {
    band: 'far', contourLimit: 0, segmentLimit: 0,
    showSamples: true, sampleLimit: 9, showSlope: true, slopeLimit: 4, featureLimit: 2,
  };
}

/** Color band used by terrain route overlays and slope markers. */
export function terrainSlopeColor(slopeDeg) {
  return slopeBand(slopeDeg).key;
}

/** Pick a view-spanning subset of observed grid samples without interpolation. */
export function selectTerrainEvidence(points, rows, cols, limit) {
  if (!Array.isArray(points) || !Number.isInteger(rows) || !Number.isInteger(cols)
    || rows * cols !== points.length || !Number.isInteger(limit) || limit < 1) return [];
  const side = Math.min(Math.max(1, Math.floor(Math.sqrt(limit))), rows, cols);
  const selected = [];
  const seen = new Set();
  for (let row = 0; row < side; row += 1) for (let col = 0; col < side; col += 1) {
    const sourceRow = side === 1 ? Math.floor((rows - 1) / 2) : Math.round((row * (rows - 1)) / (side - 1));
    const sourceCol = side === 1 ? Math.floor((cols - 1) / 2) : Math.round((col * (cols - 1)) / (side - 1));
    const index = sourceRow * cols + sourceCol;
    if (!seen.has(index) && points[index]) { selected.push(points[index]); seen.add(index); }
  }
  return selected.slice(0, limit);
}

/**
 * Convert pixel detections into world-anchored annotations. The annotation
 * resolver performs a depth-aware Cesium pick from the normalized center, so
 * these remain useful after the camera moves without pretending a pixel box is
 * an authoritative geographic footprint.
 */
async function drawVisionDetectionsFor(viewer, annotations, result, image, { maxDetections = 80 } = {}) {
  if (!annotations?.annotate || !result || !image) return { ok: false, drawn: 0, skipped: 0, error: 'Vision map overlay unavailable' };
  const previous = typeof annotations.snapshot === 'function' ? annotations.snapshot() : [];
  const keep = previous.filter((entry) => entry?.source !== VISION_SOURCE);
  if (previous.length !== keep.length && typeof annotations.restore === 'function') await annotations.restore(keep);
  const specs = buildVisionAnnotations({ ...result, image }, { maxMarks: Math.min(maxDetections, 60) })
    .map((spec) => ({ ...spec, source: VISION_SOURCE }));
  if (!specs.length) return { ok: false, drawn: 0, skipped: Array.isArray(result.detections) ? result.detections.length : 0, error: 'No detections could be grounded on the map' };
  const resultOverlay = await annotations.annotate(specs, { persist: true });
  const skipped = Math.max(0, (Array.isArray(result.detections) ? result.detections.length : 0) - specs.length);
  return { ok: resultOverlay?.ok === true, drawn: resultOverlay?.drawn || 0, skipped, ids: resultOverlay?.ids || [] };
}

function clearVisionDetectionsFor(annotations) {
  if (!annotations?.snapshot || !annotations?.restore) return Promise.resolve({ ok: false });
  const current = annotations.snapshot();
  const keep = current.filter((entry) => entry?.source !== VISION_SOURCE);
  return current.length === keep.length ? Promise.resolve({ ok: true, removed: 0 })
    : annotations.restore(keep).then((ok) => ({ ok: Boolean(ok), removed: current.length - keep.length }));
}

/** Read loaded source records and restore actions through existing navigation ownership. */
export function createMapWorkspace({ viewer, styleManager, dataManager, runAction, annotations = null, now = Date.now }) {
  const buildingLayer = createBuildingPolygonLayer({
    viewer,
    overlay: { setEntries: setOverlayEntries, clear: clearOverlaySource },
  });
  const captureImage = (options) => captureViewportFrame(viewer, options);
  const getViewKey = () => viewportFrameKey(viewer);
  function cameraSnapshot() {
    const { positionWC, heading, pitch, roll } = viewer.camera;
    const camera = { position: { x: positionWC.x, y: positionWC.y, z: positionWC.z }, heading, pitch, roll };
    if (!validCamera(camera)) throw new Error('Camera unavailable');
    return camera;
  }

  function restoreCamera(camera) {
    if (!validCamera(camera) || typeof styleManager.runImmediateNavigation !== 'function') return { ok: false };
    let restored = false;
    styleManager.runImmediateNavigation('camera', () => {
      viewer.camera.setView({
        destination: new Cesium.Cartesian3(camera.position.x, camera.position.y, camera.position.z),
        orientation: { heading: camera.heading, pitch: camera.pitch, roll: camera.roll },
      });
      viewer.scene.requestRender?.();
      restored = true;
    });
    return { ok: restored };
  }

  function geographicBounds() {
    let bounds = null;
    try {
      const rectangle = viewer.camera.computeViewRectangle(viewer.scene.globe?.ellipsoid);
      bounds = rectangle ? normalizeBounds(Object.fromEntries(['west', 'south', 'east', 'north']
        .map((key) => [key, Cesium.Math.toDegrees(rectangle[key])]))) : null;
    } catch { /* A destroyed or sky-facing camera supplies no geographic evidence. */ }
    return bounds;
  }

  function getSnapshot() {
    const bounds = geographicBounds();
    return { bounds, generatedAt: now(), layers: dataManager.getAll()
      .map((layer) => layerSnapshot(layer, dataManager.layers.get(layer.id)?.module, bounds)) };
  }

  function getViewSnapshot() {
    const viewport = createViewportFilter(viewer);
    const bounds = geographicBounds();
    return { scope: 'viewport', viewport: viewport.metadata, bounds, generatedAt: now(), layers: dataManager.getAll()
      .map((layer) => layerSnapshot(layer, dataManager.layers.get(layer.id)?.module, bounds, viewport)) };
  }

  function terrainSamplePoints({ rows = 10, cols = 10 } = {}) {
    const bounds = geographicBounds();
    const canvas = viewer?.scene?.canvas;
    const width = Number(canvas?.clientWidth || canvas?.width || 0);
    const height = Number(canvas?.clientHeight || canvas?.height || 0);
    if (!width || !height || typeof viewer?.camera?.getPickRay !== 'function') return { bounds: null, rows: 0, cols: 0, points: [] };
    const safeRows = Math.max(5, Math.min(21, Number.isInteger(rows) ? rows : 10));
    const safeCols = Math.max(5, Math.min(21, Number.isInteger(cols) ? cols : 10));
    const points = [];
    for (let row = 0; row < safeRows; row += 1) {
      for (let col = 0; col < safeCols; col += 1) {
        const screenX = ((col + 0.5) / safeCols) * width;
        const screenY = ((row + 0.5) / safeRows) * height;
        let cartographic = null;
        try {
          const ray = viewer.camera.getPickRay(new Cesium.Cartesian2(screenX, screenY));
          const screen = new Cesium.Cartesian2(screenX, screenY);
          const hit = ray && viewer.scene.globe?.pick(ray, viewer.scene)
            || (typeof viewer.scene.pickPosition === 'function' ? viewer.scene.pickPosition(screen) : null);
          cartographic = hit ? Cesium.Cartographic.fromCartesian(hit) : null;
        } catch { cartographic = null; }
        points.push(cartographic ? { lat: Cesium.Math.toDegrees(cartographic.latitude), lon: Cesium.Math.toDegrees(cartographic.longitude) } : null);
      }
    }
    const located = points.filter(Boolean);
    const sampledBounds = located.length ? {
      west: Math.min(...located.map((point) => point.lon)), east: Math.max(...located.map((point) => point.lon)),
      south: Math.min(...located.map((point) => point.lat)), north: Math.max(...located.map((point) => point.lat)),
    } : bounds;
    return { bounds: sampledBounds, rows: safeRows, cols: safeCols, points, sampledBy: 'screen-pick' };
  }

  function projectBuildingPixel(x, y, image) {
    const canvas = viewer?.scene?.canvas;
    const width = Number(canvas?.clientWidth || canvas?.width || 0);
    const height = Number(canvas?.clientHeight || canvas?.height || 0);
    if (!width || !height || !image?.width || !image?.height) return null;
    const screen = new Cesium.Cartesian2((x / image.width) * width, (y / image.height) * height);
    try {
      const ray = viewer.camera.getPickRay(screen);
      const hit = ray && viewer.scene.globe?.pick(ray, viewer.scene)
        || (typeof viewer.scene.pickPosition === 'function' ? viewer.scene.pickPosition(screen) : null);
      if (!hit) return null;
      const cartographic = Cesium.Cartographic.fromCartesian(hit);
      return [Cesium.Math.toDegrees(cartographic.longitude), Cesium.Math.toDegrees(cartographic.latitude)];
    } catch { return null; }
  }

  async function analyzeTerrain({ rows = 10, cols = 10, signal } = {}) {
    const startedViewKey = (() => { try { return getViewKey(); } catch { return null; } })();
    const grid = terrainSamplePoints({ rows, cols });
    if (!grid.points.some(Boolean)) return { ok: false, error: 'TERRAIN_VIEW_UNAVAILABLE', ...grid };
    const fetcher = globalThis.fetch?.bind(globalThis);
    if (typeof fetcher !== 'function') return { ok: false, error: 'TERRAIN_FETCH_UNAVAILABLE', ...grid };
    const request = () => fetcher('/api/terrain/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ rows: grid.rows, cols: grid.cols, points: grid.points }),
    });
    let response = await request();
    // Terrain providers can transiently return 502 while their tile/cache
    // request is warming. One bounded retry materially improves the chat path
    // without hiding a persistent outage or allowing stale camera results.
    if (!response.ok && response.status >= 500 && !signal?.aborted) {
      await new Promise((resolve, reject) => {
        let onAbort;
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, 350);
        onAbort = () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      response = await request();
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error('Terrain analysis failed'), { status: response.status, payload });
    const currentViewKey = (() => { try { return getViewKey(); } catch { return startedViewKey; } })();
    return startedViewKey && currentViewKey && startedViewKey !== currentViewKey
      ? { ...payload, stale: true, staleReason: 'camera-changed-during-analysis' }
      : payload;
  }

  let terrainAnnotationIds = [];
  let comparisonAnnotationIds = [];
  async function clearTerrainAnalysis() {
    if (!terrainAnnotationIds.length || typeof annotations?.snapshot !== 'function' || typeof annotations?.restore !== 'function') return { ok: true, removed: 0 };
    const ids = new Set(terrainAnnotationIds);
    const keep = annotations.snapshot().filter((entry) => !ids.has(entry?.id));
    const ok = await annotations.restore(keep);
    if (ok) terrainAnnotationIds = [];
    return { ok: Boolean(ok), removed: ids.size };
  }

  async function drawTerrainAnalysis(result) {
    if (typeof annotations?.annotate !== 'function') return { ok: false, drawn: 0 };
    const root = result?.data && typeof result.data === 'object' ? { ...result, ...result.data } : result || {};
    const overlay = root.overlay || root.geometry || {};
    const areaBounds = root.bounds || root.viewport?.bounds || root.viewport;
    const ring = Array.isArray(overlay.ring) ? overlay.ring : Array.isArray(areaBounds)
      ? areaBounds : areaBounds && [areaBounds.west, areaBounds.south, areaBounds.east, areaBounds.north].every(Number.isFinite)
        ? [[areaBounds.west, areaBounds.south], [areaBounds.east, areaBounds.south], [areaBounds.east, areaBounds.north], [areaBounds.west, areaBounds.north]] : null;
    const cameraHeight = Number(viewer?.camera?.positionCartographic?.height);
    const profile = terrainDisplayProfile(cameraHeight);
    const specs = [];
    if (ring && ring.length >= 3) specs.push({ type: 'area', ring, label: '地形分析范围', color: 'cyan', source: 'terrain-analysis' });
    const contours = Array.isArray(overlay.contours) ? overlay.contours : Array.isArray(root.contours) ? root.contours : [];
    for (const [contourIndex, contour] of contours.slice(0, profile.contourLimit).entries()) {
      const segments = Array.isArray(contour?.segments) ? contour.segments : [Array.isArray(contour) ? contour : contour?.points];
      for (const segment of segments.slice(0, profile.segmentLimit)) {
        if (!Array.isArray(segment) || segment.length < 2) continue;
        const routePoints = segment.map((point) => {
          if (Array.isArray(point)) return { longitude: point[0], latitude: point[1] };
          return { longitude: point?.lon ?? point?.longitude, latitude: point?.lat ?? point?.latitude };
        }).filter((point) => Number.isFinite(point?.longitude) && Number.isFinite(point?.latitude));
        if (routePoints.length >= 2) {
          // Keep every other contour in the mid-distance band. Older marks
          // use the plain "contour" class; the renderer hides those sooner,
          // while newly-created primary lines remain as orientation cues.
          const visibilityClass = contourIndex % 2 === 0 ? 'contour-primary' : 'contour-secondary';
          // Contours are elevation isolines, not navigable routes. Their
          // renderer style is intentionally thin/dashed and subdued.
          specs.push({ type: 'route', points: routePoints, label: null, color: 'green', source: 'terrain-analysis', visibilityClass, suppressRouteMetrics: true });
        }
      }
    }
    const gridPoints = Array.isArray(root.grid?.points) ? root.grid.points : [];
    const gridValues = Array.isArray(root.grid?.values) ? root.grid.values : [];
    const gridSlopes = Array.isArray(root.grid?.slopes) ? root.grid.slopes : [];
    const asPoint = (point, index) => {
      if (Array.isArray(point)) return { longitude: point[0], latitude: point[1], heightM: gridValues[index] };
      return { longitude: point?.lon ?? point?.longitude, latitude: point?.lat ?? point?.latitude, heightM: point?.heightM ?? gridValues[index] };
    };
    // Preserve the source grid index while dropping missing samples so the
    // slope array remains aligned with its corresponding coordinate.
    const drawableGrid = gridPoints.map((point, index) => ({ ...asPoint(point, index), slope: gridSlopes[index], index }))
      .filter((point) => Number.isFinite(point?.heightM) && Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude));
    const extrema = drawableGrid.length > 1 ? [drawableGrid.reduce((a, b) => a.heightM < b.heightM ? a : b), drawableGrid.reduce((a, b) => a.heightM > b.heightM ? a : b)] : [];
    for (const [index, point] of extrema.entries()) {
      specs.push({ type: 'pin', longitude: point.longitude, latitude: point.latitude,
        label: `${index === 0 ? '最低点 ' : '最高点 '}${Math.round(point.heightM)} m`,
        color: index === 0 ? 'cyan' : 'red', source: 'terrain-analysis', terrainRole: index === 0 ? 'lowest' : 'highest' });
    }
    const unmarked = (point) => !specs.some((spec) => spec.type === 'pin'
      && Math.abs(spec.longitude - point.longitude) < 1e-6 && Math.abs(spec.latitude - point.latitude) < 1e-6);
    // Show representatives of all grades, not only the steepest samples.
    const perBand = Math.max(1, Math.floor(profile.slopeLimit / 4));
    const slopePoints = profile.showSlope ? ['green', 'cyan', 'amber', 'red'].flatMap((color) => drawableGrid
      .filter((point) => unmarked(point) && terrainSlopeColor(point.slope) === color).slice(0, perBand)) : [];
    for (const point of slopePoints) {
      const color = terrainSlopeColor(point.slope);
      specs.push({ type: 'pin', longitude: point.longitude, latitude: point.latitude, label: `坡度 ${Math.round(point.slope * 10) / 10}°`, color, source: 'terrain-analysis', visibilityClass: 'slope', terrainRole: 'slope' });
    }
    const features = root.features || {};
    for (const point of (Array.isArray(features.highPoints) ? features.highPoints : []).slice(0, profile.featureLimit)) {
      if (Number.isFinite(point?.lon) && Number.isFinite(point?.lat) && unmarked({longitude: point.lon, latitude: point.lat})) specs.push({ type: 'pin', longitude: point.lon, latitude: point.lat, label: `山脊 ${Math.round(point.elevation)} m`, color: 'amber', source: 'terrain-analysis', terrainRole: 'ridge' });
    }
    for (const point of (Array.isArray(features.lowPoints) ? features.lowPoints : []).slice(0, profile.featureLimit)) {
      if (Number.isFinite(point?.lon) && Number.isFinite(point?.lat) && unmarked({longitude: point.lon, latitude: point.lat})) specs.push({ type: 'pin', longitude: point.lon, latitude: point.lat, label: `谷地 ${Math.round(point.elevation)} m`, color: 'cyan', source: 'terrain-analysis', terrainRole: 'valley' });
    }
    const gridRows = Number(root.grid?.rows); const gridCols = Number(root.grid?.cols);
    const sampleCandidates = Number.isInteger(gridRows) && Number.isInteger(gridCols) && gridRows * gridCols === gridPoints.length
      ? selectTerrainEvidence(gridPoints.map((point, index) => drawableGrid.find((candidate) => candidate.index === index) || null), gridRows, gridCols, profile.sampleLimit)
      : drawableGrid.filter(unmarked).slice(0, profile.sampleLimit);
    if (profile.showSamples) for (const point of sampleCandidates.filter(unmarked)) {
      specs.push({ type: 'pin', longitude: point.longitude, latitude: point.latitude, label: null,
        color: terrainSlopeColor(point.slope), source: 'terrain-analysis', visibilityClass: 'sample', terrainRole: 'sample' });
    }
    if (!specs.length) return { ok: false, drawn: 0 };
    await clearTerrainAnalysis();
    const drawn = await annotations.annotate(specs, { persist: true });
    terrainAnnotationIds = Array.isArray(drawn?.ids) ? [...drawn.ids] : [];
    return drawn;
  }

  async function drawSnapshotComparison(comparison) {
    if (typeof annotations?.annotate !== 'function') return { ok: false, drawn: 0 };
    if (typeof annotations?.snapshot !== 'function' || typeof annotations?.restore !== 'function') return { ok: false, drawn: 0 };
    const prior = new Set(comparisonAnnotationIds);
    if (prior.size) {
      const keep = annotations.snapshot().filter((entry) => !prior.has(entry?.id));
      await annotations.restore(keep);
      comparisonAnnotationIds = [];
    }
    const specs = [];
    const point = (record, label, color) => {
      const latitude = Number(record?.latitude); const longitude = Number(record?.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return;
      specs.push({ type: 'pin', latitude, longitude, label, color, source: 'viewport-comparison' });
    };
    for (const layer of Array.isArray(comparison?.layers) ? comparison.layers : []) {
      for (const record of Array.isArray(layer.added) ? layer.added.slice(0, 100) : []) point(record, `新增 ${record.name || record.id || ''}`, 'green');
      for (const record of Array.isArray(layer.removed) ? layer.removed.slice(0, 100) : []) point(record, `消失 ${record.name || record.id || ''}`, 'red');
    }
    for (const item of Array.isArray(comparison?.moved) ? comparison.moved.slice(0, 200) : []) {
      const from = item?.from; const to = item?.to;
      if (![from?.latitude, from?.longitude, to?.latitude, to?.longitude].every(Number.isFinite)) continue;
      if (Math.abs(from.latitude) > 90 || Math.abs(to.latitude) > 90 || Math.abs(from.longitude) > 180 || Math.abs(to.longitude) > 180) continue;
      specs.push({ type: 'route', points: [{ latitude: from.latitude, longitude: from.longitude }, { latitude: to.latitude, longitude: to.longitude }], label: `移动 ${item.name || item.id || ''}`, color: 'amber', source: 'viewport-comparison' });
    }
    if (!specs.length) return { ok: true, drawn: 0 };
    const drawn = await annotations.annotate(specs, { persist: true });
    comparisonAnnotationIds = Array.isArray(drawn?.ids) ? [...drawn.ids] : [];
    return drawn;
  }

  function captureLayers(layerId) {
    const layers = dataManager.getAll();
    const target = layers.find((layer) => layer.id === layerId);
    const context = styleManager.getContextModeState?.();
    const coupled = CONTEXT_LAYERS.has(layerId) || context?.active || context?.mode || layers.some((layer) => layer.enabled && CONTEXT_LAYERS.has(layer.id));
    const busy = (layer) => layer?.lifecycleUncertain || ['enabling', 'disabling'].includes(layer?.lifecycleState);
    if (!target || busy(target) || context?.changing || context?.entering || (coupled && layers.some(busy))) throw new Error('Map layers are not settled');
    return {
      enabled: target.enabled === true, camera: cameraSnapshot(),
      ...(coupled ? {
        enabledLayerIds: layers.filter((layer) => layer.enabled).map((layer) => layer.id),
        contextMode: context?.mode || null, visual: visualSnapshot(styleManager),
      } : {}),
    };
  }

  function captureState(name, args) {
    if (CAMERA_ACTIONS.has(name)) return { camera: cameraSnapshot() };
    if (name === 'set_visual_style') return { style: styleManager.activeStyle || 'normal', visual: visualSnapshot(styleManager), celestialRing: styleManager.celestialRingEnabled };
    if (name === 'set_layer_visibility') return captureLayers(args.layerId);
    if (ANNOTATION_ACTIONS.has(name)) return {
      annotations: typeof annotations?.snapshot === 'function' ? annotations.snapshot() : [],
    };
    throw new Error('Unsupported map action');
  }

  async function restoreVisual(snapshot) {
    let result;
    if (!snapshot.visual) result = await runAction('set_visual_style', { style: snapshot.style });
    else {
      if (typeof styleManager.applyVisualState !== 'function') return { ok: false };
      result = { ok: await styleManager.applyVisualState(structuredClone(snapshot.visual)) === true };
    }
    if (!result?.ok) return { ok: false };
    if (typeof snapshot.celestialRing === 'boolean') {
      if (typeof styleManager.setCelestialRingEnabled !== 'function') return { ok: false };
      return styleManager.setCelestialRingEnabled(snapshot.celestialRing, { focus: false });
    }
    return result;
  }

  async function restoreLayers(snapshot, args) {
    if (!validCamera(snapshot.camera) || typeof styleManager.runImmediateNavigation !== 'function') return { ok: false };
    if (snapshot.enabledLayerIds) {
      if (typeof styleManager.setContextMode !== 'function' || typeof dataManager.restoreEnabledLayerIds !== 'function') return { ok: false };
      const context = await styleManager.setContextMode(snapshot.contextMode, { claimVisualAuthority: true });
      if (!context?.ok) return { ok: false };
      await styleManager._waitForContextLayerSettlement?.();
      await dataManager.restoreEnabledLayerIds(snapshot.enabledLayerIds, { origin: 'context-restore' });
      await styleManager._waitForContextLayerSettlement?.();
      if (snapshot.visual && !(await restoreVisual(snapshot)).ok) return { ok: false };
    } else {
      const result = await runAction('set_layer_visibility', { layerId: args.layerId, enabled: snapshot.enabled });
      if (!result?.ok) return { ok: false };
      await styleManager._waitForContextLayerSettlement?.();
    }
    return restoreCamera(snapshot.camera);
  }

  async function restoreState(snapshot, name, args) {
    if (!snapshot) return { ok: false };
    if (CAMERA_ACTIONS.has(name)) return restoreCamera(snapshot.camera);
    if (name === 'set_visual_style') return restoreVisual(snapshot);
    if (name === 'set_layer_visibility') return restoreLayers(snapshot, args);
    if (ANNOTATION_ACTIONS.has(name)) {
      if (typeof annotations?.restore !== 'function') return { ok: false };
      return { ok: await annotations.restore(snapshot.annotations || []) };
    }
    return { ok: false };
  }

  async function drawBuildingPolygons(result, image, options = {}) {
    if (!result || !image) return { ok: false, code: 'BUILDINGS_CAPTURE_UNAVAILABLE' };
    if (options.signal?.aborted || options.isCurrent?.() === false) return { ok: false, code: 'BUILDINGS_CANCELLED' };
    const drawn = await buildingLayer.replace(result, {
      projectPixel: (x, y) => projectBuildingPixel(x, y, image),
    });
    if (options.signal?.aborted || options.isCurrent?.() === false) {
      if (drawn?.ok) buildingLayer.clear();
      return { ok: false, code: 'BUILDINGS_CANCELLED' };
    }
    return drawn;
  }

  return Object.freeze({ getSnapshot, getViewSnapshot, captureState, restoreState, captureImage, getViewKey, analyzeTerrain, drawTerrainAnalysis, clearTerrainAnalysis, drawSnapshotComparison,
    drawVisionDetections: (result, image, options) => drawVisionDetectionsFor(viewer, annotations, result, image, options),
    clearVisionDetections: () => clearVisionDetectionsFor(annotations), drawBuildingPolygons,
    clearBuildingPolygons: () => buildingLayer.clear(),
  });
}
