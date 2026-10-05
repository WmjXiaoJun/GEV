import { getLocale, subscribeLocale, t } from '../i18n.js';
import { buildViewBrief } from './intelligence.js';
import { createWatchlist } from './watchlist.js';
import { getViewportRecordPage, getViewportRecords, readViewSnapshot, viewportRecordsToCsv } from './viewStatistics.js';
import { createViewportSnapshotStore, diffViewportSnapshots } from './viewportSnapshots.js';
import { createReportExports } from './reportExport.js';

function translatedValue(key, fallback) {
  const value = t(key);
  return value === key ? fallback : value;
}

function formatTime(value) {
  return value == null ? t('intel.unknown') : new Date(value).toLocaleString(getLocale(), { hour12: false });
}

function formatBounds(bounds) {
  return bounds ? [bounds.west, bounds.south, bounds.east, bounds.north].map((n) => n.toFixed(4)).join(', ') : t('intel.unavailable');
}

function locationArgs(bounds) {
  const width = bounds.east >= bounds.west ? bounds.east - bounds.west : bounds.east + 360 - bounds.west;
  const longitude = ((bounds.west + width / 2 + 540) % 360) - 180;
  return {
    latitude: (bounds.north + bounds.south) / 2, longitude,
    rangeM: Math.max(100, Math.min(20000000, Math.max(width, bounds.north - bounds.south) * 140000)),
    waitForArrival: true,
  };
}

