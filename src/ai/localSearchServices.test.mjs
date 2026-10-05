import test from 'node:test';
import assert from 'node:assert/strict';
import { localSearchServicesStatus } from './localSearchServices.mjs';

test('local services probes use only the fixed Agent Pro runtime endpoints', async () => {
  const calls = [];
  const status = await localSearchServicesStatus({ now: () => 0, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response('ok');
  } });
  assert.deepEqual(calls.map((call) => call.url), ['http://127.0.0.1:3002/', 'http://127.0.0.1:58080/healthz']);
  for (const { options } of calls) {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined);
  }
  assert.deepEqual(status.services.map(({ id, url, status }) => ({ id, url, status })), [
    { id: 'firecrawl', url: 'http://127.0.0.1:3002', status: 'ok' },
    { id: 'searxng', url: 'http://127.0.0.1:58080', status: 'ok' },
  ]);
  assert.equal(status.checkedAt, '1970-01-01T00:00:00.000Z');
});

test('service failure never hides the other service or leaks network exception text', async () => {
  for (const failed of [new Response('private error', { status: 503 }), new Error('private address details')]) {
    const result = await localSearchServicesStatus({ fetchImpl: async (url) => {
      if (url.includes('3002')) { if (failed instanceof Error) throw failed; return failed; }
      return new Response('ok');
    } });
    assert.deepEqual(result.services.map(({ status }) => status), ['failed', 'ok']);
    assert.doesNotMatch(JSON.stringify(result), /private/);
  }
});

test('local status respects cancellation without issuing network requests', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const result = await localSearchServicesStatus({ signal: controller.signal, fetchImpl: async () => { calls++; return new Response('ok'); } });
  assert.equal(calls, 0);
  assert.deepEqual(result.services.map(({ status }) => status), ['failed', 'failed']);
});

test('stalled local services time out and release the client', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = localSearchServicesStatus({ fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }) });
  t.mock.timers.tick(3000);
  assert.deepEqual((await pending).services.map(({ status }) => status), ['failed', 'failed']);
});
