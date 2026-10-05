import * as Cesium from 'cesium';
import { resolveOsmFeatureText } from './osmFeatureText.js';

export const OSM_THEME_COLORS = Object.freeze({
  addresses: '#ffffff', buildings: '#ffc247', roads: '#ff73ac', settlements: '#b9e6ff',
  water: '#39baff', green: '#6ee583', pois: '#e2b1ff',
});
const LABEL_LIMITS = Object.freeze({ addresses: 12, buildings: 28, roads: 24, settlements: 10, water: 10, green: 12, pois: 24 });
const valueAt = (property, time) => property?.getValue ? property.getValue(time) : property;

function entityAnchor(entity, time) {
  const point = valueAt(entity.position, time);
  if (Number.isFinite(point?.x)) return Cesium.Cartographic.fromCartesian(point);
  const ring = valueAt(entity.polygon?.hierarchy, time)?.positions;
  const line = valueAt(entity.polyline?.positions, time);
  if (ring?.length) return Cesium.Cartographic.fromCartesian(Cesium.BoundingSphere.fromPoints(ring).center);
  if (line?.length) return Cesium.Cartographic.fromCartesian(line[Math.floor(line.length / 2)]);
  return null;
}

function outlinePolygon(source, entity, color, time) {
  const hierarchy = valueAt(entity.polygon?.hierarchy, time);
  if (!hierarchy?.positions?.length || !source.entities.add) return;
  const rings = [hierarchy.positions, ...(hierarchy.holes || []).map((hole) => hole.positions)];
  rings.forEach((ring, index) => {
    if (!ring?.length) return;
    source.entities.add({
      id: `${entity.id}:osm-outline:${index}`,
      polyline: { positions: [...ring, ring[0]], width: 2.5, clampToGround: true,
        material: new Cesium.ColorMaterialProperty(color) },
    });
  });
}

export function styleOsmSource(source, theme) {
  const time = Cesium.JulianDate.now();
  const color = Cesium.Color.fromCssColorString(OSM_THEME_COLORS[theme.id]);
  return [...source.entities.values].flatMap((entity, index) => {
    if (entity.polygon) {
      entity.polygon.material = new Cesium.ColorMaterialProperty(color.withAlpha(theme.id === 'buildings' ? 0.52 : 0.28));
      // Ground polygon outlines are unsupported; the separate polyline supplies the building edge.
      entity.polygon.outline = false;
      entity.polygon.outlineColor = color;
      if (theme.id === 'buildings') outlinePolygon(source, entity, color, time);
    }
    if (entity.position) {
      entity.billboard = undefined;
      entity.point = new Cesium.PointGraphics({
        pixelSize: ['settlements', 'pois'].includes(theme.id) ? 8 : 5,
        color, outlineColor: Cesium.Color.BLACK, outlineWidth: 1.5,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    const anchor = entityAnchor(entity, time);
    if (!anchor) return [];
    const properties = valueAt(entity.properties, time) || {};
    return [{ id: String(entity.id ?? index), theme: theme.id, entity, properties,
      longitude: Cesium.Math.toDegrees(anchor.longitude), latitude: Cesium.Math.toDegrees(anchor.latitude) }];
  });
}

export function buildOsmOverlayEntries(records, {
  locale = 'zh-CN', viewer, selectedId = null, onSelect = () => {},
} = {}) {
  const camera = viewer?.camera?.positionCartographic;
  const score = (record) => {
    const text = resolveOsmFeatureText(record.properties, { locale, theme: record.theme });
    const distance = camera ? Math.hypot(record.longitude - Cesium.Math.toDegrees(camera.longitude),
      record.latitude - Cesium.Math.toDegrees(camera.latitude)) : 0;
    return (record.id === selectedId ? 1000 : 0) + (text.hasChineseName ? 100 : 0) + (text.rawName ? 20 : 0) - distance;
  };
  const candidates = Object.keys(LABEL_LIMITS).flatMap((theme) => records.filter((record) => record.theme === theme)
    .map((record) => ({ record, score: score(record) })).sort((a, b) => b.score - a.score)
    .slice(0, LABEL_LIMITS[theme]));
  return candidates.slice(0, 120).map(({ record, score: priority }) => {
    const text = resolveOsmFeatureText(record.properties, { locale, theme: record.theme });
    const selected = record.id === selectedId;
    const carto = Cesium.Cartographic.fromDegrees(record.longitude, record.latitude);
    const height = viewer?.scene?.globe?.getHeight?.(carto) || 0;
    return {
      id: record.id, position: Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude, height + 5),
      title: text.title, details: selected ? text.details : [],
      variant: selected ? 'card' : 'label', selected,
      accent: OSM_THEME_COLORS[record.theme], priority,
      collisionGroup: 'ambient-label', paintLane: selected ? 'selected' : 'ambient-label',
      interactive: true, accessibilityLabel: text.title,
      activate: () => onSelect(record),
      maxDistance: ['addresses', 'buildings'].includes(record.theme) ? 12000 : 35000,
      distanceFadeStartRatio: 0.9, distanceScale: { near: 500, nearValue: 1.15, far: 18000, farValue: 1 },
      horizonCull: true, terrainOcclusion: false, edgeFade: 'none',
      gapPx: 8, placement: 'above', minAnchorSeparationPx: 48,
    };
  });
}
