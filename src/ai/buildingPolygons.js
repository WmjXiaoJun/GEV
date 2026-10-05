import * as Cesium from 'cesium';
import { clearOverlaySource, setOverlayEntries } from '../overlays/worldOverlay.js';

const MAX_MODEL = 120;
const MAX_POLYGONS = 500;
// Segmentation masks can contain substantially more contour points than the
// old 64 point cap. Keep the full detail through normalization; the local
// vision runtime already bounds individual masks at 256 vertices.
const MAX_VERTICES = 256;
export const BUILDING_POLYGON_SOURCE_ID = 'vision-buildings';
export const BUILDING_POLYGON_COLOR = '#35edff';
const SOURCE_ID = BUILDING_POLYGON_SOURCE_ID;
const COLOR = BUILDING_POLYGON_COLOR;
const fail = (code) => ({ ok: false, code });

const finitePair = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const between = (a, b, c) => Math.min(a, c) - 1e-10 <= b && b <= Math.max(a, c) + 1e-10;
const onSegment = (a, b, c) => Math.abs(cross(a, b, c)) <= 1e-10
  && between(a[0], b[0], c[0]) && between(a[1], b[1], c[1]);
function segmentsCross(a, b, c, d) {
  const ab = cross(a, b, c); const ab2 = cross(a, b, d);
  const cd = cross(c, d, a); const cd2 = cross(c, d, b);
  if (Math.abs(ab) <= 1e-10 && onSegment(a, c, b)) return true;
  if (Math.abs(ab2) <= 1e-10 && onSegment(a, d, b)) return true;
  if (Math.abs(cd) <= 1e-10 && onSegment(c, a, d)) return true;
  if (Math.abs(cd2) <= 1e-10 && onSegment(c, b, d)) return true;
  return ((ab > 0) !== (ab2 > 0)) && ((cd > 0) !== (cd2 > 0));
}

function simpleRing(points, width, height) {
  if (!Array.isArray(points) || points.length < 3 || points.length > MAX_VERTICES + 1) return null;
  const ring = points.map((p) => (finitePair(p) ? [p[0], p[1]] : null));
  if (ring.some((p) => !p) || ring.some(([x, y]) => x < 0 || y < 0 || x > width || y > height)) return null;
  if (ring.length > 3 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring.pop();
  if (ring.length < 3 || ring.length > MAX_VERTICES) return null;
  if (ring.some((p, i) => ring.some((q, j) => i < j && p[0] === q[0] && p[1] === q[1]))) return null;
  const origin = ring[0];
  let area2 = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]; const b = ring[(i + 1) % ring.length];
    area2 += (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
    const c = ring[(i + 2) % ring.length];
    if (Math.abs(cross(a, b, c)) <= 1e-10 && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < -1e-10) return null;
  }
  if (Math.abs(area2) <= 1e-8) return null;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]; const b = ring[(i + 1) % ring.length];
    for (let j = i + 1; j < ring.length; j += 1) {
      if (j === i || j === (i + 1) % ring.length || i === (j + 1) % ring.length) continue;
      if (segmentsCross(a, b, ring[j], ring[(j + 1) % ring.length])) return null;
    }
  }
  return ring;
}

function validConfidence(value) { return value === null || (Number.isFinite(value) && value >= 0 && value <= 1) ? value : undefined; }

export function normalizeBuildingResult(payload) {
  const image = payload?.image;
  if (payload?.ok !== true || payload.task !== 'buildings' || typeof payload.model !== 'string'
    || payload.model.length === 0 || payload.model.length > MAX_MODEL || /[\u0000-\u001f\u007f]|\\[nr]/.test(payload.model)
    || !image || !Number.isInteger(image.width) || !Number.isInteger(image.height)
    || image.width < 1 || image.height < 1 || image.width > 4096 || image.height > 4096
    || !Array.isArray(payload.polygons) || payload.polygons.length > MAX_POLYGONS) return fail('BUILDINGS_INVALID_RESPONSE');
  const polygons = []; let rejectedCount = 0;
  for (const item of payload.polygons) {
    const confidence = validConfidence(item?.confidence);
    const points = simpleRing(item?.points, image.width, image.height);
    if (!points || confidence === undefined) { rejectedCount += 1; continue; }
    polygons.push({ points: points.map((p) => [...p]), confidence });
  }
  return { ok: true, task: 'buildings', model: payload.model, image: { width: image.width, height: image.height },
    polygons, rejectedCount, truncated: payload.truncated === true };
}

function geoRing(coords) {
  if (!Array.isArray(coords) || coords.length < 3) return false;
  for (let i = 0; i < coords.length; i += 1) {
    const [lon, lat] = coords[i];
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) return false;
    const next = coords[(i + 1) % coords.length];
    if (Math.abs(next[0] - lon) > 180) return false;
  }
  // simpleRing uses a non-negative pixel frame; shift geographic coordinates
  // into an equivalent bounded frame before applying the same topology checks.
  return !!simpleRing(coords.map(([lon, lat]) => [lon + 180, lat + 90]), 360, 180);
}

