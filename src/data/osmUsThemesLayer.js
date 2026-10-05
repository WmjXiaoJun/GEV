import * as Cesium from 'cesium';
import { fetchOsmUsTheme, normalizeOsmUsBbox, OSM_US_THEMES } from './osmUsThemes.js';
import { governorRequestRender } from '../renderGovernor.js';
import { getLocale, subscribeLocale, t } from '../i18n.js';
import { clearOverlaySource, hitTestWorldOverlay, setOverlayEntries } from '../overlays/worldOverlay.js';
import { buildOsmOverlayEntries, styleOsmSource, OSM_THEME_COLORS } from './osmFeaturePresentation.js';
import { resolveOsmFeatureText } from './osmFeatureText.js';

export { normalizeOsmUsBbox };

const DEFAULT_THEMES = Object.freeze(['addresses', 'buildings', 'roads', 'settlements']);
const MAX_VIEW_SPAN_DEGREES = 0.2;

export function rectangleToOsmBbox(rectangle) {
  if (!rectangle) return null;
  const bbox = [rectangle.south, rectangle.west, rectangle.north, rectangle.east].map(Cesium.Math.toDegrees);
  try { return normalizeOsmUsBbox(bbox); } catch { return null; }
}

export function viewBbox(viewer) {
  let bbox;
  try { bbox = rectangleToOsmBbox(viewer?.camera?.computeViewRectangle?.(viewer.scene?.globe?.ellipsoid)); }
  catch { return null; }
  if (!bbox || bbox[2] - bbox[0] > MAX_VIEW_SPAN_DEGREES || bbox[3] - bbox[1] > MAX_VIEW_SPAN_DEGREES) return null;
  return bbox;
}

export function bboxChanged(previous, next) {
  return !previous || !next || previous.some((value, index) => Math.abs(value - next[index]) > 0.0005);
}

export function createOsmUsRefreshPlan(previousBbox, nextBbox, { force = false } = {}) {
  const bbox = normalizeOsmUsBbox(nextBbox);
  return { shouldFetch: force || bboxChanged(previousBbox, bbox), bbox };
}

