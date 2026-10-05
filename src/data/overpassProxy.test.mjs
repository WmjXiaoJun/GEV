// Overpass proxy Tier A hardening (voice-engine evaluation doc §4.1, field test
// 2026-07-23): region/state boundary pivots return multi-MB coastline geometry that
// blew the old 12 MB read cap and 16 s client budget (Sicily never traced). The proxy
// now simplifies giant `out geom` payloads server-side before caching/serving, and
// boundary-class queries (is_in / pivot) get a longer disk TTL — boundaries change
// ≈never. Pure-function tests, no network.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  simplifyOverpassPayloadBody,
  isOverpassBoundaryQuery,
  resolveOverpassPreflight,
  fetchOverpassPayload,
  isCacheableOverpassPayload,
} from '../../vite.config.js';

const successPayload = (extras = {}) => ({
  status: 200, body: JSON.stringify({ elements: [] }), contentType: 'application/json',
  ...extras,
});

test('Overpass retries mirror access failures before returning a successful response', async () => {
  const calls = [];
  const outcomes = [403, 406, 200];
  const payload = await fetchOverpassPayload('data=query', 1024, {
    upstreams: ['https://first.test', 'https://second.test', 'https://third.test'],
    fetchImpl: async (url) => {
      calls.push(url);
      const status = outcomes[calls.length - 1];
      return new Response(status === 200 ? '{"elements":[{"type":"node","id":7}]}' : '<h1>Access denied</h1>', { status });
    },
  });
  assert.deepEqual(calls, ['https://first.test', 'https://second.test', 'https://third.test']);
  assert.equal(payload.status, 200);
  assert.equal(JSON.parse(payload.body).elements[0].id, 7);
});

test('Overpass preserves syntax errors without trying every public mirror', async () => {
  let calls = 0;
  const payload = await fetchOverpassPayload('data=bad-query', 1024, {
    upstreams: ['https://first.test', 'https://second.test'],
    fetchImpl: async () => { calls++; return new Response('parse error', { status: 400 }); },
  });
  assert.equal(calls, 1);
  assert.equal(payload.status, 400);
  assert.equal(payload.body, 'parse error');
  assert.equal(isCacheableOverpassPayload(payload), false);
});

test('Overpass retains rate-limit and runtime-error failover behavior', async () => {
  const responses = [
    new Response('{"remark":"runtime error: timed out","elements":[]}', { status: 200 }),
    new Response('Too many requests', { status: 429 }),
    new Response('Service unavailable', { status: 503 }),
  ];
  let calls = 0;
  const payload = await fetchOverpassPayload('data=query', 1024, {
    upstreams: ['https://first.test', 'https://second.test', 'https://third.test'],
    fetchImpl: async () => responses[calls++],
  });
  assert.equal(calls, 3);
  assert.equal(payload.status, 429);
  assert.equal(payload.rateLimited, true);
  assert.equal(isCacheableOverpassPayload(payload), false);
});

test('Overpass throws when every mirror refuses access', async () => {
  await assert.rejects(fetchOverpassPayload('data=query', 1024, {
    upstreams: ['https://first.test', 'https://second.test'],
    fetchImpl: async () => new Response('Not Acceptable', { status: 406 }),
  }), /returned 406/);
});

test('Overpass rejects successful HTTP responses without usable JSON elements', async () => {
  let calls = 0;
  const payload = await fetchOverpassPayload('data=query', 1024, {
    upstreams: ['https://first.test', 'https://second.test'],
    fetchImpl: async () => new Response(++calls === 1 ? '<h1>Maintenance</h1>' : '{"elements":[]}', { status: 200 }),
  });
  assert.equal(calls, 2);
  assert.equal(isCacheableOverpassPayload(payload), true);
});

test('only successful Overpass data can enter or survive the cache', () => {
  assert.equal(isCacheableOverpassPayload(successPayload()), true);
  for (const status of [204, 301, 400, 403, 406, 429, 500]) {
    assert.equal(isCacheableOverpassPayload({ status, body: '<h1>Error</h1>' }), false);
  }
  assert.equal(isCacheableOverpassPayload(successPayload({ body: '{"remark":"runtime error: timed out","elements":[]}' })), false);
  assert.equal(isCacheableOverpassPayload(successPayload({ body: '{"unexpected":[]}' })), false);
  assert.equal(isCacheableOverpassPayload(successPayload({ rateLimited: true })), false);
});

