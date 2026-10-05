// The same numeric bands drive the route segments, sample points and legend.
export const SLOPE_BANDS = Object.freeze([
  Object.freeze({ key: 'green', color: '#5dff9f', range: '0-8\u00b0' }),
  Object.freeze({ key: 'cyan', color: '#39d0ff', range: '8-15\u00b0' }),
  Object.freeze({ key: 'amber', color: '#ffb547', range: '15-30\u00b0' }),
  Object.freeze({ key: 'red', color: '#ff6b6b', range: '30-90\u00b0' }),
]);
const UNKNOWN = Object.freeze({ key: 'unknown', color: '#a6b3b9', range: '' });

export function slopeBand(value) {
  if (!Number.isFinite(value) || value < 0 || value > 90) return UNKNOWN;
  return SLOPE_BANDS[value < 8 ? 0 : value < 15 ? 1 : value < 30 ? 2 : 3];
}

export const terrainRouteColor = (slopeDeg) => slopeBand(slopeDeg).color;

const POINT_ROLES = new Set(['highest', 'lowest', 'ridge', 'valley', 'sample', 'slope']);
export function terrainRole(anno) {
  if (anno?.source !== 'terrain-analysis') return null;
  const role = anno.terrainRole || anno.visibilityClass;
  return POINT_ROLES.has(role) ? role : null;
}

export function terrainDetailVisible(anno, cameraHeight) {
  if (anno?.source !== 'terrain-analysis' || !Number.isFinite(cameraHeight)) return true;
  const detail = anno.visibilityClass;
  // Pins are direct observations or extrema selected from the sampled grid.
  // They remain visible at every zoom; only interpolated contour detail fades.
  if (['contour', 'contour-secondary'].includes(detail)) return cameraHeight < 12_000;
  if (detail === 'contour-primary') return cameraHeight < 30_000;
  return true;
}
