/**
 * Viewport terrain analysis helpers.
 *
 * These functions are deliberately independent of Cesium and network state so
 * the server route and the browser can rely on the same bounded result shape.
 */

const MAX_GRID_SIDE = 31;
const MIN_GRID_SIDE = 3;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate and normalize a WGS84 viewport analysis request. */
export function normalizeTerrainViewport(input = {}) {
  const west = Number(input.west);
  const south = Number(input.south);
  const east = Number(input.east);
  const north = Number(input.north);
  const cols = Number(input.cols ?? 15);
  const rows = Number(input.rows ?? 15);
  if (![west, south, east, north].every(finite)
    || west < -180 || west > 180 || east < -180 || east > 180
    || south < -90 || south > 90 || north < -90 || north > 90
    || east <= west || north <= south) {
    throw new Error('invalid terrain viewport bounds');
  }
  if (!Number.isInteger(cols) || !Number.isInteger(rows)
    || cols < MIN_GRID_SIDE || rows < MIN_GRID_SIDE
    || cols > MAX_GRID_SIDE || rows > MAX_GRID_SIDE) {
    throw new Error(`terrain grid must be an integer between ${MIN_GRID_SIDE} and ${MAX_GRID_SIDE}`);
  }
  return { west, south, east, north, cols, rows };
}

/** Generate a row-major lon/lat sampling grid. */
export function terrainSamplePoints(viewport) {
  const { west, south, east, north, cols, rows } = normalizeTerrainViewport(viewport);
  const points = [];
  for (let row = 0; row < rows; row += 1) {
    const lat = rows === 1 ? south : south + ((north - south) * row) / (rows - 1);
    for (let col = 0; col < cols; col += 1) {
      const lon = cols === 1 ? west : west + ((east - west) * col) / (cols - 1);
      points.push([lon, lat]);
    }
  }
  return points;
}

/** Normalize a camera-ray grid. Null cells represent rays that hit the sky. */
export function normalizeTerrainGrid(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['rows', 'cols', 'points'].includes(key))) {
    throw new Error('invalid terrain grid object');
  }
  const rows = input.rows;
  const cols = input.cols;
  if (!Number.isInteger(rows) || !Number.isInteger(cols)
    || rows < MIN_GRID_SIDE || cols < MIN_GRID_SIDE
    || rows > MAX_GRID_SIDE || cols > MAX_GRID_SIDE) {
    throw new Error(`terrain grid must be an integer between ${MIN_GRID_SIDE} and ${MAX_GRID_SIDE}`);
  }
  if (!Array.isArray(input.points) || input.points.length !== rows * cols) {
    throw new Error('terrain points do not match the requested grid');
  }
  const points = input.points.map((point) => {
    if (point == null) return null;
    const lon = Array.isArray(point) ? Number(point[0]) : Number(point.lon ?? point.longitude);
    const lat = Array.isArray(point) ? Number(point[1]) : Number(point.lat ?? point.latitude);
    if (!finite(lon) || !finite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      throw new Error('invalid terrain sample coordinate');
    }
    return [lon, lat];
  });
  const located = points.filter(Boolean);
  if (!located.length) throw new Error('terrain grid contains no ground rays');
  const lons = located.map(([lon]) => lon);
  const lats = located.map(([, lat]) => lat);
  // Keep antimeridian-spanning samples compact instead of returning a
  // nearly-global [-179, 179] rectangle.
  const rawWest = Math.min(...lons); const rawEast = Math.max(...lons);
  let west = rawWest; let east = rawEast;
  if (rawEast - rawWest > 180) {
    const shifted = lons.map((lon) => (lon < 0 ? lon + 360 : lon));
    west = Math.min(...shifted); east = Math.max(...shifted);
    if (west > 180) west -= 360;
    if (east > 180) east -= 360;
  }
  return {
    rows,
    cols,
    points,
    bounds: {
      west, east,
      south: Math.min(...lats), north: Math.max(...lats),
    },
  };
}

