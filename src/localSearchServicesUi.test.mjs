import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initLocalSearchServices, normalizeLocalServices } from './localSearchServicesUi.js';
import { getLocale, setLocale, t } from './i18n.js';
import { initKeySetup } from './keySetup.js';

const status = { checkedAt: '2026-09-12T08:00:00.000Z', services: [
  { id: 'firecrawl', name: 'Firecrawl', url: 'http://127.0.0.1:3002', status: 'ok', checkedAt: '2026-09-12T08:00:00.000Z' },
  { id: 'searxng', name: 'SearXNG', url: 'http://127.0.0.1:58080', status: 'failed', checkedAt: '2026-09-12T08:00:00.000Z' },
] };

function element() {
  const listeners = new Map();
  const attrs = new Map();
  return {
    children: [], dataset: {}, textContent: '', disabled: false,
    append(...children) { this.children = [...this.children, ...children]; },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, fn) { listeners.set(name, [...listeners.get(name) || [], fn]); },
    removeEventListener(name, fn) { listeners.set(name, (listeners.get(name) || []).filter((entry) => entry !== fn)); },
    emit(name, event = {}) { for (const fn of listeners.get(name) || []) fn(event); },
    setAttribute(name, value) { attrs.set(name, value); },
    getAttribute(name) { return attrs.get(name); },
    remove() {},
  };
}

function fixture(fetchImpl = async () => ({ ok: true, json: async () => status })) {
  const nodes = new Map(['rows', 'refresh', 'checked'].map((key) => [key, element()]));
  const root = { ...element(), querySelector: (selector) => nodes.get(selector.match(/data-local-search-(.*)\]/)?.[1]) };
  const requests = [];
  const ui = initLocalSearchServices({ root, documentRef: { createElement: element }, fetchImpl: async (...args) => {
    requests.push(args); return fetchImpl(...args);
  } });
  return { ui, root, requests, nodes };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('local service data is bounded and ignores secrets, names, unsafe links and unknown statuses', () => {
  for (const url of ['javascript:alert(1)', 'https://external.test', 'http://secret:token@127.0.0.1:3002', 'http://127.0.0.1:3002/?key=secret']) {
    const normalized = normalizeLocalServices({ secret: 'do-not-show', services: [
      { id: 'firecrawl', name: '<script>private</script>', url, status: 'ok', apiKey: 'secret' },
      { id: 'searxng', url: 'http://127.0.0.1:58080', status: 'healthy', checkedAt: '<script>' },
      { id: 'unknown', url: 'https://example.test', status: 'ok' },
    ] });
    assert.equal(normalized.services.length, 2);
    assert.equal(normalized.services[0].status, 'failed');
    assert.equal(normalized.services[1].status, 'failed');
    assert.doesNotMatch(JSON.stringify(normalized), /secret|private|script|unknown|healthy/);
  }
  assert.equal(normalizeLocalServices(null).services.every((entry) => entry.status === 'failed'), true);
});

test('local service checks start on show, use the same-origin endpoint, and render read-only links', async () => {
  const f = fixture();
  try {
    assert.equal(f.requests.length, 0);
    await f.ui.show();
    assert.equal(f.requests[0][0], '/api/ai/local-services');
    assert.equal(f.requests[0][1].cache, 'no-store');
    assert.equal(f.nodes.get('rows').children.length, 2);
    const row = f.nodes.get('rows').children[0];
    const link = row.children[1].children[0];
    assert.equal(link.href, 'http://127.0.0.1:3002/');
    assert.equal(link.target, '_blank');
    assert.match(link.rel, /noreferrer/);
    assert.equal(row.children[2].children[0].textContent, t('keySetup.localConnected'));
    assert.equal(f.nodes.get('refresh').disabled, false);
    assert.ok(f.nodes.get('checked').textContent);
  } finally { f.ui.destroy(); }
});

