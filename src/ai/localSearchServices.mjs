const SERVICES = Object.freeze([
  Object.freeze({ id: 'firecrawl', name: 'Firecrawl', url: 'http://127.0.0.1:3002', healthPath: '/' }),
  Object.freeze({ id: 'searxng', name: 'SearXNG', url: 'http://127.0.0.1:58080', healthPath: '/healthz' }),
]);

async function probe(service, { fetchImpl, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    combined.throwIfAborted();
    const response = await fetchImpl(`${service.url}${service.healthPath}`, { signal: combined, redirect: 'error' });
    await response.body?.cancel();
    return response.ok ? 'ok' : 'failed';
  } catch {
    return 'failed';
  } finally { clearTimeout(timer); }
}

/** Only connectivity, not search quality or dependency health, is asserted here. */
export async function localSearchServicesStatus({ fetchImpl = fetch, signal, now = Date.now } = {}) {
  const statuses = await Promise.all(SERVICES.map((service) => probe(service, { fetchImpl, signal })));
  const checkedAt = new Date(now()).toISOString();
  return { checkedAt, services: SERVICES.map(({ id, name, url }, index) => ({ id, name, url, status: statuses[index], checkedAt })) };
}