/** Parse the local JSON POST contract used by the terrain-analysis endpoint. */
export function parseTerrainAnalysisRequest({ method, contentType, body } = {}) {
  if (method !== 'POST' || String(contentType || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new Error('terrain analysis requires a JSON POST');
  }
  const parsed = typeof body === 'string' ? JSON.parse(body) : body;
  return normalizeTerrainGrid(parsed);
}

function sampleHeight(sample) {
  if (!sample || typeof sample !== 'object') return null;
  const raw = sample.elevation ?? sample.ellipsoid;
  return finite(raw) ? raw : null;
}

function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function formatNumber(value) {
  return Math.round(value * 100) / 100;
}

const EARTH_RADIUS_M = 6_378_137;

function haversineMeters(a, b) {
  if (!a || !b) return null;
  const lon1 = Number(a[0]); const lat1 = Number(a[1]);
  const lon2 = Number(b[0]); const lat2 = Number(b[1]);
  if (![lon1, lat1, lon2, lat2].every(finite)) return null;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  let dLon = (lon2 - lon1) * rad;
  if (dLon > Math.PI) dLon -= 2 * Math.PI;
  if (dLon < -Math.PI) dLon += 2 * Math.PI;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Return a row-major slope grid in degrees, preserving null cells. */
export function deriveSlopeGrid(grid) {
  const normalized = normalizeTerrainGrid({ rows: grid?.rows, cols: grid?.cols, points: grid?.points });
  const { rows, cols, points } = normalized;
  const values = Array.isArray(grid.values) ? grid.values.map((value) => finite(value) ? value : null) : [];
  if (values.length !== rows * cols) throw new Error('terrain values do not match the requested grid');
  const slopeGrid = Array(rows * cols).fill(null);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const i = row * cols + col;
      if (!points[i] || values[i] === null) continue;
      const neighbors = [[row, col - 1], [row, col + 1], [row - 1, col], [row + 1, col]]
        .filter(([r, c]) => r >= 0 && r < rows && c >= 0 && c < cols)
        .map(([r, c]) => ({ point: points[r * cols + c], value: values[r * cols + c] }))
        .filter(({ point, value }) => point && value !== null);
      if (neighbors.length < 2) continue;
      const gradients = neighbors.map(({ point, value }) => {
        const distance = haversineMeters(points[i], point);
        return distance > 0 ? Math.abs(value - values[i]) / distance : 0;
      });
      slopeGrid[i] = formatNumber(Math.atan(Math.max(...gradients)) * 180 / Math.PI);
    }
  }
  return slopeGrid;
}

/** Build bounded elevation bands suitable for a map heatmap/legend. */
export function buildElevationBands(values, bandCount = 5) {
  if (!Array.isArray(values)) throw new Error('terrain values must be an array');
  const valid = values.filter(finite);
  if (!valid.length) return [];
  const count = Math.max(2, Math.min(12, Number.isInteger(bandCount) ? bandCount : 5));
  const min = Math.min(...valid); const max = Math.max(...valid);
  const step = Math.max(1, (max - min) / count);
  const bands = Array.from({ length: count }, (_, index) => {
    const lower = index === 0 ? min : min + step * index;
    const upper = index === count - 1 ? max : min + step * (index + 1);
    return { index, min: formatNumber(lower), max: formatNumber(upper), sampleCount: 0, indices: [] };
  });
  values.forEach((value, index) => {
    if (!finite(value)) return;
    const band = bands[Math.min(count - 1, Math.max(0, Math.floor((value - min) / step)))];
    band.sampleCount += 1; band.indices.push(index);
  });
  return bands;
}

/** Detect local high/low terrain cells, retaining source coordinates. */
export function detectTerrainFeatures(grid, { prominence = 10 } = {}) {
  const normalized = normalizeTerrainGrid({ rows: grid?.rows, cols: grid?.cols, points: grid?.points });
  const values = Array.isArray(grid.values) ? grid.values : [];
  if (values.length !== normalized.rows * normalized.cols) throw new Error('terrain values do not match the requested grid');
  const threshold = finite(prominence) ? Math.max(0, prominence) : 10;
  const highPoints = []; const lowPoints = [];
  const neighborsAt = (row, col) => [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]
    .map(([dr, dc]) => [row + dr, col + dc]).filter(([r, c]) => r >= 0 && r < normalized.rows && c >= 0 && c < normalized.cols)
    .map(([r, c]) => ({ value: values[r * normalized.cols + c], point: normalized.points[r * normalized.cols + c] }))
    .filter((entry) => entry.point && finite(entry.value));
  for (let row = 0; row < normalized.rows; row += 1) for (let col = 0; col < normalized.cols; col += 1) {
    const index = row * normalized.cols + col; const value = values[index];
    if (!normalized.points[index] || !finite(value)) continue;
    const neighbors = neighborsAt(row, col); if (!neighbors.length) continue;
    const maxNeighbor = Math.max(...neighbors.map((entry) => entry.value));
    const minNeighbor = Math.min(...neighbors.map((entry) => entry.value));
    const point = { lon: normalized.points[index][0], lat: normalized.points[index][1], elevation: formatNumber(value), prominence: formatNumber(Math.max(value - maxNeighbor, minNeighbor - value)) };
    if (value >= maxNeighbor && value - maxNeighbor >= threshold) highPoints.push(point);
    if (value <= minNeighbor && minNeighbor - value >= threshold) lowPoints.push(point);
  }
  return { highPoints, lowPoints, ridges: highPoints, valleys: lowPoints };
}