test('pending checks disable refresh; hide aborts and ignores late responses', async () => {
  let resolve;
  const f = fixture(() => new Promise((done) => { resolve = done; }));
  try {
    const pending = f.ui.show();
    assert.equal(f.nodes.get('refresh').disabled, true);
    f.nodes.get('refresh').emit('click');
    assert.equal(f.requests.length, 1);
    f.ui.hide();
    assert.equal(f.requests[0][1].signal.aborted, true);
    const before = f.nodes.get('rows').children;
    resolve({ ok: true, json: async () => status });
    await pending;
    assert.equal(f.nodes.get('rows').children, before);
  } finally { f.ui.destroy(); }
});

test('destroy detaches controls and blocks late results and future requests', async () => {
  let resolve;
  const f = fixture(() => new Promise((done) => { resolve = done; }));
  const pending = f.ui.show();
  f.ui.destroy();
  const before = f.nodes.get('rows').children;
  resolve({ ok: true, json: async () => status });
  await pending;
  f.nodes.get('refresh').emit('click');
  await f.ui.show();
  assert.equal(f.requests.length, 1);
  assert.equal(f.nodes.get('rows').children, before);
});

test('a timed-out request cannot show late success or leave refresh disabled', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve;
  const f = fixture(() => new Promise((done) => { resolve = done; }));
  try {
    const pending = f.ui.show();
    context.mock.timers.tick(12000);
    assert.equal(f.requests[0][1].signal.aborted, true);
    resolve({ ok: true, json: async () => status });
    await pending;
    assert.equal(f.nodes.get('refresh').disabled, false);
    assert.equal(f.nodes.get('rows').children[0].children[2].children[0].textContent, t('keySetup.localUnavailable'));
  } finally { f.ui.destroy(); }
});

test('network and malformed responses render unavailable and allow a fresh retry', async () => {
  for (const failure of [() => { throw new Error('private-secret'); }, () => ({ ok: false }), () => ({ ok: true, json: async () => null })]) {
    let calls = 0;
    const f = fixture(async () => ++calls === 1 ? failure() : { ok: true, json: async () => status });
    try {
      await f.ui.show();
      assert.equal(f.nodes.get('rows').children[0].children[2].children[0].textContent, t('keySetup.localUnavailable'));
      f.nodes.get('refresh').emit('click');
      await settle();
      assert.equal(calls, 2);
      assert.equal(f.nodes.get('rows').children[0].children[2].children[0].textContent, t('keySetup.localConnected'));
    } finally { f.ui.destroy(); }
  }
});

test('service statuses and refresh tooltip update with locale without new network calls', async () => {
  const previous = getLocale();
  const f = fixture();
  try {
    await f.ui.show();
    setLocale('en', { persist: false });
    assert.equal(f.nodes.get('rows').children[0].children[2].children[0].textContent, 'Connected');
    assert.equal(f.nodes.get('refresh').title, 'Refresh local service status');
    setLocale('zh-CN', { persist: false });
    assert.equal(f.nodes.get('rows').children[0].children[2].children[0].textContent, '连接正常');
    assert.equal(f.requests.length, 1);
  } finally { f.ui.destroy(); setLocale(previous, { persist: false }); }
});

test('local services live above existing cloud key rows and do not add key input fields', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const sectionStart = html.indexOf('data-local-search-services');
  const cloudRows = html.indexOf('data-key-setup-rows');
  assert.ok(sectionStart > 0 && sectionStart < cloudRows);
  assert.doesNotMatch(html.slice(sectionStart, cloudRows), /<input|data-env-var/);
  assert.match(html.slice(cloudRows), /data-key-setup-apply/);
});

