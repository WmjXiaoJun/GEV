/**
 * Bounded terrain route planning and nearby-entity association helpers.
 *
 * The planner works only with a terrain-analysis grid returned by the local
 * terrain service. It never geocodes names or invents coordinates; callers
 * must provide WGS84 coordinates and a grid containing usable elevations.
 */

const EARTH_RADIUS_M = 6_371_008.8;
const MAX_GRID_CELLS = 31 * 31;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function coordinate(value, name = 'coordinate') {
  const longitude = Array.isArray(value) ? Number(value[0]) : Number(value?.longitude ?? value?.lon);
  const latitude = Array.isArray(value) ? Number(value[1]) : Number(value?.latitude ?? value?.lat);
  if (!finite(longitude) || !finite(latitude)
    || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    throw new Error(`invalid ${name}`);
  }
  return { longitude, latitude };
}

/** Great-circle distance in metres (safe for antimeridian coordinates). */
export function haversineDistanceM(a, b) {
  const first = coordinate(a, 'first coordinate');
  const second = coordinate(b, 'second coordinate');
  const lat1 = first.latitude * Math.PI / 180;
  const lat2 = second.latitude * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = (second.longitude - first.longitude) * Math.PI / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.hypot(sinLat, Math.cos(lat1) * sinLon)));
}

/**
 * Split a planned path into drawable segments with their local slope. Keeping
 * this metadata alongside the route lets the map render gentle/steep sections
 * in different colors without implying that the entire route has one grade.
 */
export function terrainRouteSegments(points) {
  if (!Array.isArray(points) || points.length < 2) return [];
  return points.slice(1).map((to, index) => {
    const from = points[index];
    const distanceM = haversineDistanceM(from, to);
    const slopeDeg = finite(to?.elevation) && finite(from?.elevation) && distanceM > 0
      ? Math.atan2(Math.abs(to.elevation - from.elevation), distanceM) * 180 / Math.PI
      : null;
    return {
      from: { longitude: from.longitude, latitude: from.latitude, elevation: from.elevation },
      to: { longitude: to.longitude, latitude: to.latitude, elevation: to.elevation },
      distanceM: Math.round(distanceM * 100) / 100,
      slopeDeg: Number.isFinite(slopeDeg) ? Math.round(slopeDeg * 100) / 100 : null,
    };
  });
}

// Restore numerical evidence from the local plan, not from model-generated
// measurements. Only an exact coordinate sequence identifies that plan.
export function restorePlannedRouteGrades(args, plan) {
  if (!plan?.feasible || !Array.isArray(plan.points) || !Array.isArray(args?.annotations)) return args;
  return { ...args, annotations: args.annotations.map((mark) => {
    const matches = mark?.type === 'route' && Array.isArray(mark.points) && mark.points.length === plan.points.length
      && mark.points.every((point, index) => Number.isFinite(point?.longitude) && Number.isFinite(point?.latitude)
        && Math.abs(point.longitude - plan.points[index].longitude) < 1e-7 && Math.abs(point.latitude - plan.points[index].latitude) < 1e-7);
    return matches ? {...mark, source: 'terrain-route', points: plan.points.map((point) => ({...point}))} : mark;
  }) };
}

function normalizeGrid(result) {
  const grid = result?.grid ?? result;
  if (!grid || typeof grid !== 'object' || Array.isArray(grid)) throw new Error('terrain grid is required');
  const rows = Number(grid.rows);
  const cols = Number(grid.cols);
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 3 || cols < 3
    || rows * cols > MAX_GRID_CELLS) throw new Error('terrain grid dimensions are invalid');
  if (!Array.isArray(grid.points) || grid.points.length !== rows * cols
    || !Array.isArray(grid.values) || grid.values.length !== rows * cols) {
    throw new Error('terrain grid points and values must have matching dimensions');
  }
  const points = grid.points.map((point) => (point == null ? null : coordinate(point, 'terrain point')));
  const values = grid.values.map((value) => (finite(value) ? value : null));
  if (!points.some(Boolean) || !values.some((value, index) => value !== null && points[index])) {
    throw new Error('terrain grid contains no usable elevation');
  }
  return { rows, cols, points, values };
}

