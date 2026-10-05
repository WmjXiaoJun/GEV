import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIRECRAWL_LIMITS, publicFirecrawlConfig, publicSearchConfig, resolveFirecrawlConfig, resolveSearchConfig, searchFirecrawl, validateFirecrawlBaseUrl } from './firecrawl.mjs';

const response = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json' },
});

test('Firecrawl config is server-only and validates HTTPS endpoints', () => {
  assert.equal(resolveFirecrawlConfig({ FIRECRAWL_API_KEY: ' key ' }).configured, true);
  assert.equal(publicFirecrawlConfig({ FIRECRAWL_API_KEY: 'secret' }).apiKey, undefined);
  assert.equal(validateFirecrawlBaseUrl('https://api.firecrawl.dev/v2/'), 'https://api.firecrawl.dev/v2');
  assert.equal(validateFirecrawlBaseUrl('http://127.0.0.1:9999/v2'), 'http://127.0.0.1:9999/v2');
  for (const value of ['http://example.com/v2', 'https://user:pass@example.com/v2', 'https://example.com/v2?key=x']) {
    assert.throws(() => validateFirecrawlBaseUrl(value), { code: 'SEARCH_INVALID_CONFIG' });
  }
  for (const value of ['https://10.1.2.3/v2', 'https://192.168.1.2/v2', 'https://169.254.169.254/v2',
    'https://[fd00::1]/v2', 'https://metadata.google.internal/v2', 'https://metadata.google.internal./v2', 'https://localhost./v2']) {
    assert.throws(() => validateFirecrawlBaseUrl(value), { code: 'SEARCH_INVALID_CONFIG' });
  }
});

test('search sends bounded query to Firecrawl and normalizes web results', async () => {
  let request;
  const result = await searchFirecrawl({
    config: { configured: true, apiKey: 'private', baseUrl: 'https://firecrawl.test/v2' },
    query: '  current airport notices  ', limit: 2,
    fetchImpl: async (url, options) => { request = { url, options }; return response({ success: true, data: [
      { title: 'Airport notice', url: 'https://example.com/a', description: 'Summary', markdown: '# Details' },
      { title: 'bad', url: 'javascript:alert(1)' },
      { metadata: { sourceURL: 'https://example.com/b', title: 'Metadata result' }, snippet: 'Second' },
    ] }); },
  });
  assert.equal(request.url, 'https://firecrawl.test/v2/search');
  assert.equal(request.options.headers.Authorization, 'Bearer private');
  assert.deepEqual(JSON.parse(request.options.body), { query: 'current airport notices', limit: 2, sources: [{ type: 'web' }] });
  assert.equal(result.count, 2);
  assert.deepEqual(result.results.map(({ url }) => url), ['https://example.com/a', 'https://example.com/b']);
  assert.equal(result.results[1].title, 'Metadata result');
});

test('search rejects invalid input and hides upstream failures', async () => {
  const config = { configured: true, apiKey: 'private', baseUrl: 'https://firecrawl.test/v2' };
  await assert.rejects(searchFirecrawl({ config, query: '' }), { code: 'SEARCH_INVALID_REQUEST' });
  await assert.rejects(searchFirecrawl({ config, query: 'x'.repeat(FIRECRAWL_LIMITS.maxQueryLength + 1) }), { code: 'SEARCH_INVALID_REQUEST' });
  await assert.rejects(searchFirecrawl({ config, query: 'x', limit: 0 }), { code: 'SEARCH_INVALID_REQUEST' });
  await assert.rejects(searchFirecrawl({ config, query: 'x', fetchImpl: async () => response({}, 401) }), { code: 'SEARCH_AUTH_ERROR' });
  await assert.rejects(searchFirecrawl({ config, query: 'x', fetchImpl: async () => { throw new Error('private endpoint'); } }), { code: 'SEARCH_CONNECTION_ERROR' });
});

test('Agent Pro local search is preferred and never sends its local header to the browser', async () => {
  const env = { AGENT_PRO_SEARCH_ENABLED: '1', AGENT_PRO_SEARCH_URL: 'http://127.0.0.1:6637/api/search', AGENT_PRO_LOCAL_HEADER: 'agent-pro-local' };
  assert.equal(resolveSearchConfig(env).provider, 'agent-pro');
  assert.equal(publicSearchConfig(env).configured, true);
  assert.doesNotMatch(JSON.stringify(publicSearchConfig(env)), /agent-pro-local|localHeader|apiKey/);
  let request;
  const result = await searchFirecrawl({ env, config: { configured: false }, query: '机场新闻', limit: 2,
    fetchImpl: async (url, options) => { request = { url, options }; return response({ success: true, results: [
      { title: 'Airport', url: 'https://example.com/a', description: 'Notice' },
    ] }); },
  });
  assert.equal(result.provider, 'agent-pro');
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.results[0].title, 'Airport');
  assert.equal(request.options.headers['X-Local-Client'], 'agent-pro-local');
  assert.equal(request.options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(request.options.body), { query: '机场新闻', mode: 'web', top_k: 2, include_web: true });
});

