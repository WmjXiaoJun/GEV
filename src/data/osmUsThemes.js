import osmtogeojson from 'osmtogeojson';

/**
 * Themed OpenStreetMap feature access.
 *
 * Data comes from OpenStreetMap contributors. Requests go through the app's
 * same-origin Overpass proxy;
 * no API key or proprietary provider is required. The module deliberately
 * returns GeoJSON so Cesium layers and non-Cesium consumers share one shape.
 */

const MAX_FEATURES = 3000;
const MAX_BBOX_SPAN = 5;
const DEFAULT_ENDPOINT = '/api/overpass';
const DEFAULT_TIMEOUT_MS = 100_000;
const OSM_PUBLISHER = 'OpenStreetMap contributors';
const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
const OSM_ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright';

const THEME_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'addresses',
    label: 'Addresses',
    publisher: OSM_PUBLISHER,
    selectors: [
      'nwr["addr:housenumber"]["addr:street"]',
      'nwr["addr:housenumber"]["addr:place"]',
    ],
  }),
  Object.freeze({
    id: 'buildings',
    label: 'Buildings',
    publisher: OSM_PUBLISHER,
    selectors: ['way["building"]', 'relation["building"]'],
  }),
  Object.freeze({
    id: 'roads',
    label: 'Roads',
    publisher: OSM_PUBLISHER,
    selectors: ['way["highway"]["name"]'],
  }),
  Object.freeze({
    id: 'settlements',
    label: 'Settlements',
    publisher: OSM_PUBLISHER,
    selectors: ['node["place"~"city|town|village|hamlet|suburb|neighbourhood"]'],
  }),
  Object.freeze({
    id: 'water',
    label: 'Water',
    publisher: OSM_PUBLISHER,
    maxFeatures: 600,
    maxBboxSpan: 0.2,
    maxGeometryLengthM: 20_000,
    selectors: [
      'way["waterway"~"^(river|stream|canal)$"]',
      'way["natural"="water"]',
      'way["landuse"="reservoir"]',
    ],
  }),
  Object.freeze({
    id: 'green',
    label: 'Green Spaces',
    publisher: OSM_PUBLISHER,
    maxFeatures: 600,
    maxBboxSpan: 0.2,
    maxGeometryLengthM: 20_000,
    selectors: [
      'way["leisure"~"^(park|garden)$"]',
      'way["landuse"~"^(forest|grass|meadow|recreation_ground)$"]',
      'way["natural"~"^(wood|grassland)$"]',
    ],
  }),
  Object.freeze({
    id: 'pois',
    label: 'Public Facilities',
    publisher: OSM_PUBLISHER,
    maxFeatures: 800,
    maxBboxSpan: 0.2,
    output: 'tags center',
    selectors: [
      'nwr["amenity"~"^(school|college|university|hospital|clinic|police|fire_station|library|bus_station|ferry_terminal)$"]',
      'nwr["railway"~"^(station|halt|tram_stop)$"]',
      'node["highway"="bus_stop"]',
      'nwr["public_transport"="platform"]',
    ],
  }),
]);

export const OSM_US_THEMES = THEME_DEFINITIONS;

const THEMES_BY_ID = new Map(THEME_DEFINITIONS.map((theme) => [theme.id, theme]));

function numberInRange(value, min, max) {
  return Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max;
}

/** Normalize and validate a south, west, north, east bbox. */
export function normalizeOsmUsBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new TypeError('bbox must be [south, west, north, east]');
  }
  const values = bbox.map(Number);
  const [south, west, north, east] = values;
  if (!numberInRange(south, -90, 90) || !numberInRange(north, -90, 90)
    || !numberInRange(west, -180, 180) || !numberInRange(east, -180, 180)
    || south >= north || west >= east) {
    throw new RangeError('bbox coordinates are invalid or out of order');
  }
  if (north - south > MAX_BBOX_SPAN || east - west > MAX_BBOX_SPAN) {
    throw new RangeError(`bbox span must not exceed ${MAX_BBOX_SPAN} degrees`);
  }
  return values.map((value) => Number(value.toFixed(6)));
}

function getTheme(themeId) {
  const theme = THEMES_BY_ID.get(String(themeId || '').trim());
  if (!theme) throw new RangeError(`Unknown OSM theme: ${themeId}`);
  return theme;
}

