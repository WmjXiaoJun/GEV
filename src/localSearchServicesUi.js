import { getLocale, subscribeLocale, t } from './i18n.js';

const SERVICES = Object.freeze([
  Object.freeze({ id: 'firecrawl', name: 'Firecrawl', url: 'http://127.0.0.1:3002/', port: '3002' }),
  Object.freeze({ id: 'searxng', name: 'SearXNG', url: 'http://127.0.0.1:58080/', port: '58080' }),
]);

function checkedTime(value) {
  if (typeof value !== 'string' || value.length > 80) return '';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function checkedLocalUrl(value, service) {
  if (typeof value !== 'string' || value.length > 256) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
      && parsed.port === service.port && parsed.pathname === '/' && !parsed.username && !parsed.password
      && !parsed.search && !parsed.hash ? parsed.href : null;
  } catch { return null; }
}

/** Only known local service identities, safe base URLs and connection facts reach the DOM. */
export function normalizeLocalServices(payload) {
  const incoming = Array.isArray(payload?.services) ? payload.services : [];
  return {
    checkedAt: checkedTime(payload?.checkedAt),
    services: SERVICES.map((service) => {
      const entry = incoming.find((candidate) => candidate?.id === service.id);
      const url = checkedLocalUrl(entry?.url, service);
      return { id: service.id, name: service.name, url: url || service.url,
        status: url && entry?.status === 'ok' ? 'ok' : 'failed', checkedAt: checkedTime(entry?.checkedAt) };
    }),
  };
}

function serviceRow(documentRef, service, phase) {
  const row = documentRef.createElement('tr');
  row.dataset.localServiceId = service.id;
  const name = documentRef.createElement('th');
  name.setAttribute('scope', 'row');
  name.textContent = service.name;
  const address = documentRef.createElement('td');
  const link = documentRef.createElement('a');
  link.href = service.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = service.url.replace(/\/$/, '');
  address.append(link);
  const state = documentRef.createElement('td');
  const label = documentRef.createElement('span');
  const stateKey = phase === 'loading' ? 'localChecking' : phase === 'idle' ? 'localUnchecked'
    : service.status === 'ok' ? 'localConnected' : 'localUnavailable';
  label.className = 'local-search-service-status';
  label.dataset.status = phase === 'done' ? service.status : phase;
  label.textContent = t(`keySetup.${stateKey}`);
  state.append(label);
  row.append(name, address, state);
  return row;
}

export function initLocalSearchServices({ root, documentRef = globalThis.document, fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
  if (!root || !documentRef?.createElement || !fetchImpl) return null;
  const rows = root.querySelector('[data-local-search-rows]');
  const refreshButton = root.querySelector('[data-local-search-refresh]');
  const checked = root.querySelector('[data-local-search-checked]');
  if (!rows || !refreshButton) return null;
  let snapshot = normalizeLocalServices(null);
  let phase = 'idle';
  let visible = false;
  let destroyed = false;
  let request = null;
  let generation = 0;

  const render = () => {
    if (destroyed) return;
    rows.replaceChildren(...snapshot.services.map((service) => serviceRow(documentRef, service, phase)));
    root.setAttribute('aria-busy', String(phase === 'loading'));
    refreshButton.disabled = phase === 'loading';
    refreshButton.title = t('keySetup.localRefresh');
    refreshButton.setAttribute('aria-label', t('keySetup.localRefresh'));
    if (checked) {
      checked.textContent = snapshot.checkedAt ? t('keySetup.localCheckedAt', {
        time: new Date(snapshot.checkedAt).toLocaleTimeString(getLocale(), { hour12: false }),
      }) : '';
      checked.setAttribute('datetime', snapshot.checkedAt);
    }
  };

  async function refresh() {
    if (destroyed || !visible || request) return;
    const controller = new AbortController();
    const current = ++generation;
    request = controller;
    phase = 'loading';
    render();
    const timer = setTimeout(() => controller.abort(), 12000);
    timer.unref?.();
    try {
      const response = await fetchImpl('/api/ai/local-services', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('LOCAL_SERVICES_UNAVAILABLE');
      const payload = await response.json();
      if (destroyed || !visible || current !== generation) return;
      controller.signal.throwIfAborted();
      snapshot = normalizeLocalServices(payload);
      phase = 'done';
    } catch {
      if (destroyed || !visible || current !== generation) return;
      snapshot = normalizeLocalServices(null);
      phase = 'done';
    } finally {
      clearTimeout(timer);
      if (current === generation) {
        request = null;
        if (!destroyed && visible) render();
      }
    }
  }

  function hide() {
    visible = false;
    generation += 1;
    request?.abort();
    request = null;
    if (phase === 'loading') phase = snapshot.checkedAt ? 'done' : 'idle';
  }

  function destroy() {
    if (destroyed) return;
    hide();
    destroyed = true;
    unsubscribe();
    refreshButton.removeEventListener('click', onRefresh);
  }

  const onRefresh = () => { void refresh(); };
  const unsubscribe = subscribeLocale(render);
  refreshButton.addEventListener('click', onRefresh);
  render();
  return { show() { if (destroyed) return; visible = true; return refresh(); }, hide, refresh, destroy };
}
