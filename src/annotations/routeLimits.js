export const MAX_EXPLICIT_ROUTE_POINTS = 512;
export const MAX_NAMED_ROUTE_POINTS = 12;

/** Larger paths are safe only when no point can trigger named resolution. */
export function routePointLimit(points) {
  const explicit = Array.isArray(points) && points.every((point) => point && typeof point === 'object'
    && !point.target && !point.name && Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
    && point.latitude >= -90 && point.latitude <= 90 && point.longitude >= -180 && point.longitude <= 180);
  return explicit ? MAX_EXPLICIT_ROUTE_POINTS : MAX_NAMED_ROUTE_POINTS;
}