function themeFeatureLimit(theme, limit) {
  return Math.min(theme.maxFeatures || MAX_FEATURES,
    Math.max(1, Math.floor(Number(limit) || MAX_FEATURES)));
}

/** Build a bounded Overpass QL request for one OSM theme. */
export function buildOsmUsOverpassQuery(themeId, bbox, { limit = MAX_FEATURES } = {}) {
  const theme = getTheme(themeId);
  const [south, west, north, east] = normalizeOsmUsBbox(bbox);
  if (theme.maxBboxSpan && (north - south > theme.maxBboxSpan + 1e-9
    || east - west > theme.maxBboxSpan + 1e-9)) {
    throw new RangeError(`${theme.id} bbox span must not exceed ${theme.maxBboxSpan} degrees`);
  }
  const safeLimit = themeFeatureLimit(theme, limit);
  // Whole river/forest relations may extend far beyond the visible area.
  const lengthFilter = theme.maxGeometryLengthM ? `(if:length()<=${theme.maxGeometryLengthM})` : '';
  const selectors = theme.selectors
    .map((selector) => `${selector}(${south},${west},${north},${east})${lengthFilter};`)
    .join('\n      ');
  return `[out:json][timeout:25];\n(\n      ${selectors}\n    );\nout ${theme.output || 'body geom'} ${safeLimit};`;
}

function validPosition(position) {
  return Array.isArray(position)
    && position.length >= 2
    && numberInRange(position[0], -180, 180)
    && numberInRange(position[1], -90, 90);
}

function hasValidCoordinates(value) {
  if (!Array.isArray(value)) return false;
  if (value.length && typeof value[0] === 'number') return validPosition(value);
  return value.every(hasValidCoordinates);
}

function sourceUpdatedAt(payload) {
  const updatedAt = payload?.osm3s?.timestamp_osm_base;
  return typeof updatedAt === 'string' && updatedAt.trim() ? updatedAt : null;
}

/** Convert an Overpass payload into immutable, theme-labelled GeoJSON. */
export function parseOsmUsTheme(payload, themeId, { limit = MAX_FEATURES } = {}) {
  const theme = getTheme(themeId);
  const elements = Array.isArray(payload) ? payload : payload?.elements;
  if (!Array.isArray(elements)) throw new TypeError('Overpass response must contain an elements array');
  const safeLimit = themeFeatureLimit(theme, limit);
  const converted = osmtogeojson({ elements }, { flatProperties: false });
  const features = converted.features
    .filter((feature) => feature?.geometry && hasValidCoordinates(feature.geometry.coordinates))
    .slice(0, safeLimit)
    .map((feature, index) => {
      const source = feature.properties || {};
      const tags = source.tags && typeof source.tags === 'object' ? { ...source.tags } : {};
      const osmType = typeof source.type === 'string' ? source.type : null;
      const osmId = Number.isFinite(Number(source.id)) ? Number(source.id) : null;
      return {
        type: 'Feature',
        id: `${osmType || 'feature'}-${osmId ?? index}`,
        geometry: feature.geometry,
        properties: {
          ...tags,
          tags,
          osm_id: osmId,
          osm_type: osmType,
          theme: theme.id,
          source: 'OpenStreetMap',
          publisher: theme.publisher,
        },
      };
    });
  return {
    type: 'FeatureCollection',
    features,
    metadata: {
      theme: theme.id,
      label: theme.label,
      publisher: theme.publisher,
      license: 'ODbL',
      attribution: OSM_ATTRIBUTION,
      attributionUrl: OSM_ATTRIBUTION_URL,
      updatedAt: sourceUpdatedAt(payload),
      truncated: elements.length >= safeLimit,
    },
  };
}

/** Fetch one themed bbox through the existing same-origin Overpass proxy. */
export async function fetchOsmUsTheme(themeId, bbox, {
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
  limit = MAX_FEATURES,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (signal?.aborted) throw signal.reason || new DOMException('Request aborted', 'AbortError');
  const query = buildOsmUsOverpassQuery(themeId, bbox, { limit });
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`OSM theme request failed (HTTP ${response?.status ?? '?'})`);
    const payload = await response.json();
    if (typeof payload?.remark === 'string' && payload.remark.trim()) {
      throw new Error(`Overpass request failed: ${payload.remark.trim()}`);
    }
    return parseOsmUsTheme(payload, themeId, { limit });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
