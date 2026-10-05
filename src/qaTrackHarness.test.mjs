import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../scripts/track-regression.mjs', import.meta.url), 'utf8');
const APP_ORIGIN = 'http://localhost:4173';

// Execute the actual registered callbacks without launching Chromium or running
// the full tracking scenario. This also checks that the mocks are wired up.
function pageHandler(event, context = {}) {
  const start = source.indexOf(`    page.on('${event}', (`);
  assert.notEqual(start, -1, `${event} handler is registered`);
  const end = source.indexOf('\n    });', start);
  assert.notEqual(end, -1, `${event} handler closes`);
  let handler;
  vm.runInNewContext(source.slice(start, end + '\n    });'.length), {
    page: { on: (name, callback) => { assert.equal(name, event); handler = callback; } },
    APP_ORIGIN, URL, process: { env: {} }, ...context,
  });
  return handler;
}

function intercept(pathname, method = 'GET', origin = APP_ORIGIN) {
  const outcomes = [];
  pageHandler('request')({
    url: () => `${origin}${pathname}`,
    method: () => method,
    respond: (response) => outcomes.push({ kind: 'respond', response }),
    continue: () => outcomes.push({ kind: 'continue' }),
  });
  assert.equal(outcomes.length, 1, 'each request is handled exactly once');
  return outcomes[0];
}

for (const endpoint of ['/api/openai/hud-summary', '/api/ai/hud-summary']) {
  test(`tracking QA answers ${endpoint} without calling an LLM`, () => {
    const result = intercept(endpoint, 'POST');
    assert.equal(result.kind, 'respond');
    assert.equal(result.response.status, 200);
    assert.equal(result.response.contentType, 'application/json');
    assert.deepEqual(JSON.parse(result.response.body), { summary: 'QA globe ready' });
  });
}

test('tracking QA reports optional voiceprint service unavailable without contacting it', () => {
  const result = intercept('/api/ai/voiceprint/status');
  assert.equal(result.kind, 'respond');
  assert.equal(result.response.status, 200);
  assert.deepEqual(JSON.parse(result.response.body), {
    available: false, enabled: false, mode: 'observe', profiles: [],
  });
});

test('tracking QA does not mask other routes, origins, or method regressions', () => {
  for (const [path, method, origin] of [
    ['/api/opensky', 'GET'],
    ['/api/ai/chat', 'POST'],
    ['/api/ai/voiceprint/enroll', 'POST'],
    ['/api/ai/voiceprint/status', 'POST'],
    ['/api/ai/hud-summary', 'GET'],
    ['/api/openai/hud-summary', 'GET'],
    ['/api/ai/hud-summary/extra', 'POST'],
    ['/api/ai/hud-summary', 'POST', 'https://example.com'],
    ['/api/openai/hud-summary', 'POST', 'https://example.com'],
    ['/api/ai/voiceprint/status', 'GET', 'https://example.com'],
  ]) {
    assert.equal(intercept(path, method, origin).kind, 'continue', `${method} ${origin || APP_ORIGIN}${path}`);
  }
});

test('tracking QA still records HTTP errors from optional service endpoints', () => {
  const consoleErrors = [];
  const failedResponses = [];
  const recordConsole = pageHandler('console', { consoleErrors, sawLog: {} });
  const recordResponse = pageHandler('response', { failedResponses });
  const url = `${APP_ORIGIN}/api/ai/voiceprint/status`;
  recordConsole({
    text: () => 'Failed to load resource: the server responded with a status of 503',
    type: () => 'error', location: () => ({ url }),
  });
  recordResponse({ status: () => 503, url: () => url });
  assert.equal(consoleErrors.length, 1);
  assert.match(consoleErrors[0], /voiceprint\/status/);
  assert.deepEqual(failedResponses, [`HTTP 503 ${url}`]);
});

async function chromeCandidates(executablePath) {
  const start = source.indexOf('const CHROME_EXECUTABLE_CANDIDATES = [');
  const end = source.indexOf('].filter(Boolean);', start);
  assert.ok(start >= 0 && end > start, 'browser candidates are declared');
  return vm.runInNewContext(`(async () => {
    ${source.slice(start, end + '].filter(Boolean);'.length)}
    return CHROME_EXECUTABLE_CANDIDATES;
  })()`, {
    process: { env: { PUPPETEER_EXECUTABLE_PATH: 'C:/custom/chrome.exe' } },
    puppeteer: { executablePath },
  });
}

test('tracking QA resolves Puppeteer 25 browser paths before checking the filesystem', async () => {
  const candidates = await chromeCandidates(() => Promise.resolve('C:/pinned/chrome.exe'));
  assert.equal(candidates[0], 'C:/custom/chrome.exe');
  assert.equal(candidates[1], 'C:/pinned/chrome.exe');
  assert.ok(candidates.every((candidate) => typeof candidate === 'string'));
});

test('tracking QA retains explicit browser paths when Puppeteer path discovery rejects', async () => {
  const rejectedPath = Promise.reject(new Error('Browser cache unavailable'));
  // Observe the rejection separately so the pre-fix failure is the actual
  // unresolved candidate rather than an unrelated unhandled-rejection report.
  rejectedPath.catch(() => {});
  const candidates = await chromeCandidates(() => rejectedPath);
  assert.equal(candidates[0], 'C:/custom/chrome.exe');
  assert.ok(candidates.every((candidate) => typeof candidate === 'string'));
});