/** Create a cumulative-distance elevation profile between two endpoints. */
export function buildElevationProfile(points, elevations) {
  if (!Array.isArray(points) || !Array.isArray(elevations) || points.length !== elevations.length) throw new Error('profile points and elevations must have equal lengths');
  const profile = []; let distanceM = 0;
  for (let index = 0; index < points.length; index += 1) {
    if (!Array.isArray(points[index]) || !points[index].every(finite) || !finite(elevations[index])) continue;
    if (profile.length) distanceM += haversineMeters(profile.at(-1).point, points[index]) || 0;
    profile.push({ point: [points[index][0], points[index][1]], distanceM: formatNumber(distanceM), elevation: formatNumber(elevations[index]) });
  }
  return profile;
}

/** Determine whether intermediate terrain blocks line of sight between endpoints. */
export function analyzeLineOfSight(profile, { observerHeightM = 0, targetHeightM = 0 } = {}) {
  if (!Array.isArray(profile) || profile.length < 2) throw new Error('line-of-sight profile requires at least two samples');
  const first = profile[0]; const last = profile.at(-1); const total = Number(last.distanceM);
  if (!finite(total) || total <= 0) throw new Error('line-of-sight profile distance is invalid');
  const start = Number(first.elevation) + (finite(observerHeightM) ? observerHeightM : 0);
  const end = Number(last.elevation) + (finite(targetHeightM) ? targetHeightM : 0);
  let blockingPoint = null; let minClearance = Infinity;
  for (const sample of profile.slice(1, -1)) {
    const ratio = Math.max(0, Math.min(1, Number(sample.distanceM) / total));
    const sight = start + (end - start) * ratio;
    const clearance = sight - Number(sample.elevation);
    if (clearance < minClearance) {
      minClearance = clearance;
      blockingPoint = clearance < 0 ? { ...sample, clearanceM: formatNumber(clearance) } : null;
    }
  }
  return { visible: blockingPoint === null, blockingPoint, minClearanceM: Number.isFinite(minClearance) ? formatNumber(minClearance) : null };
}

// Descriptive aliases kept for callers that prefer domain terminology.
export const calculateSlopeGrid = deriveSlopeGrid;
export const detectRidgesAndValleys = detectTerrainFeatures;
export const analyzeTerrainLineOfSight = analyzeLineOfSight;

/**
 * Interpolate contour crossings for one cell using marching squares. The
 * output is intentionally line segments, which are directly renderable as
 * Cesium polylines without requiring a geometry library.
 */
function contourSegments(grid, level) {
  const { rows, cols, values, points } = grid;
  const segments = [];
  const crossing = (a, b, va, vb) => {
    if (!Number.isFinite(va) || !Number.isFinite(vb) || va === vb) return null;
    if ((va < level && vb < level) || (va > level && vb > level)) return null;
    const t = Math.max(0, Math.min(1, (level - va) / (vb - va)));
    let dLon = points[b][0] - points[a][0];
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    let lon = points[a][0] + dLon * t;
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    return [lon, points[a][1] + (points[b][1] - points[a][1]) * t];
  };
  for (let row = 0; row < rows - 1; row += 1) {
    for (let col = 0; col < cols - 1; col += 1) {
      const tl = row * cols + col;
      const tr = tl + 1;
      const bl = (row + 1) * cols + col;
      const br = bl + 1;
      if ([tl, tr, bl, br].some((index) => !points[index])) continue;
      const edges = [
        crossing(tl, tr, values[tl], values[tr]),
        crossing(tr, br, values[tr], values[br]),
        crossing(br, bl, values[br], values[bl]),
        crossing(bl, tl, values[bl], values[tl]),
      ].filter(Boolean);
      if (edges.length === 2) segments.push(edges);
      else if (edges.length === 4) {
        // Saddle cells are split into two short, conservative segments.
        segments.push([edges[0], edges[1]], [edges[2], edges[3]]);
      }
    }
  }
  return segments;
}

/**
 * Analyze row-major samples for a normalized viewport. Missing heights are
 * retained as null and excluded from statistics; no zero-height fabrication.
 */