export function projectBuildingPolygons(payload, projectPixel) {
  if (typeof projectPixel !== 'function') return fail('BUILDINGS_PROJECTION_UNAVAILABLE');
  const normalized = normalizeBuildingResult(payload);
  if (!normalized.ok) return normalized;
  const polygons = []; let rejectedCount = normalized.rejectedCount;
  for (const item of normalized.polygons) {
    let coordinates; try { coordinates = item.points.map((point) => projectPixel(point[0], point[1])); } catch { coordinates = null; }
    if (!coordinates || coordinates.length !== item.points.length || !coordinates.every(finitePair) || !geoRing(coordinates)) {
      rejectedCount += 1; continue;
    }
    polygons.push({ id: `${SOURCE_ID}-${polygons.length + 1}`, label: `影像建筑 ${polygons.length + 1}`,
      pixelPoints: item.points.map((p) => [...p]), coordinates: coordinates.map((p) => [...p]), confidence: item.confidence, model: normalized.model });
  }
  return { ok: true, task: 'buildings', model: normalized.model, image: normalized.image, polygons, rejectedCount, truncated: normalized.truncated };
}

export function buildBuildingOverlayEntries(polygons, { onSelect = () => {} } = {}) {
  if (!Array.isArray(polygons)) return [];
  return polygons.slice(0, 60).map((item) => ({ id: item.id, title: item.label, details: [],
    position: Cesium.Cartesian3.fromDegrees(item.coordinates.reduce((sum, p) => sum + p[0], 0) / item.coordinates.length,
      item.coordinates.reduce((sum, p) => sum + p[1], 0) / item.coordinates.length),
    variant: 'label', selected: false, accent: COLOR, priority: item.confidence == null ? 0 : item.confidence,
    collisionGroup: 'ambient-label', paintLane: 'ambient-label', interactive: true, accessibilityLabel: item.label,
    activate: () => onSelect(item), maxDistance: 20000, distanceFadeStartRatio: 0.9,
    gapPx: 8, placement: 'above', minAnchorSeparationPx: 48 }));
}

export function createBuildingPolygonLayer({ viewer, overlay = { setEntries, clear: clearOverlaySource }, sourceId = SOURCE_ID } = {}) {
  let currentSource = null; let records = []; let generation = 0; let destroyed = false; let captureCount = 0;
  const remove = (source) => { if (source && viewer?.dataSources?.remove) viewer.dataSources.remove(source, true); };
  const clear = () => { generation += 1; remove(currentSource); currentSource = null; records = []; overlay.clear?.(sourceId); viewer?.scene?.requestRender?.(); };
  const replace = async (payload, { projectPixel, onSelect } = {}) => {
    if (destroyed) return fail('BUILDINGS_DESTROYED');
    if (typeof viewer?.dataSources?.add !== 'function') return fail('BUILDINGS_LAYER_UNAVAILABLE');
    const projected = projectBuildingPolygons(payload, projectPixel);
    if (!projected.ok) return projected;
    if (projected.polygons.length === 0) {
      clear();
      return projected;
    }
    const token = ++generation;
    const source = new Cesium.CustomDataSource(sourceId);
    source.show = captureCount === 0;
    for (const item of projected.polygons) {
      const positions = item.coordinates.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
      const closed = [...positions, positions[0]];
      source.entities.add({ id: item.id, name: item.label, properties: { model: item.model, confidence: item.confidence },
        polygon: { hierarchy: positions, material: Cesium.Color.fromCssColorString(COLOR).withAlpha(0.14), outline: false,
          perPositionHeight: false, heightReference: Cesium.HeightReference.CLAMP_TO_GROUND },
        polyline: { positions: closed, width: 3, clampToGround: true, material: Cesium.Color.fromCssColorString(COLOR) } });
    }
    try { await viewer?.dataSources?.add(source); } catch { return fail('BUILDINGS_LAYER_UNAVAILABLE'); }
    if (destroyed || token !== generation) { remove(source); return fail('BUILDINGS_CANCELLED'); }
    const previous = currentSource; currentSource = source; records = projected.polygons.map((p) => ({ ...p, pixelPoints: p.pixelPoints.map((v) => [...v]), coordinates: p.coordinates.map((v) => [...v]) }));
    remove(previous); overlay.setEntries?.(sourceId, buildBuildingOverlayEntries(records, { onSelect })); viewer?.scene?.requestRender?.();
    return projected;
  };
  const beginCapture = () => {
    captureCount += 1;
    if (currentSource) currentSource.show = false;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      captureCount = Math.max(0, captureCount - 1);
      if (captureCount === 0 && currentSource) currentSource.show = true;
    };
  };
  return { replace, clear, beginCapture, destroy: () => { clear(); destroyed = true; },
    getRecords: () => records.map((r) => ({ ...r, pixelPoints: r.pixelPoints.map((p) => [...p]), coordinates: r.coordinates.map((p) => [...p]) })) };
}
