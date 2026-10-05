import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { admitKeySetupRequest } from './keySetupCore.mjs';

const source = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
const start = source.indexOf('function terrainHeightsProxy() {');
const end = source.indexOf('\n}\n', start) + 2;

function terrainHandlers(env = {}) {
  const routes = new Map();
  let diskReads = 0;
  const plugin = vm.runInNewContext(`${source.slice(start, end)}; terrainHeightsProxy()`, {
    path: { join: (...parts) => parts.join('/') },
    process: { cwd: () => '/test', env },
    admitKeySetupRequest, URL, Map, JSON, Date,
    fsp: { readFile: async () => { diskReads += 1; throw new Error('No cache'); } },
    setInterval: () => ({ unref() {} }),
    parseTerrainPoints: () => null,
    normalizeTerrainViewport: () => { throw new Error('Invalid viewport'); },
  });
  plugin.configureServer({ middlewares: { use: (route, handler) => routes.set(route, handler) } });
  return { routes, diskReads: () => diskReads };
}

async function request(handler, overrides = {}) {
  let status; let body;
  const req = {
    method: 'GET', url: '/', socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost:4173' }, ...overrides,
  };
  await handler(req, {
    writeHead: (value) => { status = value; },
    end: (value) => { body = JSON.parse(value); },
  });
  return { status, body };
}

for (const route of ['/api/terrain/heights', '/api/terrain/analyze']) {
  test(`${route} rejects LAN, proxy, and cross-origin requests before disk/network work`, async () => {
    for (const overrides of [
      { socket: { remoteAddress: '192.168.1.20' } },
      { headers: { host: 'localhost:4173', 'x-forwarded-for': '198.51.100.1' } },
      { headers: { host: 'foreign.example:4173' } },
      { headers: { host: 'localhost:4173', origin: 'https://foreign.example' } },
      { method: 'POST', headers: { host: 'localhost:4173', 'content-type': 'application/json' } },
    ]) {
      const harness = terrainHandlers();
      const result = await request(harness.routes.get(route), overrides);
      assert.equal(result.status, 403);
      assert.equal(harness.diskReads(), 0);
    }
  });

  test(`${route} preserves local access and disables active sharing`, async () => {
    const local = terrainHandlers();
    assert.equal((await request(local.routes.get(route))).status, 400);
    const shared = terrainHandlers({ PINOKIO_SHARE_LOCAL: 'true' });
    assert.equal((await request(shared.routes.get(route))).status, 403);
    assert.equal(shared.diskReads(), 0);
  });
}