export function analyzeTerrainSamples(viewport, samples) {
  const normalized = viewport?.points
    ? (viewport.bounds ? viewport : normalizeTerrainGrid(viewport))
    : normalizeTerrainViewport(viewport);
  if (!Array.isArray(samples) || samples.length !== normalized.rows * normalized.cols) {
    throw new Error('terrain samples do not match the requested grid');
  }
  const points = normalized.points || terrainSamplePoints(normalized);
  const values = samples.map(sampleHeight);
  const valid = values.filter((value) => value !== null);
  if (!valid.length) throw new Error('terrain samples contain no usable heights');
  const sorted = [...valid].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted.at(-1);
  const mean = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  const variance = valid.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / valid.length;

  const grid = { ...normalized, points, values };
  const slopeGrid = deriveSlopeGrid(grid);
  const elevationBands = buildElevationBands(values);
  const features = detectTerrainFeatures(grid, { prominence: Math.max(5, (max - min) / 20) });
  const levelStep = Math.max(1, Math.ceil((max - min) / 5 / 10) * 10);
  const firstLevel = Math.ceil(min / levelStep) * levelStep;
  const contours = [];
  for (let level = firstLevel; level < max && contours.length < 12; level += levelStep) {
    const segments = contourSegments(grid, level);
    if (segments.length) contours.push({ level: formatNumber(level), segments });
  }

  const centerRow = Math.floor((normalized.rows - 1) / 2);
  const centerCol = Math.floor((normalized.cols - 1) / 2);
  const pointAt = (index) => points[index]
    ? { lon: points[index][0], lat: points[index][1], elevation: values[index] }
    : null;
  const westEast = Array.from({ length: normalized.cols }, (_, col) => pointAt(centerRow * normalized.cols + col));
  const southNorth = Array.from({ length: normalized.rows }, (_, row) => pointAt(row * normalized.cols + centerCol));

  // Central finite differences approximate local relief in metres per degree.
  const slopes = [];
  const latMeters = 111_320;
  const southBound = normalized.bounds?.south ?? normalized.south;
  const northBound = normalized.bounds?.north ?? normalized.north;
  const lonMeters = 111_320 * Math.max(0.1, Math.cos(((southBound + northBound) / 2) * Math.PI / 180));
  for (let row = 0; row < normalized.rows; row += 1) {
    for (let col = 0; col < normalized.cols; col += 1) {
      const index = row * normalized.cols + col;
      if (!points[index]) continue;
      const west = values[row * normalized.cols + Math.max(0, col - 1)];
      const east = values[row * normalized.cols + Math.min(normalized.cols - 1, col + 1)];
      const south = values[Math.max(0, row - 1) * normalized.cols + col];
      const north = values[Math.min(normalized.rows - 1, row + 1) * normalized.cols + col];
      if ([west, east, south, north].some((value) => value === null)) continue;
      const leftPoint = points[row * normalized.cols + Math.max(0, col - 1)];
      const rightPoint = points[row * normalized.cols + Math.min(normalized.cols - 1, col + 1)];
      const downPoint = points[Math.max(0, row - 1) * normalized.cols + col];
      const upPoint = points[Math.min(normalized.rows - 1, row + 1) * normalized.cols + col];
      if ([leftPoint, rightPoint, downPoint, upPoint].some((point) => !point)) continue;
      const dxMeters = Math.max(1, Math.abs(rightPoint[0] - leftPoint[0]) * lonMeters);
      const dyMeters = Math.max(1, Math.abs(upPoint[1] - downPoint[1]) * latMeters);
      const dx = (east - west) / dxMeters;
      const dy = (north - south) / dyMeters;
      slopes.push(Math.atan(Math.hypot(dx, dy)) * 180 / Math.PI);
    }
  }

  return {
    viewport: normalized,
    grid: { rows: normalized.rows, cols: normalized.cols, points, values, slopes: slopeGrid },
    elevationBands,
    features,
    profiles: { westEast, southNorth },
    stats: {
      sampleCount: valid.length,
      missingCount: values.length - valid.length,
      min: formatNumber(min),
      max: formatNumber(max),
      mean: formatNumber(mean),
      median: formatNumber(percentile(sorted, 0.5)),
      p10: formatNumber(percentile(sorted, 0.1)),
      p90: formatNumber(percentile(sorted, 0.9)),
      range: formatNumber(max - min),
      standardDeviation: formatNumber(Math.sqrt(variance)),
      meanSlopeDeg: slopes.length ? formatNumber(slopes.reduce((sum, value) => sum + value, 0) / slopes.length) : null,
      maxSlopeDeg: slopes.length ? formatNumber(Math.max(...slopes)) : null,
      terrainClass: max - min < 30 ? 'flat' : max - min < 150 ? 'rolling' : 'mountainous',
    },
    contours,
  };
}