async function keySetupFixture({ keys, fetchLocal } = {}) {
  const local = fixture();
  local.ui.destroy();
  const chip = { ...element(), querySelector: () => null };
  const hosts = new Map(['rows', 'apply', 'close', 'status'].map((name) => [name, element()]));
  const root = { ...element(), hidden: true, classList: { remove() {}, contains: () => false },
    querySelector: (selector) => selector === '[data-local-search-services]' ? local.root
      : hosts.get(selector.match(/data-key-setup-(.*)\]/)?.[1]), querySelectorAll: () => [],
  };
  const doc = { ...element(), getElementById: (id) => id === 'key-setup-chip' ? chip : root, createElement: element, defaultView: element() };
  const key = { id: 'openai', title: 'OPENAI', set: false, getUrl: 'https://example.test', envVars: ['OPENAI_API_KEY'], tier: 'metered' };
  const calls = [];
  const requests = [];
  const ui = await initKeySetup({ documentRef: doc, fetchImpl: async (path, options) => {
    calls.push(path);
    requests.push({ path, options });
    if (path === '/api/ai/local-services' && fetchLocal) return fetchLocal(path, options);
    return { ok: true, json: async () => path === '/api/setup/status' ? { keys: keys || [key], total: 1, setCount: 0 } : status };
  } });
  return { ui, calls, local, hosts, key, doc, chip, root, requests };
}

test('enhancements dialog refreshes local services on open without replacing cloud key rows', async () => {
  const { ui, calls, local, hosts, key } = await keySetupFixture();
  try {
    assert.equal(calls.includes('/api/ai/local-services'), false);
    ui.open();
    await settle();
    assert.equal(calls.includes('/api/ai/local-services'), true);
    assert.equal(local.nodes.get('rows').children.length, 2);
    assert.equal(hosts.get('rows').children[0].dataset.keyId, 'openai');
    ui.render({ keys: [key], total: 1, setCount: 0 });
    assert.equal(local.nodes.get('rows').children.length, 2);
    assert.equal(hosts.get('rows').children[0].children.at(-1).children[0].dataset.envVar, 'OPENAI_API_KEY');
  } finally { ui.destroy?.(); }
});

test('BFCache pagehide aborts checks but keeps enhancements controls available on restoration', async () => {
  const f = await keySetupFixture({ fetchLocal: (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  try {
    f.chip.emit('click');
    assert.equal(f.calls.filter((path) => path === '/api/ai/local-services').length, 1);
    f.doc.defaultView.emit('pagehide', { persisted: true });
    assert.equal(f.requests.at(-1).options.signal.aborted, true);
    f.chip.emit('click');
    assert.equal(f.calls.filter((path) => path === '/api/ai/local-services').length, 2);
    f.hosts.get('apply').emit('click');
    await settle();
    assert.equal(f.hosts.get('status').textContent, t('keySetup.pasteAtLeastOneKey'));
    f.doc.defaultView.emit('pagehide', { persisted: true });
    assert.equal(f.requests.at(-1).options.signal.aborted, true);
    f.chip.emit('click');
    assert.equal(f.calls.filter((path) => path === '/api/ai/local-services').length, 3);
    f.doc.defaultView.emit('pagehide', { persisted: false });
    assert.equal(f.requests.at(-1).options.signal.aborted, true);
    f.chip.emit('click');
    assert.equal(f.calls.filter((path) => path === '/api/ai/local-services').length, 3);
  } finally { f.ui.destroy(); }
});

test('Firecrawl cloud key row is clearly optional and remains localized', async () => {
  const previous = getLocale();
  const key = { id: 'firecrawl', title: 'FIRECRAWL', unlocks: 'Web search', set: false,
    getUrl: 'https://www.firecrawl.dev', envVars: ['FIRECRAWL_API_KEY'], tier: 'metered' };
  try {
    for (const locale of ['en', 'zh-CN']) {
      setLocale(locale, { persist: false });
      const f = await keySetupFixture({ keys: [key] });
      try {
        const row = f.hosts.get('rows').children[0];
        assert.equal(row.children[0].children[1].textContent, locale === 'en' ? 'FIRECRAWL CLOUD' : 'Firecrawl 云服务');
        assert.equal(row.children[1].textContent, t('keySetup.firecrawlCloudDescription'));
        assert.equal(row.children[0].children[1].dataset.i18n, 'keySetup.firecrawlCloudTitle');
        assert.equal(row.children[1].dataset.i18n, 'keySetup.firecrawlCloudDescription');
        assert.equal(row.children.at(-1).children[0].dataset.envVar, 'FIRECRAWL_API_KEY');
      } finally { f.ui.destroy(); }
    }
  } finally { setLocale(previous, { persist: false }); }
});