test('existing local Firecrawl is keyless while remote endpoints still require a key', async () => {
  const config = resolveFirecrawlConfig({ FIRECRAWL_BASE_URL: 'http://127.0.0.1:3002/v2' });
  assert.equal(config.configured, true);
  assert.equal(publicSearchConfig({ FIRECRAWL_BASE_URL: config.baseUrl }).keyOptional, true);
  assert.equal(resolveFirecrawlConfig({ FIRECRAWL_BASE_URL: 'https://remote.test/v2' }).configured, false);
  let request;
  const result = await searchFirecrawl({ config, query: 'NASA Artemis', fetchImpl: async (url, options) => {
    request = { url, options };
    return response({ success: true, data: { web: [{ url: 'https://www.nasa.gov/artemis/', title: 'Artemis' }] } });
  } });
  assert.equal(request.url, 'http://127.0.0.1:3002/v2/search');
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(request.options.headers['X-Local-Client'], undefined);
  assert.equal(result.count, 1);
  assert.equal(result.ok, true);
});

test('Agent Pro settings reject credential forwarding to remote or non-search URLs', () => {
  const env = { AGENT_PRO_SEARCH_ENABLED: '1', AGENT_PRO_LOCAL_HEADER: 'test-local-secret' };
  for (const url of ['http://remote.test/api/search', 'https://remote.test/api/search',
    'http://127.0.0.1:6637/api/delete', 'http://127.0.0.1:6637/api/search?key=x',
    'http://user:pass@127.0.0.1:6637/api/search', 'http://127.0.0.1:6637/api/search#', 'garbage']) {
    assert.throws(() => resolveSearchConfig({ ...env, AGENT_PRO_SEARCH_URL: url }), { code: 'SEARCH_INVALID_CONFIG' });
  }
  assert.throws(() => resolveSearchConfig({ ...env, AGENT_PRO_SEARCH_ENABLED: 'typo' }), { code: 'SEARCH_INVALID_CONFIG' });
  assert.throws(() => resolveSearchConfig({ ...env, AGENT_PRO_LOCAL_HEADER: 'bad\r\nheader' }), { code: 'SEARCH_INVALID_CONFIG' });
  assert.equal(resolveSearchConfig({ AGENT_PRO_SEARCH_ENABLED: '1' }).configured, false);
  assert.equal(resolveSearchConfig({ AGENT_PRO_SEARCH_ENABLED: '0', AGENT_PRO_SEARCH_URL: 'bad', FIRECRAWL_API_KEY: 'cloud-test' }).provider, 'firecrawl');
});

test('optional invalid search configuration does not prevent public chat settings loading', () => {
  assert.equal(publicSearchConfig({ AGENT_PRO_SEARCH_ENABLED: '0', FIRECRAWL_BASE_URL: 'broken' }).provider, 'firecrawl');
  for (const env of [{ FIRECRAWL_BASE_URL: 'broken' }, { AGENT_PRO_SEARCH_ENABLED: '1', AGENT_PRO_SEARCH_URL: 'broken' }]) {
    const value = publicSearchConfig(env);
    assert.equal(value.configured, false);
    assert.equal(value.error, 'SEARCH_INVALID_CONFIG');
  }
  const config = publicSearchConfig({ AGENT_PRO_SEARCH_ENABLED: '1', AGENT_PRO_LOCAL_HEADER: 'private-local-header', FIRECRAWL_API_KEY: 'private-cloud-key' });
  assert.equal(config.agentPro.keyConfigured, true);
  assert.equal(config.firecrawl.keyConfigured, true);
  assert.doesNotMatch(JSON.stringify(config), /private-local-header|private-cloud-key/);
});

test('upstream failures or malformed envelopes are never reported as empty successful searches', async () => {
  for (const agent of [false, true]) {
    const env = agent ? { AGENT_PRO_SEARCH_ENABLED: '1', AGENT_PRO_LOCAL_HEADER: 'test-local-secret' } : {};
    const config = resolveFirecrawlConfig({ FIRECRAWL_API_KEY: 'test-cloud-secret' });
    for (const payload of [{ success: false, results: [] }, { success: true }, { success: true, results: 'bad' }]) {
      await assert.rejects(searchFirecrawl({ env, config, query: 'NASA', fetchImpl: async () => response(payload) }),
        { code: payload.success === false ? 'SEARCH_UPSTREAM_ERROR' : 'SEARCH_INVALID_RESPONSE' });
    }
  }
});

test('normalized search evidence fits the LLM tool budget without unsafe URLs', async () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/${i}`, title: 'T'.repeat(300),
    description: 'D'.repeat(2000), markdown: 'M'.repeat(8000) }));
  const config = resolveFirecrawlConfig({ FIRECRAWL_API_KEY: 'test-only' });
  const result = await searchFirecrawl({ config, query: 'news', limit: 10,
    fetchImpl: async () => response({ success: true, data: { web: entries } }) });
  assert.equal(result.count, 10);
  assert.ok(JSON.stringify(result).length <= 16000);
  const filtered = await searchFirecrawl({ config, query: 'news', fetchImpl: async () => response({ data: [
    { url: 'javascript:alert(1)' }, { url: 'https://' }, { url: 'https://user:secret@example.com' },
    { url: 'https://safe.test', title: '<script>do not execute</script>' },
  ] }) });
  assert.equal(filtered.count, 1);
});

test('search cancellation is honored before fetch and does not fallback to cloud', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(searchFirecrawl({ env: { AGENT_PRO_SEARCH_ENABLED: '1', AGENT_PRO_LOCAL_HEADER: 'test-only' },
    config: resolveFirecrawlConfig({ FIRECRAWL_API_KEY: 'cloud-key' }), query: 'news', signal: controller.signal,
    fetchImpl: async () => { calls++; return response({ results: [] }); } }), { code: 'SEARCH_CANCELLED' });
  assert.equal(calls, 0);
});