function firstCoordinate(coordinates) {
  if (!Array.isArray(coordinates)) return null;
  if (typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') return coordinates;
  return coordinates.map(firstCoordinate).find(Boolean) || null;
}

function analystRecords(geojson, theme, layerId, loadedAt, sourceUpdatedAt) {
  return geojson.features.flatMap((feature) => {
    const point = firstCoordinate(feature.geometry?.coordinates);
    if (!point || !point.slice(0, 2).every(Number.isFinite)) return [];
    return [{
      id: `${theme.id}:${feature.id}`, layerId, theme: theme.id, source: 'OpenStreetMap',
      longitude: point[0], latitude: point[1],
      label: String(feature.properties?.name || feature.properties?.['addr:housenumber'] || theme.label),
      properties: structuredClone(feature.properties || {}),
      loadedAt, updatedAt: sourceUpdatedAt, sourceUpdatedAt,
    }];
  });
}

export function createOsmUsThemesLayer({
  id = 'osm-us-themes', name = 'OSM Map Features', fetchTheme = fetchOsmUsTheme,
  debounceMs = 450, loadDataSource = (geojson, options) => Cesium.GeoJsonDataSource.load(geojson, options),
  requestRender = governorRequestRender,
  overlayHost = { setEntries: setOverlayEntries, clearSource: clearOverlaySource, hitTest: hitTestWorldOverlay },
  screenSpaceEventHandlerFactory = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
} = {}) {
  let viewer = null;
  let enabled = false;
  let destroyed = false;
  let timer = null;
  let generation = 0;
  let active = null;
  let lastBbox = null;
  let lastUpdate = null;
  let status = 'idle';
  let failures = [];
  let onControlsChange = null;
  let removeListeners = [];
  let resultsByTheme = {};
  let queuedForceRefresh = false;
  let params = { themes: [...DEFAULT_THEMES], labels: true };
  let selectedId = null;
  let removeLocaleListener = null;
  let clickHandler = null;
  const overlayId = `${id}:labels`;

  function publishLabels() {
    if (!enabled || !params.labels) { overlayHost.clearSource(overlayId); return; }
    const records = Object.values(resultsByTheme).flatMap((result) => result.labelRecords);
    overlayHost.setEntries(overlayId, buildOsmOverlayEntries(records, {
      locale: getLocale(), viewer, selectedId,
      onSelect: (record) => { selectedId = selectedId === record.id ? null : record.id; publishLabels(); notify(); },
    }), { cohortLimit: 120, collisionCapacity: 72 });
  }

  function notify() {
    requestRender('osm-themes');
    onControlsChange?.();
  }

  function clearSources() {
    for (const result of Object.values(resultsByTheme)) viewer?.dataSources.remove(result.source, true);
    resultsByTheme = {};
    lastUpdate = null;
    selectedId = null;
    overlayHost.clearSource(overlayId);
  }

  function cancel() {
    clearTimeout(timer);
    timer = null;
    generation += 1;
    active?.controller.abort();
    active = null;
    queuedForceRefresh = false;
  }

  function current(run, runViewer) { return run === generation && viewer === runViewer && enabled && !destroyed; }

  async function loadTheme(theme, bbox, controller, run, runViewer) {
    let source = null;
    let added = false;
    try {
      const geojson = await fetchTheme(theme.id, bbox, { signal: controller.signal });
      if (!current(run, runViewer)) return null;
      const color = Cesium.Color.fromCssColorString(OSM_THEME_COLORS[theme.id]);
      source = await loadDataSource(geojson, {
        clampToGround: true, stroke: color, fill: color.withAlpha(0.22),
        strokeWidth: theme.id === 'roads' ? 3 : 2, markerColor: color, markerSize: 8,
      });
      if (!current(run, runViewer)) { source.destroy?.(); return null; }
      source.name = `${name}: ${theme.label}`;
      source.show = false;
      const labelRecords = styleOsmSource(source, theme)
        .map((record) => ({ ...record, id: `${theme.id}:${record.id}` }));
      await runViewer.dataSources.add(source);
      added = true;
      if (!current(run, runViewer)) { runViewer.dataSources.remove(source, true); return null; }
      const loadedAt = Date.now();
      const sourceUpdatedAt = geojson.metadata?.updatedAt || null;
      const previous = resultsByTheme[theme.id];
      if (previous) runViewer.dataSources.remove(previous.source, true);
      resultsByTheme = { ...resultsByTheme, [theme.id]: {
        source, count: geojson.features.length, truncated: geojson.metadata?.truncated === true,
        sourceUpdatedAt, labelRecords, records: analystRecords(geojson, theme, id, loadedAt, sourceUpdatedAt),
      } };
      source.show = true;
      lastUpdate = loadedAt;
      publishLabels();
      notify();
      return null;
    } catch (cause) {
      if (source) {
        if (added) runViewer?.dataSources.remove(source, true);
        else source.destroy?.();
      }
      if (!current(run, runViewer) || controller.signal.aborted) return null;
      console.warn(`[OSM] ${theme.id} load failed:`, cause);
      return { theme: theme.id, message: String(cause?.message || 'request failed') };
    }
  }

  async function loadThemes(themes, bbox, controller, run, runViewer) {
    let outcomes = [];
    // Public Overpass mirrors commonly provide two query slots per client.
    for (let index = 0; index < themes.length && current(run, runViewer); index += 2) {
      const batch = await Promise.all(themes.slice(index, index + 2)
        .map((theme) => loadTheme(theme, bbox, controller, run, runViewer)));
      outcomes = [...outcomes, ...batch];
    }
    return outcomes;
  }

  async function refresh({ force = false } = {}) {
    if (!enabled || destroyed || !viewer) return;
    const bbox = viewBbox(viewer);
    if (!bbox) {
      cancel(); clearSources(); lastBbox = null; failures = []; status = 'zoom-in'; notify();
      return;
    }
    if (active && !bboxChanged(active.bbox, bbox)) {
      if (force) queuedForceRefresh = true;
      return active.promise;
    }
    const missing = params.themes.some((theme) => !resultsByTheme[theme]);
    if (!force && !missing && !failures.length && !bboxChanged(lastBbox, bbox)) return;
    cancel();
    if (bboxChanged(lastBbox, bbox)) clearSources();
    const run = generation;
    const runViewer = viewer;
    const controller = new AbortController();
    lastBbox = bbox;
    const failedThemes = new Set(failures.map((failure) => failure.theme));
    failures = [];
    status = 'loading';
    // Publish the loading slot before work starts so enable/update share one request.
    const job = { bbox, controller, promise: null };
    active = job;
    const themes = OSM_US_THEMES.filter((theme) => params.themes.includes(theme.id)
      && (force || !resultsByTheme[theme.id] || failedThemes.has(theme.id)));
    job.promise = loadThemes(themes, bbox, controller, run, runViewer)
      .then((outcomes) => {
        if (!current(run, runViewer)) return;
        failures = outcomes.filter(Boolean);
        status = failures.length ? 'degraded' : 'ready';
        active = null;
        notify();
        if (queuedForceRefresh) {
          queuedForceRefresh = false;
          return refresh({ force: true });
        }
      });
    notify();
    return job.promise;
  }

  function scheduleRefresh(force = false) {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void refresh({ force }); }, debounceMs);
  }

  function bindClickHandler() {
    if (clickHandler || !viewer?.scene?.canvas) return;
    const runViewer = viewer;
    const handler = screenSpaceEventHandlerFactory(runViewer.scene.canvas);
    clickHandler = handler;
    handler.setInputAction((click) => {
      if (clickHandler !== handler || viewer !== runViewer || !enabled || destroyed || !params.labels) return;
      const position = click?.position;
      if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return;
      const hit = overlayHost.hitTest?.(position.x, position.y, { sourceId: overlayId });
      if (hit?.sourceId === overlayId) hit.entry?.activate?.();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function clearClickHandler() {
    clickHandler?.destroy();
    clickHandler = null;
  }

  function disable() {
    enabled = false;
    cancel();
    clearClickHandler();
    for (const remove of removeListeners) remove();
    removeListeners = [];
    removeLocaleListener?.(); removeLocaleListener = null;
    clearSources(); lastBbox = null; failures = []; status = 'idle';
    notify();
  }

  function clearCameraListeners() {
    for (const remove of removeListeners) remove();
    removeListeners = [];
  }

  function bindCameraListeners() {
    const start = viewer.camera.moveStart?.addEventListener(() => {
      cancel(); clearSources(); lastBbox = null; failures = []; status = 'idle'; notify();
    });
    const end = (viewer.camera.moveEnd || viewer.camera.changed)?.addEventListener(() => scheduleRefresh());
    removeListeners = [start, end].filter(Boolean);
  }

  function setParams(next) {
    if (next.labels !== undefined && typeof next.labels !== 'boolean') return false;
    if (next.themes !== undefined && (!Array.isArray(next.themes)
      || next.themes.some((theme) => !OSM_US_THEMES.some((entry) => entry.id === theme)))) return false;
    const themes = next.themes ? OSM_US_THEMES.filter((theme) => next.themes.includes(theme.id)).map((theme) => theme.id) : params.themes;
    const changed = themes.join(',') !== params.themes.join(',');
    params = { themes: [...themes], labels: next.labels ?? params.labels };
    if (changed) {
      cancel();
      for (const [theme, result] of Object.entries(resultsByTheme)) {
        if (!themes.includes(theme)) viewer?.dataSources.remove(result.source, true);
      }
      resultsByTheme = Object.fromEntries(Object.entries(resultsByTheme).filter(([theme]) => themes.includes(theme)));
      selectedId = null; failures = []; status = 'idle';
      if (enabled) void refresh();
    }
    publishLabels(); notify();
    if (next.refresh === true && enabled) scheduleRefresh(true);
    return true;
  }

  return {
    id, name, icon: '\u25a6', source: 'OpenStreetMap', updateInterval: 0, statsRefreshInterval: 1000,
    init: (nextViewer) => { viewer = nextViewer; },
    enable: (nextViewer) => {
      if (destroyed) return false;
      const viewerChanged = Boolean(nextViewer && nextViewer !== viewer);
      if (viewerChanged) {
        cancel();
        clearClickHandler();
        clearCameraListeners();
        clearSources(); lastBbox = null; failures = []; status = 'idle';
      }
      viewer = nextViewer || viewer;
      if (!viewer) return false;
      enabled = true;
      if (!removeListeners.length) bindCameraListeners();
      bindClickHandler();
      if (!removeLocaleListener) removeLocaleListener = subscribeLocale(() => { publishLabels(); notify(); });
      void refresh();
    },
    update: () => {},
    disable,
    destroy: () => { disable(); destroyed = true; onControlsChange = null; },
    setRowControlsListener: (listener) => { onControlsChange = listener; },
    setParams,
    getParams: () => ({ themes: [...params.themes], labels: params.labels }),
    getStats: () => ({
      count: Object.values(resultsByTheme).reduce((sum, result) => sum + result.count, 0),
      themes: Object.fromEntries(OSM_US_THEMES.map((theme) => [theme.id, resultsByTheme[theme.id]?.count || 0])),
      loading: status === 'loading', status, lastUpdate, loadedAt: lastUpdate,
      source: 'OpenStreetMap',
      sourceUpdatedAt: Object.values(resultsByTheme).map((result) => result.sourceUpdatedAt).find(Boolean) || null,
      isStatic: false,
      error: failures.length ? t('osm.failed', { count: failures.length }) : null,
      loadingLabel: status === 'zoom-in' ? t('osm.largeView')
        : status === 'loading' ? t('osm.loading') : t('osm.loadedView'),
      truncated: Object.values(resultsByTheme).some((result) => result.truncated),
    }),
    getAnalystRecords: (maxCount = 2000) => {
      if (!enabled || destroyed) return [];
      const limit = Number.isFinite(Number(maxCount)) ? Math.max(0, Math.min(20000, Math.floor(Number(maxCount)))) : 2000;
      return structuredClone(Object.values(resultsByTheme).flatMap((result) => result.records).slice(0, limit)
        .map((record) => ({ ...record, label: resolveOsmFeatureText(record.properties, { locale: getLocale(), theme: record.theme }).title })));
    },
    getRowControls: () => ({
      chips: [{ id: 'refresh', label: '\u21bb', title: t('osm.refresh'), disabled: status === 'loading',
        busy: status === 'loading', params: { refresh: true } },
      { id: 'labels', label: t('osm.labels'), title: t('osm.labels'), active: params.labels, params: { labels: !params.labels } },
      ...OSM_US_THEMES.map((theme) => ({ id: `theme-${theme.id}`,
        label: `${t(`osm.${theme.id}`)} ${resultsByTheme[theme.id]?.count || 0}`,
        title: t(`osm.${theme.id}`), active: params.themes.includes(theme.id),
        params: { themes: params.themes.includes(theme.id) ? params.themes.filter((item) => item !== theme.id) : [...params.themes, theme.id] },
      }))],
      legend: [],
    }),
    _refreshNow: refresh,
    _scheduleRefresh: scheduleRefresh,
  };
}

export default createOsmUsThemesLayer;