function indexDistance(points, from) {
  let best = -1;
  let bestDistance = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    if (!points[index]) continue;
    const distance = haversineDistanceM(from, points[index]);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

function neighbors(index, rows, cols) {
  const row = Math.floor(index / cols);
  const col = index % cols;
  const output = [];
  for (let rowDelta = -1; rowDelta <= 1; rowDelta += 1) {
    for (let colDelta = -1; colDelta <= 1; colDelta += 1) {
      if (rowDelta === 0 && colDelta === 0) continue;
      const nextRow = row + rowDelta;
      const nextCol = col + colDelta;
      if (nextRow >= 0 && nextRow < rows && nextCol >= 0 && nextCol < cols) {
        output.push(nextRow * cols + nextCol);
      }
    }
  }
  return output;
}

function shortestPath(grid, startIndex, endIndex, maxSlopeDeg, slopePenalty) {
  const { rows, cols, points, values } = grid;
  const distances = Array(rows * cols).fill(Infinity);
  const previous = Array(rows * cols).fill(-1);
  const visited = new Set();
  distances[startIndex] = 0;
  while (visited.size < rows * cols) {
    let current = -1;
    let currentCost = Infinity;
    for (let index = 0; index < distances.length; index += 1) {
      if (!visited.has(index) && distances[index] < currentCost) {
        current = index;
        currentCost = distances[index];
      }
    }
    if (current < 0 || current === endIndex) break;
    visited.add(current);
    for (const next of neighbors(current, rows, cols)) {
      if (visited.has(next) || !points[next] || values[current] === null || values[next] === null) continue;
      const distanceM = haversineDistanceM(points[current], points[next]);
      if (!distanceM) continue;
      const slopeDeg = Math.atan2(Math.abs(values[next] - values[current]), distanceM) * 180 / Math.PI;
      if (slopeDeg > maxSlopeDeg) continue;
      const cost = distanceM * (1 + slopePenalty * (slopeDeg / Math.max(1, maxSlopeDeg)));
      const nextCost = currentCost + cost;
      if (nextCost < distances[next]) {
        distances[next] = nextCost;
        previous[next] = current;
      }
    }
  }
  if (startIndex !== endIndex && previous[endIndex] < 0) return null;
  const indexes = [];
  for (let current = endIndex; current >= 0; current = previous[current]) {
    indexes.unshift(current);
    if (current === startIndex) break;
  }
  return indexes[0] === startIndex ? indexes : null;
}

/**
 * Plan a low-slope route over a sampled terrain grid.
 * Returns null only when no traversable path exists; malformed input throws.
 */
export function planTerrainRoute(terrainResult, start, end, options = {}) {
  const grid = normalizeGrid(terrainResult);
  const from = coordinate(start, 'route start');
  const to = coordinate(end, 'route end');
  const bounds = terrainResult?.viewport?.bounds ?? terrainResult?.bounds;
  const insideBounds = (point) => {
    if (!bounds) return true;
    if (![bounds.west, bounds.east, bounds.south, bounds.north].every(finite)) return false;
    const longitudeInside = bounds.west <= bounds.east
      ? point.longitude >= bounds.west && point.longitude <= bounds.east
      : point.longitude >= bounds.west || point.longitude <= bounds.east;
    return longitudeInside && point.latitude >= bounds.south && point.latitude <= bounds.north;
  };
  if (!insideBounds(from) || !insideBounds(to)) {
    return { feasible: false, reason: 'route endpoint outside sampled viewport', points: [], stats: null };
  }
  const maxSlopeDeg = Number(options.maxSlopeDeg ?? 35);
  const slopePenalty = Number(options.slopePenalty ?? 3);
  if (!finite(maxSlopeDeg) || maxSlopeDeg <= 0 || maxSlopeDeg > 89) throw new Error('invalid maxSlopeDeg');
  if (!finite(slopePenalty) || slopePenalty < 0 || slopePenalty > 20) throw new Error('invalid slopePenalty');
  const startIndex = indexDistance(grid.points, from);
  const endIndex = indexDistance(grid.points, to);
  const indexes = shortestPath(grid, startIndex, endIndex, maxSlopeDeg, slopePenalty);
  if (!indexes) return { feasible: false, reason: 'no traversable path in sampled terrain', points: [], stats: null };
  const points = indexes.map((index) => ({
    longitude: grid.points[index].longitude,
    latitude: grid.points[index].latitude,
    elevation: grid.values[index],
  }));
  const segments = terrainRouteSegments(points);
  const annotatedPoints = points.map((point, index) => index === 0
    ? { ...point, slopeDeg: 0 }
    : { ...point, slopeDeg: segments[index - 1]?.slopeDeg ?? 0 });
  let distanceM = 0;
  let ascentM = 0;
  let descentM = 0;
  let maxSlope = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = annotatedPoints[index - 1];
    const current = annotatedPoints[index];
    const segmentDistance = haversineDistanceM(previous, current);
    const elevationDelta = current.elevation - previous.elevation;
    const slopeDeg = Math.atan2(Math.abs(elevationDelta), Math.max(1, segmentDistance)) * 180 / Math.PI;
    distanceM += segmentDistance;
    if (elevationDelta > 0) ascentM += elevationDelta;
    else descentM += Math.abs(elevationDelta);
    maxSlope = Math.max(maxSlope, slopeDeg);
  }
  return {
    feasible: true,
    points: annotatedPoints,
    segments,
    snappedStart: annotatedPoints[0],
    snappedEnd: annotatedPoints.at(-1),
    stats: {
      distanceM: Math.round(distanceM * 100) / 100,
      ascentM: Math.round(ascentM * 100) / 100,
      descentM: Math.round(descentM * 100) / 100,
      maxSlopeDeg: Math.round(maxSlope * 100) / 100,
      pointCount: annotatedPoints.length,
    },
  };
}