export function initIntelligenceUi({ documentRef = globalThis.document, getSnapshot, getViewSnapshot, guard, sendText, openConversation, beforeUndo = () => {}, drawComparison = async () => {} } = {}) {
  const briefHost = documentRef?.getElementById('ai-intelligence-panel');
  const watchHost = documentRef?.getElementById('ai-watch-panel');
  const actionHost = documentRef?.getElementById('ai-action-review');
  const undoButton = documentRef?.getElementById('ai-undo');
  if (!briefHost || !watchHost || !actionHost) return { refresh: async () => null, renderAction() {}, destroy() {} };
  let destroyed = false;
  let snapshot = null;
  let viewSnapshot = null;
  let brief = null;
  let refreshing = null;
  let analyzing = false;
  let saving = false;
  let actionState = guard?.getState() ?? {};
  let actionPreviewKey = null;
  let actionCountdown = null;
  let watchState;
  let areasKey = '';
  let alertsKey = '';
  let recordQuery = '';
  let recordLayerId = 'all';
  let recordSortBy = 'name';
  let recordSortDir = 'asc';
  let recordPage = 1;
  const recordPageSize = 25;
  const snapshotHistory = createViewportSnapshotStore({ limit: 12 });
  let latestComparison = null;
  const cleanup = [];
  const localized = [];
  const element = (tag, className = '', text = '') => {
    const node = documentRef.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  };
  const listen = (node, event, callback, permanent = false) => {
    node.addEventListener(event, callback);
    if (permanent) cleanup.push(() => node.removeEventListener(event, callback));
  };
  const translated = (tag, key, className = '') => {
    const node = element(tag, className, t(key));
    localized.push(() => { node.textContent = t(key); });
    return node;
  };
  const button = (id, icon, key, callback, { text = false, permanent = false } = {}) => {
    const node = element('button', text ? 'intel-command' : 'ai-icon-button');
    node.id = id;
    node.type = 'button';
    const symbol = element('span', 'material-symbols-outlined', icon);
    symbol.setAttribute('aria-hidden', 'true');
    node.append(symbol);
    const label = text ? element('span', '', t(key)) : null;
    if (label) node.append(label);
    const translate = () => {
      node.title = t(key);
      node.setAttribute('aria-label', t(key));
      if (label) label.textContent = t(key);
    };
    translate();
    if (permanent) localized.push(translate);
    listen(node, 'click', callback, permanent);
    return node;
  };
  const pair = (key, value) => {
    const row = element('div', 'intel-detail');
    row.append(element('dt', '', t(key)), element('dd', '', String(value)));
    return row;
  };
  const status = (node, key = '') => {
    node.textContent = key ? t(key) : '';
    node.hidden = !key;
  };
  const briefToolbar = element('div', 'intel-toolbar');
  const refreshButton = button('intel-refresh', 'refresh', 'intel.refresh', () => { void refresh(); }, { permanent: true });
  const interpretButton = button('intel-interpret', 'auto_awesome', 'intel.interpret', () => { void interpret(); }, { text: true, permanent: true });
  const captureSnapshotButton = button('intel-snapshot-capture', 'camera', 'intel.captureSnapshot', () => { void captureSnapshot(); }, { text: true, permanent: true });
  const compareSnapshotButton = button('intel-snapshot-compare', 'compare_arrows', 'intel.compareSnapshot', () => { void compareSnapshot(); }, { text: true, permanent: true });
  const reportExportButton = button('intel-report-export', 'description', 'intel.exportReport', () => {
    reportMenu.hidden = !reportMenu.hidden;
  }, { text: true, permanent: true });
  const reportMenu = element('div', 'intel-report-menu');
  reportMenu.hidden = true;
  const reportJson = button('intel-report-json', 'data_object', 'intel.exportJson', () => downloadReport('json'), { text: true, permanent: true });
  const reportCsv = button('intel-report-csv', 'table_view', 'intel.exportCsv', () => downloadReport('csv'), { text: true, permanent: true });
  const reportGeoJson = button('intel-report-geojson', 'map', 'intel.exportGeoJson', () => downloadReport('geojson'), { text: true, permanent: true });
  const reportPdf = button('intel-report-pdf', 'picture_as_pdf', 'intel.exportPdf', () => printReport(), { text: true, permanent: true });
  reportMenu.append(reportJson, reportCsv, reportGeoJson, reportPdf);
  briefToolbar.append(refreshButton, interpretButton, captureSnapshotButton, compareSnapshotButton, reportExportButton, reportMenu);
  const briefBody = element('div', 'intel-brief-body');
  const recordSearch = element('input');
  recordSearch.id = 'intel-record-search';
  recordSearch.type = 'search';
  recordSearch.maxLength = 120;
  const recordLayer = element('select');
  recordLayer.id = 'intel-record-layer';
  const recordSort = element('select');
  recordSort.id = 'intel-record-sort';
  const recordSortDirControl = element('button', 'intel-command', 'A-Z');
  recordSortDirControl.id = 'intel-record-sort-dir';
  const recordExport = button('intel-record-export', 'download', 'intel.exportRecords', () => exportRecords(), { text: true, permanent: true });
  const recordPrev = button('intel-record-prev', 'chevron_left', 'intel.previousPage', () => { recordPage -= 1; renderRecords(); }, { permanent: true });
  const recordNext = button('intel-record-next', 'chevron_right', 'intel.nextPage', () => { recordPage += 1; renderRecords(); }, { permanent: true });
  const recordMeta = element('span', 'intel-record-meta');
  const recordList = element('div', 'intel-record-list');
  const recordToolbar = element('div', 'intel-record-toolbar');
  recordToolbar.append(recordSearch, recordLayer, recordSort, recordSortDirControl, recordExport);
  const recordPager = element('div', 'intel-record-pager');
  recordPager.append(recordPrev, recordMeta, recordNext);
  localized.push(() => {
    recordSearch.placeholder = t('intel.searchRecords'); recordSearch.setAttribute('aria-label', t('intel.searchRecords'));
    recordSortDirControl.title = t(recordSortDir === 'asc' ? 'intel.sortDescending' : 'intel.sortAscending');
    recordSortDirControl.setAttribute('aria-label', recordSortDirControl.title);
  });
  recordSearch.addEventListener('input', () => { recordQuery = recordSearch.value; recordPage = 1; renderRecords(); });
  recordLayer.addEventListener('change', () => { recordLayerId = recordLayer.value || 'all'; recordPage = 1; renderRecords(); });
  recordSort.addEventListener('change', () => { recordSortBy = recordSort.value || 'name'; recordPage = 1; renderRecords(); });
  recordSortDirControl.addEventListener('click', () => { recordSortDir = recordSortDir === 'asc' ? 'desc' : 'asc'; recordPage = 1; renderRecords(); });
  briefHost.append(recordToolbar, recordPager, recordList);
  const briefStatus = element('p', 'intel-status');
  briefStatus.id = 'intel-brief-status';
  briefStatus.setAttribute('role', 'status');
  briefHost.append(briefToolbar, translated('p', 'intel.viewportOnly', 'intel-scope'), briefStatus, briefBody);

  const watchName = element('input');
  watchName.id = 'intel-watch-name';
  watchName.maxLength = 80;
  localized.push(() => { watchName.placeholder = t('intel.areaName'); watchName.setAttribute('aria-label', t('intel.areaName')); });
  const watchAdd = button('intel-watch-add', 'bookmark_add', 'intel.saveArea', () => { void saveArea(); }, { text: true, permanent: true });
  const watchForm = element('div', 'intel-watch-form');
  watchForm.append(watchName, watchAdd);
  const watchStatus = element('p', 'intel-status');
  watchStatus.id = 'intel-watch-status';
  watchStatus.setAttribute('role', 'status');
  const storageStatus = element('p', 'intel-status');
  const areas = element('div', 'intel-area-list');
  const alerts = element('div', 'intel-alert-list');
  const unread = element('span', 'intel-unread', '0');
  unread.id = 'intel-unread';
  unread.setAttribute('role', 'status');
  const alertHeading = element('div', 'intel-toolbar');
  const alertLabel = translated('h3', 'intel.changes');
  const markRead = button('intel-mark-read', 'done_all', 'intel.markRead', () => watch.markRead(), { permanent: true });
  const clearAlerts = button('intel-clear-alerts', 'delete_sweep', 'intel.clearAlerts', () => watch.clearAlerts(), { permanent: true });
  alertHeading.append(alertLabel, unread, markRead, clearAlerts);
  watchHost.append(watchForm, translated('p', 'intel.loadedOnly', 'intel-scope'), translated('p', 'intel.visibleOnly', 'intel-scope'), watchStatus, storageStatus, areas, alertHeading, alerts);

  const watch = createWatchlist({ onChange: (state) => renderWatch(state) });
  watchState = watch.getState();

  function renderBrief() {
    briefBody.replaceChildren();
    if (!brief) { renderRecords(); return; }
    const overview = element('dl', 'intel-summary');
    const total = brief.viewport?.available === false || brief.totalCount == null
      ? t('intel.unavailable') : `${brief.totalCountIsLowerBound ? '>=' : ''}${brief.totalCount}`;
    overview.append(pair('intel.bounds', formatBounds(brief.bounds)), pair('intel.generatedAt', formatTime(brief.generatedAt)), pair('intel.total', total));
    briefBody.append(overview);
    if (brief.partialCoverage) briefBody.append(element('p', 'intel-muted', t('intel.partialCoverage')));
    if (!brief.layers.length) briefBody.append(element('p', 'intel-muted', t('intel.noLayers')));
    for (const layer of brief.layers) {
      const row = element('section', 'intel-layer');
      const heading = element('div', 'intel-layer-heading');
      const key = `intel.status.${layer.error ? 'error' : layer.status}`;
      heading.append(element('h3', '', translatedValue(`intel.layer.${layer.id}`, layer.name)), element('span', 'intel-layer-status', translatedValue(key, t('intel.status.unknown'))));
      const details = element('dl');
      details.append(pair('intel.source', layer.source || t('intel.unknown')), pair('intel.updatedAt', formatTime(layer.lastUpdated)), pair('intel.count', layer.count == null ? t('intel.unavailable') : `${layer.countIsLowerBound ? '>=' : ''}${layer.count}`));
      for (const key of ['category', 'operator', 'country', 'usage']) {
        const group = layer.breakdown?.[key];
        if (!group) continue;
        const values = (group.values || []).map(({ value, count }) => `${value}: ${count}`);
        if (group.unknownCount) values.push(`${t('intel.unknown')}: ${group.unknownCount}`);
        if (group.otherCount) values.push(`${t('intel.other')}: ${group.otherCount}`);
        details.append(pair(`intel.breakdown.${key}`, values.join(', ') || t('intel.unknown')));
      }
      row.append(heading, details);
      if (layer.sample.length) {
        const samples = element('ul', 'intel-samples');
        samples.setAttribute('aria-label', t('intel.samples'));
        for (const record of layer.sample) {
          const item = element('li');
          item.append(element('strong', '', record.name || record.id || t('intel.unknown')));
          if (record.simulated) item.append(element('span', 'intel-simulated', t('intel.simulated')));
          item.append(element('span', 'intel-record-meta', `${t('intel.source')}: ${record.source || t('intel.unknown')}`));
          item.append(element('span', 'intel-record-meta', `${t('intel.eventAt')}: ${formatTime(record.eventAt)}`));
          samples.append(item);
        }
        row.append(samples);
      }
      if (layer.truncated) row.append(element('p', 'intel-muted', t('intel.moreRecords')));
      briefBody.append(row);
    }
    renderRecords();
  }

  function rebuildRecordOptions() {
    const layers = Array.isArray(viewSnapshot?.layers) ? viewSnapshot.layers.filter((layer) => layer?.enabled === true && Array.isArray(layer.records)) : [];
    const previous = recordLayerId;
    recordLayer.replaceChildren(element('option', '', t('intel.allLayers')));
    recordLayer.children[0].value = 'all';
    for (const layer of layers) {
      const option = element('option', '', translatedValue(`intel.layer.${layer.id}`, layer.name || layer.id));
      option.value = layer.id;
      recordLayer.append(option);
    }
    recordLayerId = layers.some((layer) => layer.id === previous) || previous === 'all' ? previous : 'all';
    recordLayer.value = recordLayerId;
    recordSort.replaceChildren(...[
      ['name', 'intel.sortName'], ['eventAt', 'intel.sortEventTime'], ['updatedAt', 'intel.sortUpdatedTime'], ['layerName', 'intel.sortLayer'],
    ].map(([value, key]) => { const option = element('option', '', t(key)); option.value = value; return option; }));
    recordSort.value = recordSortBy;
  }

  function renderRecords() {
    if (!recordList) return;
    rebuildRecordOptions();
    const result = getViewportRecordPage(viewSnapshot, { query: recordQuery, layerId: recordLayerId, sortBy: recordSortBy, sortDir: recordSortDir, page: recordPage, pageSize: recordPageSize });
    recordPage = result.page;
    recordList.replaceChildren();
    recordMeta.textContent = `${result.total} · ${result.page}/${result.pageCount}`;
    recordPrev.disabled = !result.hasPrevious; recordNext.disabled = !result.hasNext; recordExport.disabled = result.total === 0;
    if (!result.total) { recordList.append(element('p', 'intel-muted', t('intel.noRecords'))); return; }
    for (const record of result.records) {
      const row = element('button', 'intel-record-row'); row.type = 'button'; row.dataset.recordId = record.id || '';
      const title = record.name || record.id || t('intel.unknown');
      row.append(element('strong', '', title), element('span', 'intel-record-meta', `${translatedValue(`intel.layer.${record.layerId}`, record.layerName)} · ${record.type || t('intel.unknown')}`));
      if (Number.isFinite(record.latitude) && Number.isFinite(record.longitude)) {
        listen(row, 'click', () => { void locateRecord(record); });
      }
      recordList.append(row);
    }
  }

  async function locateRecord(record) {
    try {
      const result = await guard.runAction('fly_to_location', { latitude: record.latitude, longitude: record.longitude, rangeM: 5000, waitForArrival: true });
      if (result?.ok === false && !result.cancelled) status(briefStatus, 'intel.operationError');
    } catch { status(briefStatus, 'intel.operationError'); }
  }

  function exportRecords() {
    const records = getViewportRecords(viewSnapshot, { query: recordQuery, layerId: recordLayerId, sortBy: recordSortBy, sortDir: recordSortDir });
    if (!records.length) return;
    const csv = viewportRecordsToCsv(records);
    const URLApi = documentRef.defaultView?.URL || globalThis.URL;
    const BlobApi = documentRef.defaultView?.Blob || globalThis.Blob;
    if (!URLApi?.createObjectURL || !BlobApi) return;
    const link = documentRef.createElement('a'); link.href = URLApi.createObjectURL(new BlobApi([csv], { type: 'text/csv;charset=utf-8' })); link.download = 'intelligence-viewport.csv'; link.click?.();
    documentRef.defaultView?.setTimeout?.(() => URLApi.revokeObjectURL?.(link.href), 0);
  }

  function downloadReport(format) {
    if (!viewSnapshot) return;
    const files = createReportExports(viewSnapshot, latestComparison, { locale: getLocale() });
    const file = files[format];
    if (!file) return;
    const URLApi = documentRef.defaultView?.URL || globalThis.URL;
    const BlobApi = documentRef.defaultView?.Blob || globalThis.Blob;
    if (!URLApi?.createObjectURL || !BlobApi) return;
    const link = documentRef.createElement('a');
    link.href = URLApi.createObjectURL(new BlobApi([file.content], { type: file.mimeType }));
    link.download = `intelligence-viewport-report.${file.extension}`;
    link.click?.();
    documentRef.defaultView?.setTimeout?.(() => URLApi.revokeObjectURL?.(link.href), 0);
    reportMenu.hidden = true;
  }

  function printReport() {
    if (!viewSnapshot) return;
    const files = createReportExports(viewSnapshot, latestComparison, { locale: getLocale() });
    const URLApi = documentRef.defaultView?.URL || globalThis.URL;
    if (!URLApi?.createObjectURL) return;
    const url = URLApi.createObjectURL(new (documentRef.defaultView?.Blob || globalThis.Blob)([files.html.content], { type: files.html.mimeType }));
    const popup = documentRef.defaultView?.open?.(url, '_blank', 'noopener,noreferrer');
    if (popup) {
      popup.addEventListener?.('load', () => popup.print?.(), { once: true });
      documentRef.defaultView?.setTimeout?.(() => URLApi.revokeObjectURL?.(url), 1000);
    }
    reportMenu.hidden = true;
  }

  const doWatch = (operation) => {
    if (destroyed) return;
    try { operation(); status(watchStatus); }
    catch (error) { status(watchStatus, error?.code === 'WATCH_LIMIT' ? 'intel.watchLimit' : 'intel.invalidWatch'); }
  };

  function areaRow(area) {
    const row = element('section', 'intel-area');
    const name = element('input');
    name.value = area.name;
    name.maxLength = 80;
    name.dataset.areaName = area.id;
    name.setAttribute('aria-label', `${t('intel.rename')}: ${area.name}`);
    const rename = () => doWatch(() => watch.rename(area.id, name.value));
    const saveName = button('', 'save', 'intel.saveName', rename);
    saveName.dataset.areaSaveName = area.id;
    saveName.disabled = true;
    listen(name, 'input', () => { saveName.disabled = !name.value.trim() || name.value.trim() === area.name; });
    listen(name, 'change', rename);
    listen(name, 'keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      if (!saveName.disabled) rename();
    });
    const nameRow = element('div', 'intel-area-name');
    nameRow.append(name, saveName);
    const controls = element('div', 'intel-area-controls');
    const rules = area.rules || {};
    const threshold = element('input');
    threshold.type = 'number'; threshold.min = '1'; threshold.max = '50000'; threshold.step = '1';
    threshold.value = rules.countThreshold == null ? '' : String(rules.countThreshold);
    threshold.placeholder = t('intel.threshold'); threshold.setAttribute('aria-label', t('intel.threshold'));
    const sustained = element('input');
    sustained.type = 'number'; sustained.min = '0'; sustained.max = '604800'; sustained.step = '1';
    sustained.value = rules.sustainedMs ? String(Math.round(rules.sustainedMs / 1000)) : '0';
    sustained.placeholder = t('intel.sustainedSeconds'); sustained.setAttribute('aria-label', t('intel.sustainedSeconds'));
    const saveRules = button('', 'tune', 'intel.saveRules', () => doWatch(() => watch.updateRules(area.id, {
      countThreshold: threshold.value ? Number(threshold.value) : null,
      categories: rules.categories || [],
      sustainedMs: Number(sustained.value || 0) * 1000,
      quietHours: rules.quietHours || null,
    })));
    const rulesRow = element('div', 'intel-watch-rules');
    rulesRow.append(threshold, sustained, saveRules);
    const paused = element('input');
    paused.type = 'checkbox';
    paused.checked = !area.enabled;
    paused.dataset.areaPaused = area.id;
    listen(paused, 'change', () => doWatch(() => watch.toggle(area.id, !paused.checked)));
    const pauseLabel = element('label', 'intel-pause');
    pauseLabel.append(paused, element('span', '', t('intel.paused')));
    const locate = button('', 'my_location', 'intel.locate', () => { void locateArea(area); });
    locate.dataset.areaLocate = area.id;
    const remove = button('', 'delete', 'intel.remove', () => doWatch(() => watch.remove(area.id)));
    remove.dataset.areaRemove = area.id;
    controls.append(pauseLabel, locate, remove);
    row.append(nameRow, element('p', 'intel-area-bounds', formatBounds(area.bounds)), rulesRow, controls);
    return row;
  }

  function renderWatch(state = watchState, force = false) {
    if (destroyed) return;
    watchState = state;
    status(storageStatus, state.storageError ? 'intel.storageError' : '');
    const nextAreas = JSON.stringify(state.areas);
    if (force || nextAreas !== areasKey) {
      areasKey = nextAreas;
      areas.replaceChildren(...state.areas.map(areaRow));
      if (!state.areas.length) areas.append(element('p', 'intel-muted', t('intel.noAreas')));
    }
    const nextAlerts = JSON.stringify(state.alerts);
    if (!force && nextAlerts === alertsKey) return;
    alertsKey = nextAlerts;
    const unreadCount = state.alerts.filter((alert) => !alert.read).length;
    unread.textContent = String(unreadCount);
    unread.setAttribute('aria-label', `${t('intel.unread')}: ${unreadCount}`);
    markRead.disabled = unreadCount === 0;
    clearAlerts.disabled = state.alerts.length === 0;
    alerts.replaceChildren();
    if (!state.alerts.length) alerts.append(element('p', 'intel-muted', t('intel.noChanges')));
    for (const alert of state.alerts) {
      const row = element('article', 'intel-alert');
      row.dataset.read = String(alert.read);
      row.append(element('strong', '', alert.name || alert.recordId), element('p', 'intel-muted', `${alert.areaName} / ${translatedValue(`intel.layer.${alert.layerId}`, alert.layerName)}`));
      if (alert.simulated) row.append(element('span', 'intel-simulated', t('intel.simulated')));
      const details = element('dl');
      details.append(pair('intel.source', alert.source || t('intel.unknown')), pair('intel.eventAt', formatTime(alert.eventAt)), pair('intel.observedAt', formatTime(alert.observedAt)));
      row.append(details);
      const processNote = element('input');
      processNote.maxLength = 500; processNote.placeholder = t('intel.processNote'); processNote.setAttribute('aria-label', t('intel.processNote'));
      processNote.value = alert.note || '';
      const process = button('', 'task_alt', alert.processed ? 'intel.processed' : 'intel.markProcessed', () => doWatch(() => watch.markProcessed(alert.id, processNote.value)));
      process.disabled = alert.processed;
      row.append(processNote, process);
      alerts.append(row);
    }
  }

  function refresh() {
    if (destroyed) return Promise.resolve(null);
    if (refreshing) return refreshing;
    refreshButton.disabled = true;
    refreshing = Promise.resolve().then(async () => {
      try {
        const next = await getSnapshot();
        if (destroyed) return null;
        snapshot = next;
        const nextViewSnapshot = await readViewSnapshot({ getViewSnapshot });
        if (destroyed) return null;
        viewSnapshot = nextViewSnapshot;
        brief = buildViewBrief(nextViewSnapshot);
        watchAdd.disabled = !next?.bounds || !next?.layers?.some((layer) => layer.enabled);
        status(briefStatus);
        renderBrief();
        watch.observe(next);
        return brief;
      } catch {
        if (!destroyed) {
          snapshot = null;
          viewSnapshot = null;
          watchAdd.disabled = true;
          status(briefStatus, 'intel.refreshError');
          watch.observe(null);
          renderRecords();
        }
        return null;
      } finally {
        refreshing = null;
        if (!destroyed) refreshButton.disabled = false;
      }
    });
    return refreshing;
  }

  async function captureSnapshot() {
    await refresh();
    if (destroyed || !viewSnapshot?.viewport?.available) {
      status(briefStatus, 'intel.snapshotUnavailable');
      return;
    }
    snapshotHistory.capture(viewSnapshot);
    status(briefStatus, 'intel.snapshotSaved');
  }

  async function compareSnapshot() {
    await refresh();
    if (destroyed || !viewSnapshot?.viewport?.available) {
      status(briefStatus, 'intel.snapshotUnavailable');
      return;
    }
    const previous = snapshotHistory.latest();
    if (!previous) {
      status(briefStatus, 'intel.snapshotNeedBaseline');
      return;
    }
    const comparison = diffViewportSnapshots(previous, viewSnapshot);
    latestComparison = comparison;
    if (comparison.boundsChanged) {
      status(briefStatus, 'intel.snapshotBoundsChanged');
      return;
    }
    // Disabled/error/truncated layers are intentionally skipped. A single
    // unavailable layer must not hide a valid comparison for ready layers.
    if (comparison.comparable === false && !comparison.layers.some((layer) => layer.comparable === true)) {
      status(briefStatus, 'intel.snapshotNotComparable');
      return;
    }
    const changed = comparison.layers.filter((layer) => layer.countDelta !== null
      && (layer.countDelta !== 0 || layer.added.length || layer.removed.length));
    const hasMapChanges = comparison.movedCount > 0 || changed.some((layer) => layer.added.length || layer.removed.length);
    if (hasMapChanges) {
      try { await drawComparison(comparison); } catch { /* Keep the textual diff when map rendering is unavailable. */ }
    }
    if (!changed.length && comparison.movedCount === 0) {
      status(briefStatus, 'intel.snapshotNoChanges');
      return;
    }
    const summary = changed.slice(0, 4).map((layer) => `${layer.layerName}: ${layer.countDelta > 0 ? '+' : ''}${layer.countDelta}`).join('；');
    const moved = comparison.moved.slice(0, 4).map((item) => `${item.name || item.id} (${Math.round(item.distanceM)} m)`).join('，');
    briefStatus.textContent = `${t('intel.snapshotChanged')} ${[summary, moved ? `${t('intel.snapshotMoved')}: ${moved}` : ''].filter(Boolean).join('；')}`;
    briefStatus.hidden = false;
  }

  async function saveArea() {
    if (destroyed || saving) return;
    saving = true;
    watchAdd.disabled = true;
    try {
      await refresh();
      if (destroyed) return;
      doWatch(() => {
        watch.add({ name: watchName.value, bounds: snapshot?.bounds, layerIds: snapshot?.layers?.filter((layer) => layer.enabled).map((layer) => layer.id) });
        watch.observe(snapshot);
        watchName.value = '';
      });
    } finally {
      saving = false;
      if (!destroyed) watchAdd.disabled = !snapshot?.bounds || !snapshot?.layers?.some((layer) => layer.enabled);
    }
  }

  async function interpret() {
    if (destroyed || analyzing) return;
    analyzing = true;
    interpretButton.disabled = true;
    try {
      await refresh();
      if (destroyed) return;
      openConversation?.();
      await sendText(t('intel.briefPrompt'), { intent: 'brief' });
    } catch { if (!destroyed) status(briefStatus, 'intel.analysisError'); }
    finally { analyzing = false; if (!destroyed) interpretButton.disabled = false; }
  }

  async function locateArea(area) {
    try {
      const result = await guard.runAction('fly_to_location', locationArgs(area.bounds));
      if (result?.ok === false && !result.cancelled) status(watchStatus, 'intel.operationError');
    } catch { status(watchStatus, 'intel.operationError'); }
  }

  async function actionOperation(operation) {
    if (destroyed) return;
    try { await operation(); }
    catch { actionState = { ...actionState, error: 'Map action failed' }; }
    if (!destroyed) renderAction(guard?.getState() ?? actionState);
  }

  function undo() {
    if (!guard.getState().canUndo) return;
    beforeUndo();
    return guard.undo();
  }

  function renderAction(state) {
    if (destroyed) return;
    actionState = state;
    if (undoButton) {
      undoButton.disabled = !state.canUndo;
      undoButton.title = state.undoName ? t('intel.undoNamed', { action: t(`ai.action.${state.undoName}`) }) : t('intel.undo');
      undoButton.setAttribute('aria-label', undoButton.title);
    }
    actionHost.hidden = !state.pending && !state.executing && !state.error && !state.canUndo;
    const previewKey = state.pending ? JSON.stringify([state.pending.name, state.pending.arguments, state.error]) : null;
    const countdownText = state.pending ? t('intel.autoConfirm', { seconds: state.pending.remainingSeconds }) : '';
    // Countdown ticks must not replace buttons while the user focuses or clicks them.
    if (previewKey && previewKey === actionPreviewKey && actionCountdown) {
      actionCountdown.textContent = countdownText;
      return;
    }
    actionPreviewKey = previewKey;
    actionCountdown = null;
    actionHost.replaceChildren();
    if (state.pending) {
      actionHost.append(element('h3', '', t('intel.confirmTitle')), element('strong', '', t(`ai.action.${state.pending.name}`)));
      if (Number.isFinite(state.pending.remainingSeconds)) {
        actionCountdown = element('p', 'intel-action-countdown', countdownText);
        actionCountdown.id = 'intel-action-countdown';
        actionCountdown.setAttribute('role', 'status');
        actionCountdown.setAttribute('aria-live', 'polite');
        actionCountdown.setAttribute('aria-atomic', 'true');
        actionHost.append(actionCountdown);
      }
      const details = element('dl', 'intel-action-params');
      for (const [key, value] of Object.entries(state.pending.arguments)) {
        if (key === 'waitForArrival') continue;
        const valueKey = key === 'layerId' ? `intel.layer.${value}`
          : key === 'locationId' ? `intel.location.${value}` : `intel.value.${value}`;
        details.append(pair(`intel.param.${key}`, translatedValue(valueKey, String(value))));
      }
      actionHost.append(details);
      if (!details.children.length) actionHost.append(element('p', 'intel-muted', t('intel.noParameters')));
      const controls = element('div', 'intel-action-controls');
      controls.append(button('intel-action-reject', 'close', 'intel.reject', () => { void actionOperation(() => guard.reject()); }, { text: true }), button('intel-action-confirm', 'check', 'intel.confirm', () => { void actionOperation(() => guard.confirm()); }, { text: true }));
      actionHost.append(controls);
    } else if (state.executing) actionHost.append(element('p', '', t('intel.executing')));
    if (state.error) {
      const key = state.error === 'Map action could not be undone' ? 'intel.undoError'
        : state.error === 'Map state could not be saved' ? 'intel.snapshotError' : 'intel.actionError';
      actionHost.append(element('p', 'intel-status', t(key)));
    }
    if (state.canUndo && !state.pending) {
      const restore = button('intel-action-undo', 'undo', 'intel.undo', () => { void actionOperation(undo); });
      const row = element('div', 'intel-toolbar');
      row.append(restore, element('span', 'intel-muted', t('intel.undoNamed', { action: t(`ai.action.${state.undoName}`) })));
      actionHost.append(row);
    }
  }

  if (undoButton) listen(undoButton, 'click', () => { void actionOperation(undo); }, true);
  const visibleRefresh = () => { if (documentRef.visibilityState !== 'hidden') void refresh(); };
  listen(documentRef, 'visibilitychange', visibleRefresh, true);
  const timerHost = documentRef.defaultView ?? globalThis;
  const timer = timerHost.setInterval(visibleRefresh, 10000);
  timer?.unref?.();
  cleanup.push(() => timerHost.clearInterval(timer));
  const translate = () => {
    for (const update of localized) update();
    actionPreviewKey = null;
    renderBrief(); renderWatch(watchState, true); renderAction(actionState);
  };
  cleanup.push(subscribeLocale(translate));
  translate();
  void refresh();
  return { refresh, renderAction, destroy() { destroyed = true; for (const stop of cleanup) stop(); } };
}
