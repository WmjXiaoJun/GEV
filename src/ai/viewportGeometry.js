import * as Cesium from 'cesium';

const finiteVector = (value) => value && [value.x, value.y, value.z].every(Number.isFinite);

export function hasGeographicAnchor(record) {
  const lat = record?.lat ?? record?.latitude;
  const lon = record?.lon ?? record?.longitude;
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** Count geographic anchors, independently of label decluttering and sprite visibility. */
export function createViewportFilter(viewer) {
  const base = { method: 'camera-frustum-and-ellipsoid', geometry: 'record-anchor', available: false };
  try {
    const scene = viewer?.scene;
    const camera = viewer?.camera;
    const width = scene?.canvas?.clientWidth;
    const height = scene?.canvas?.clientHeight;
    if (!camera || !scene || scene.camera !== camera || scene.mode !== Cesium.SceneMode.SCENE3D || scene.frameState?.mode !== Cesium.SceneMode.SCENE3D) {
      return { metadata: { ...base, reason: 'camera-unavailable' }, contains: () => false };
    }
    if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
      return { metadata: { ...base, reason: 'canvas-unavailable' }, contains: () => false };
    }
    const position = Cesium.Cartesian3.clone(camera.positionWC);
    const direction = Cesium.Cartesian3.clone(camera.directionWC);
    const { near, far, projectionMatrix } = camera.frustum || {};
    if (!finiteVector(position) || !finiteVector(direction) || Cesium.Cartesian3.magnitudeSquared(direction) === 0 ||
      ![near, far].every(Number.isFinite) || near < 0 || far <= near || !camera.viewMatrix || !projectionMatrix) {
      return { metadata: { ...base, reason: 'camera-unavailable' }, contains: () => false };
    }
    const ellipsoid = scene.globe?.ellipsoid || scene.ellipsoid || Cesium.Ellipsoid.WGS84;
    const occluder = new Cesium.EllipsoidalOccluder(ellipsoid, position);
    return {
      metadata: { ...base, available: true, width, height, reason: null },
      contains(record) {
        if (!hasGeographicAnchor(record)) return false;
        const lat = record.lat ?? record.latitude;
        const lon = record.lon ?? record.longitude;
        const world = Cesium.Cartesian3.fromDegrees(lon, lat, 0, ellipsoid);
        if (!occluder.isPointVisible(world)) return false;
        const offset = Cesium.Cartesian3.subtract(world, position, new Cesium.Cartesian3());
        const distance = Cesium.Cartesian3.dot(offset, direction);
        if (distance < near || distance > far) return false;
        const screen = Cesium.SceneTransforms.worldToWindowCoordinates(scene, world);
        return Boolean(screen && Number.isFinite(screen.x) && Number.isFinite(screen.y) &&
          screen.x >= 0 && screen.x <= width && screen.y >= 0 && screen.y <= height);
      },
    };
  } catch {
    return { metadata: { ...base, reason: 'camera-unavailable' }, contains: () => false };
  }
}