function entityCoordinate(entity) {
  try {
    return coordinate(entity, 'entity coordinate');
  } catch {
    return null;
  }
}

/**
 * Associate map entities with named locations (airports, targets, etc.) by
 * distance. Unknown or malformed entities are ignored rather than inferred.
 */
export function associateNearbyEntities(locations, entities, options = {}) {
  if (!Array.isArray(locations) || !Array.isArray(entities)) throw new Error('locations and entities must be arrays');
  const radiusM = Number(options.radiusM ?? 5_000);
  if (!finite(radiusM) || radiusM < 0 || radiusM > 1_000_000) throw new Error('invalid association radius');
  return locations.map((location, locationIndex) => {
    const locationPoint = entityCoordinate(location);
    if (!locationPoint) return { locationIndex, locationId: location?.id ?? null, matches: [] };
    const matches = entities.flatMap((entity, entityIndex) => {
      const entityPoint = entityCoordinate(entity);
      if (!entityPoint) return [];
      const distanceM = haversineDistanceM(locationPoint, entityPoint);
      if (distanceM > radiusM) return [];
      return [{
        entityIndex,
        entityId: entity?.id ?? null,
        kind: typeof entity?.kind === 'string' ? entity.kind.slice(0, 80) : null,
        label: typeof entity?.label === 'string' ? entity.label.slice(0, 160) : null,
        distanceM: Math.round(distanceM * 100) / 100,
      }];
    }).sort((a, b) => a.distanceM - b.distanceM);
    return { locationIndex, locationId: location?.id ?? null, matches };
  });
}