test('preflight ignores legacy 406 caches and preserves valid cached payloads', async () => {
  let admits = 0;
  const options = {
    cacheKey: 'query',
    memoryCache: new Map([['query', { status: 406, body: 'blocked', cachedAt: 900 }]]),
    inFlight: new Map(),
    readDisk: async () => ({ status: 406, body: 'blocked', cachedAt: 900 }),
    allowUpstream: () => { admits++; return true; },
    now: 1000,
  };
  assert.equal((await resolveOverpassPreflight(options)).source, 'UPSTREAM');
  assert.equal(admits, 1);
  const disk = successPayload({ cachedAt: 900 });
  const recovered = await resolveOverpassPreflight({ ...options, readDisk: async () => disk });
  assert.equal(recovered.source, 'DISK');
  assert.equal(recovered.payload, disk);
  assert.equal(admits, 1);
});

test('preflight checks memory, in-flight, then disk before consuming limiter quota', async () => {
  const key = 'normalized query';
  const fresh = successPayload({ id: 'memory', cachedAt: 900 });
  const joined = successPayload({ id: 'inflight', cachedAt: 950 });
  const disk = successPayload({ id: 'disk', cachedAt: 975 });
  let diskReads = 0;
  let limiterCalls = 0;
  const allowUpstream = () => { limiterCalls += 1; return true; };

  const memoryHit = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map([[key, fresh]]),
    inFlight: new Map([[key, Promise.resolve(joined)]]),
    readDisk: async () => { diskReads += 1; return disk; },
    allowUpstream,
    now: 1000,
    cacheMs: 200,
  });
  assert.equal(memoryHit.source, 'HIT');
  assert.equal(memoryHit.payload, fresh);
  assert.equal(diskReads, 0, 'memory hit must short-circuit before disk');
  assert.equal(limiterCalls, 0, 'memory hit must not consume limiter quota');

  const inFlightHit = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map([[key, { id: 'stale', cachedAt: 0 }]]),
    inFlight: new Map([[key, Promise.resolve(joined)]]),
    readDisk: async () => { diskReads += 1; return disk; },
    allowUpstream,
    now: 1000,
    cacheMs: 200,
  });
  assert.equal(inFlightHit.source, 'INFLIGHT');
  assert.equal(inFlightHit.payload, joined);
  assert.equal(diskReads, 0, 'in-flight join must short-circuit before disk');
  assert.equal(limiterCalls, 0, 'in-flight join must not consume limiter quota');

  const diskHit = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map(),
    inFlight: new Map(),
    readDisk: async () => { diskReads += 1; return disk; },
    allowUpstream,
  });
  assert.equal(diskHit.source, 'DISK');
  assert.equal(diskHit.payload, disk);
  assert.equal(diskReads, 1);
  assert.equal(limiterCalls, 0, 'disk hit must not consume limiter quota');

  const upstreamMiss = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map(),
    inFlight: new Map(),
    readDisk: async () => { diskReads += 1; return null; },
    allowUpstream,
  });
  assert.equal(upstreamMiss.source, 'UPSTREAM');
  assert.equal(diskReads, 2, 'disk must be checked before upstream admission');
  assert.equal(limiterCalls, 1, 'only a complete cache miss consumes quota');

  const denied = await resolveOverpassPreflight({
    cacheKey: key,
    memoryCache: new Map(),
    inFlight: new Map(),
    readDisk: async () => null,
    allowUpstream: () => false,
  });
  assert.equal(denied.source, 'RATE_LIMITED');
});

/** Synthetic dense ring: N points on a circle with sub-tolerance jitter. */
function denseRing(n, { latC = 37.5, lonC = 14.2, radiusDeg = 0.5 } = {}) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    // Jitter far below the simplification tolerance so the ring is genuinely
    // redundant — a correct simplifier should collapse most of it.
    const jitter = (i % 7) * 0.000004;
    pts.push({
      lat: latC + Math.sin(a) * (radiusDeg + jitter),
      lon: lonC + Math.cos(a) * (radiusDeg + jitter),
    });
  }
  pts.push({ ...pts[0] }); // closed ring
  return pts;
}

const TEST_OPTS = { minBytes: 0, minPoints: 200, toleranceDeg: 0.0004 };

test('simplify: giant way geometry is decimated, endpoints preserved', () => {
  const ring = denseRing(4000);
  const body = JSON.stringify({ elements: [{ type: 'way', id: 1, geometry: ring }] });
  const out = JSON.parse(simplifyOverpassPayloadBody(body, TEST_OPTS));
  const g = out.elements[0].geometry;
  assert.ok(g.length < ring.length * 0.5, `should shed most redundant points, got ${g.length}/${ring.length}`);
  assert.ok(g.length >= 16, `must keep enough points to stay a ring, got ${g.length}`);
  assert.deepEqual(g[0], ring[0]);
  assert.deepEqual(g[g.length - 1], ring[ring.length - 1]);
});

