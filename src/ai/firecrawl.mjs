import { isSafeRemoteBaseUrlHost } from './providers.js';

const DEFAULT_BASE_URL = 'https://api.firecrawl.dev/v2';
const DEFAULT_AGENT_PRO_URL = 'http://127.0.0.1:6637/api/search';
const MAX_QUERY_LENGTH = 500;
const MAX_RESULTS = 10;
const MAX_RESPONSE_BYTES = 1_500_000;
const SEARCH_TIMEOUT_MS = 20_000;
const RESULT_BUDGET = 14_000;

const failure = (code, message = code) => Object.assign(new Error(message), { code });
const isLoopback = (url) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);

function stringSetting(value, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw failure('SEARCH_INVALID_CONFIG');
  }
  return value.trim();
}

export function validateFirecrawlBaseUrl(value = DEFAULT_BASE_URL) {
  const raw = stringSetting(value, 2048) || DEFAULT_BASE_URL;
  let parsed;
  try { parsed = new URL(raw); } catch { throw failure('SEARCH_INVALID_CONFIG'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (!/^https?:\/\//i.test(raw) || raw.includes('\\') || parsed.username || parsed.password
    || (!loopback && !isSafeRemoteBaseUrlHost(parsed.hostname))
    || /[?#]/.test(raw) || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))) {
    throw failure('SEARCH_INVALID_CONFIG');
  }
  return parsed.href.replace(/\/+$/, '');
}

export function resolveFirecrawlConfig(env = {}) {
  const apiKey = stringSetting(env.FIRECRAWL_API_KEY, 2048);
  const baseUrl = validateFirecrawlBaseUrl(env.FIRECRAWL_BASE_URL || DEFAULT_BASE_URL);
  const keyOptional = isLoopback(baseUrl);
  return { provider: 'firecrawl', baseUrl, apiKey, keyOptional, configured: Boolean(apiKey || keyOptional) };
}

export function agentProSearchEnabled(value) {
  const setting = stringSetting(value, 8).toLowerCase();
  if (!['', '0', 'false', '1', 'true', 'yes'].includes(setting)) throw failure('SEARCH_INVALID_CONFIG');
  return ['1', 'true', 'yes'].includes(setting);
}

export function validateAgentProSearchUrl(value = DEFAULT_AGENT_PRO_URL) {
  const baseUrl = validateFirecrawlBaseUrl(value || DEFAULT_AGENT_PRO_URL);
  if (!isLoopback(baseUrl) || new URL(baseUrl).pathname !== '/api/search') throw failure('SEARCH_INVALID_CONFIG');
  return baseUrl;
}

function resolveAgentProConfig(env = {}) {
  const baseUrl = validateAgentProSearchUrl(env.AGENT_PRO_SEARCH_URL);
  const localHeader = stringSetting(env.AGENT_PRO_LOCAL_HEADER, 512);
  if (localHeader && !/^[\x21-\x7e]+$/.test(localHeader)) throw failure('SEARCH_INVALID_CONFIG');
  return { provider: 'agent-pro', baseUrl, localHeader, keyOptional: false, configured: Boolean(localHeader) };
}

export function resolveSearchConfig(env = {}) {
  return agentProSearchEnabled(env.AGENT_PRO_SEARCH_ENABLED) ? resolveAgentProConfig(env) : resolveFirecrawlConfig(env);
}

export function publicSearchConfig(env = {}) {
  const safe = (resolve, provider) => {
    try {
      const config = resolve(env);
      return { provider: config.provider, baseUrl: config.baseUrl, configured: config.configured,
        keyConfigured: Boolean(config.apiKey || config.localHeader), keyOptional: config.keyOptional };
    } catch {
      return { provider, baseUrl: '', configured: false, keyConfigured: false, keyOptional: false, error: 'SEARCH_INVALID_CONFIG' };
    }
  };
  const firecrawl = safe(resolveFirecrawlConfig, 'firecrawl');
  const agentPro = safe(resolveAgentProConfig, 'agent-pro');
  const selected = ['1', 'true', 'yes'].includes(String(env.AGENT_PRO_SEARCH_ENABLED || '').trim().toLowerCase()) ? 'agent-pro' : 'firecrawl';
  return { ...safe(resolveSearchConfig, selected), firecrawl, agentPro };
}

export function publicFirecrawlConfig(env = {}) {
  const { apiKey: _apiKey, ...publicConfig } = resolveFirecrawlConfig(env);
  return publicConfig;
}

function checkedQuery(query) {
  if (typeof query !== 'string') throw failure('SEARCH_INVALID_REQUEST');
  const value = query.trim();
  if (!value || value.length > MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw failure('SEARCH_INVALID_REQUEST');
  }
  return value;
}

function checkedLimit(limit) {
  if (limit === undefined) return 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) throw failure('SEARCH_INVALID_REQUEST');
  return limit;
}

async function readJsonBounded(response, signal) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw failure('SEARCH_INVALID_RESPONSE');
  if (!response.body) throw failure('SEARCH_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw failure('SEARCH_INVALID_RESPONSE');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { throw failure('SEARCH_INVALID_RESPONSE'); }
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

function normalizeResult(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const metadata = entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata) ? entry.metadata : {};
  const url = cleanText(entry.url ?? entry.link ?? metadata.sourceURL ?? metadata.url, 2048);
  if (!/^https?:\/\//i.test(url)) return null;
  try { const parsed = new URL(url); if (parsed.username || parsed.password) return null; } catch { return null; }
  const title = cleanText(entry.title ?? metadata.title, 200);
  const description = cleanText(entry.description ?? entry.snippet ?? metadata.description, 400);
  const markdown = cleanText(entry.markdown ?? entry.content, 700);
  const publishedAt = cleanText(entry.publishedAt ?? entry.date ?? metadata.publishedTime, 80);
  const category = cleanText(entry.category, 80);
  return { title: title || url, url, ...(description ? { description } : {}), ...(markdown ? { markdown } : {}), ...(publishedAt ? { publishedAt } : {}), ...(category ? { category } : {}) };
}

function extractResults(payload) {
  if (payload?.success === false) throw failure('SEARCH_UPSTREAM_ERROR');
  const raw = Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.data?.web) ? payload.data.web
      : Array.isArray(payload?.web) ? payload.web
        : Array.isArray(payload?.results) ? payload.results : null;
  if (!raw) throw failure('SEARCH_INVALID_RESPONSE');
  return raw.map(normalizeResult).filter(Boolean).slice(0, MAX_RESULTS);
}

function searchRequest(config, query, limit) {
  if (config?.provider === 'agent-pro') {
    const checked = resolveAgentProConfig({ AGENT_PRO_SEARCH_URL: config.baseUrl, AGENT_PRO_LOCAL_HEADER: config.localHeader });
    if (!checked.configured) throw failure('SEARCH_NOT_CONFIGURED');
    return { url: checked.baseUrl, headers: { 'X-Local-Client': checked.localHeader },
      body: { query, mode: 'web', top_k: limit, include_web: true } };
  }
  const checked = resolveFirecrawlConfig({ FIRECRAWL_BASE_URL: config?.baseUrl, FIRECRAWL_API_KEY: config?.apiKey });
  if (!checked.configured) throw failure('SEARCH_NOT_CONFIGURED');
  return { url: `${checked.baseUrl}/search`, headers: checked.apiKey ? { Authorization: `Bearer ${checked.apiKey}` } : {},
    body: { query, limit, sources: [{ type: 'web' }] } };
}

function boundedResults(entries) {
  return entries.reduce((output, entry) => {
    const next = [...output, entry];
    return JSON.stringify(next).length <= RESULT_BUDGET ? next : output;
  }, []);
}

export async function searchFirecrawl({ config, env, query, limit = 5, fetchImpl = fetch, signal } = {}) {
  if (signal?.aborted) throw failure('SEARCH_CANCELLED');
  const safeQuery = checkedQuery(query);
  const safeLimit = checkedLimit(limit);
  const selected = env && agentProSearchEnabled(env.AGENT_PRO_SEARCH_ENABLED) ? resolveSearchConfig(env)
    : config || resolveSearchConfig(env);
  const request = searchRequest(selected, safeQuery, safeLimit);
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), SEARCH_TIMEOUT_MS);
  timer.unref?.();
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
  try {
    const response = await fetchImpl(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      signal: combinedSignal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw failure('SEARCH_AUTH_ERROR');
      if (response.status === 429) throw failure('SEARCH_RATE_LIMITED');
      throw failure('SEARCH_UPSTREAM_ERROR');
    }
    const payload = await readJsonBounded(response, combinedSignal);
    const entries = extractResults(payload).slice(0, safeLimit);
    const results = boundedResults(entries);
    return { ok: true, available: true, provider: selected?.provider || 'firecrawl', query: safeQuery, results, count: results.length,
      ...(results.length < entries.length ? { truncated: true } : {}),
      searchedAt: new Date().toISOString() };
  } catch (error) {
    if (signal?.aborted) throw failure('SEARCH_CANCELLED');
    if (timeoutController.signal.aborted) throw failure('SEARCH_TIMEOUT');
    if (error?.code?.startsWith('SEARCH_')) throw error;
    throw failure('SEARCH_CONNECTION_ERROR');
  } finally { clearTimeout(timer); }
}

export const FIRECRAWL_LIMITS = Object.freeze({ maxQueryLength: MAX_QUERY_LENGTH, maxResults: MAX_RESULTS });