test('simplify: relation member geometries are decimated too', () => {
  const ring = denseRing(3000);
  const body = JSON.stringify({
    elements: [{
      type: 'relation',
      id: 2,
      members: [
        { type: 'way', role: 'outer', geometry: ring },
        { type: 'node', role: 'admin_centre' }, // no geometry — must survive untouched
      ],
    }],
  });
  const out = JSON.parse(simplifyOverpassPayloadBody(body, TEST_OPTS));
  assert.ok(out.elements[0].members[0].geometry.length < ring.length * 0.5);
  assert.equal(out.elements[0].members[1].geometry, undefined);
});

test('simplify: small geometries (building footprints) pass through untouched', () => {
  const square = [
    { lat: 30.27, lon: -97.74 }, { lat: 30.271, lon: -97.74 },
    { lat: 30.271, lon: -97.741 }, { lat: 30.27, lon: -97.741 },
    { lat: 30.27, lon: -97.74 },
  ];
  const body = JSON.stringify({ elements: [{ type: 'way', id: 3, geometry: square }] });
  const out = JSON.parse(simplifyOverpassPayloadBody(body, TEST_OPTS));
  assert.deepEqual(out.elements[0].geometry, square);
});

test('simplify: geometry stays within tolerance of the original shape', () => {
  const ring = denseRing(4000);
  const body = JSON.stringify({ elements: [{ type: 'way', id: 4, geometry: ring }] });
  const out = JSON.parse(simplifyOverpassPayloadBody(body, TEST_OPTS));
  const g = out.elements[0].geometry;
  // Every original vertex must lie near SOME kept vertex — a circle of kept
  // points at spacing s has every dropped point within ~s/2 along the arc, and
  // DP guarantees perpendicular deviation ≤ tolerance. Loose sanity bound: no
  // original point farther than 8× tolerance from the nearest kept point pair
  // is possible for a smooth ring; check a sampled subset for speed.
  for (let i = 0; i < ring.length; i += 97) {
    const p = ring[i];
    let best = Infinity;
    for (let j = 1; j < g.length; j++) {
      const d = pointSegDistDeg(p, g[j - 1], g[j]);
      if (d < best) best = d;
    }
    assert.ok(best <= TEST_OPTS.toleranceDeg * 1.01, `vertex ${i} deviates ${best} deg`);
  }
});

test('simplify: sub-threshold bodies and non-JSON pass through byte-identical', () => {
  const tiny = JSON.stringify({ elements: [{ type: 'way', geometry: denseRing(3000) }] });
  assert.equal(simplifyOverpassPayloadBody(tiny, { ...TEST_OPTS, minBytes: tiny.length + 1 }), tiny);
  const junk = 'this is not json {';
  assert.equal(simplifyOverpassPayloadBody(junk, TEST_OPTS), junk);
});

test('boundary-class queries detected for the long disk TTL', () => {
  assert.equal(isOverpassBoundaryQuery(
    '[out:json][timeout:25];is_in(37.5,14.2)->.a;area.a["boundary"="administrative"]["admin_level"];out tags;',
  ), true);
  assert.equal(isOverpassBoundaryQuery(
    '[out:json][timeout:25];area(3600039152)->.x;rel(pivot.x);out geom;',
  ), true);
  // The enclosing-compound sweep and road fetches keep the default TTL.
  assert.equal(isOverpassBoundaryQuery(
    '[out:json][timeout:25];( way(around:1200,30.27,-97.74)["leisure"]["name"]; );out geom;',
  ), false);
  assert.equal(isOverpassBoundaryQuery(
    '[out:json][timeout:12];way["highway"~"motorway|trunk"](30.1,-97.9,30.5,-97.5);out geom;',
  ), false);
});

/** Perpendicular distance (deg, planar approx) from p to segment a-b. */
function pointSegDistDeg(p, a, b) {
  const vx = b.lon - a.lon;
  const vy = b.lat - a.lat;
  const wx = p.lon - a.lon;
  const wy = p.lat - a.lat;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(wx, wy);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(p.lon - b.lon, p.lat - b.lat);
  const t = c1 / c2;
  return Math.hypot(wx - t * vx, wy - t * vy);
}
