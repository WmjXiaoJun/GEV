import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createAiHandler, llmProxy } from './proxy.mjs';
import { requestSpeechTranscription } from './speech.mjs';

test('Vite installation does not return Connect as a post-install hook', () => {
  const middleware = { use() { return this; } };
  const plugin = llmProxy();
  assert.equal(plugin.configureServer({ middlewares: middleware }), undefined);
  assert.equal(plugin.configurePreviewServer({ middlewares: middleware }), undefined);
});

test('local-service status is same-origin, bounded and independent of model configuration', async (t) => {
  let calls = 0;
  const request = await serve(t, { getEnv: () => ({}), localServicesStatus: async () => { calls++; return { services: [] }; }, rateLimit: 2 });
  assert.equal((await request('/local-services')).status, 200);
  assert.equal((await request('/local-services', {})).status, 405);
  assert.equal((await request('/local-services', undefined, { Origin: 'https://remote.test' })).status, 403);
  assert.equal((await request('/local-services', undefined, { 'X-Forwarded-For': '1.2.3.4' })).status, 403);
  assert.equal(calls, 1);
  assert.equal((await request('/local-services')).status, 200);
  assert.equal((await request('/local-services')).status, 429);
});

async function serve(t, options = {}) {
  const server = createServer(createAiHandler(options));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body, headers = {}) => fetch(`${origin}${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
  });
  request.origin = origin;
  return request;
}

test('voiceprint routes validate locally and proxy only approved loopback requests', async (t) => {
  const forwarded = [];
  const request = await serve(t, {
    voiceprintRequest: async (input) => {
      forwarded.push(input);
      return input.kind === 'status' ? { available: true, enabled: false, mode: 'observe', profiles: [] } : { ok: true };
    },
  });
  const status = await request('/voiceprint/status', undefined, { 'Content-Type': '' });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { available: true, enabled: false, mode: 'observe', profiles: [] });
  const form = new FormData();
  form.set('file', new Blob([Buffer.from('audio')], { type: 'audio/webm' }), 'sample.webm');
  form.set('profile_id', 'owner');
  const enrolled = await fetch(`${request.origin}/voiceprint/enroll`, { method: 'POST', body: form, headers: { Origin: request.origin } });
  assert.equal(enrolled.status, 200);
  assert.equal(forwarded.at(-1).kind, 'enroll');
  assert.match(forwarded.at(-1).contentType, /^multipart\/form-data; boundary=/);
  assert.equal((await fetch(`${request.origin}/voiceprint/enroll`, { method: 'POST', body: JSON.stringify({ profile_id: '../bad' }), headers: { Origin: request.origin, 'Content-Type': 'application/json' } })).status, 400);
  assert.equal(forwarded.length, 2);
});

test('voiceprint proxy enforces profile and threshold validation and sanitizes upstream errors', async (t) => {
  const request = await serve(t, { voiceprintRequest: async () => { throw Object.assign(new Error('secret'), { code: 'VOICEPRINT_REJECTED' }); } });
  const makeForm = (profile = 'owner', threshold = '0.25') => {
    const form = new FormData();
    form.set('file', new Blob([Buffer.from('audio')], { type: 'audio/wav' }), 'sample.wav');
    if (profile !== null) form.set('profile_id', profile);
    if (threshold !== null) form.set('threshold', threshold);
    return form;
  };
  const invalidThreshold = await fetch(`${request.origin}/voiceprint/verify`, { method: 'POST', body: makeForm('owner', '2'), headers: { Origin: request.origin } });
  assert.equal(invalidThreshold.status, 400);
  assert.equal((await invalidThreshold.json()).code, 'VOICEPRINT_THRESHOLD');
  const invalidId = await fetch(`${request.origin}/voiceprint/enroll`, { method: 'POST', body: makeForm('../bad', null), headers: { Origin: request.origin } });
  assert.equal(invalidId.status, 400);
  assert.equal((await invalidId.json()).code, 'VOICEPRINT_ID');
  const rejected = await fetch(`${request.origin}/voiceprint/verify`, { method: 'POST', body: makeForm(), headers: { Origin: request.origin } });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).code, 'VOICEPRINT_REJECTED');
  const deleted = await fetch(`${request.origin}/voiceprint/profiles/../bad`, { method: 'DELETE', headers: { Origin: request.origin } });
  assert.equal(deleted.status, 404);
});

const gatedSpeechEnv = { GEV_STT_PROVIDER: 'custom', GEV_STT_BASE_URL: 'http://127.0.0.1:8765/v1',
  VOICEPRINT_ENABLED: '1', VOICEPRINT_MODE: 'enforce', VOICEPRINT_PROFILE: 'owner', VOICEPRINT_THRESHOLD: '0.18' };
const gatedAudio = { audio: 'YQ==', mimeType: 'audio/wav', locale: 'zh-CN' };

test('voiceprint errors keep actionable codes and hide private server details', async (t) => {
  for (const [code, status] of [['VOICEPRINT_AUDIO', 400], ['VOICEPRINT_FAILED', 503],
    ['VOICEPRINT_RATE_LIMITED', 429], ['VOICEPRINT_TIMEOUT', 504]]) {
    const request = await serve(t, { voiceprintRequest: async () => {
      throw Object.assign(new Error('private-recording-path'), { code });
    } });
    const response = await request('/voiceprint/status');
    assert.equal(response.status, status);
    const payload = await response.json();
    assert.equal(payload.code, code);
    assert.doesNotMatch(JSON.stringify(payload), /private-recording-path/);
  }
});

test('saved voiceprint configuration is authoritative without restarting the native service', async (t) => {
  let env = { ...gatedSpeechEnv };
  const request = await serve(t, { getEnv: () => env, voiceprintRequest: async () => ({
    available: true, enabled: false, mode: 'observe', profiles: [{ id: 'owner', dimension: 192 }],
  }) });
  let status = await (await request('/voiceprint/status')).json();
  assert.equal(status.enabled, true);
  assert.equal(status.mode, 'enforce');
  assert.equal(status.profile, 'owner');
  assert.equal(status.threshold, 0.18);
  env = { ...env, VOICEPRINT_THRESHOLD: '0.32', VOICEPRINT_MODE: 'observe' };
  status = await (await request('/voiceprint/status')).json();
  assert.equal(status.mode, 'observe');
  assert.equal(status.threshold, 0.32);
});

test('daily speech verifies the audio with the saved threshold before transcription', async (t) => {
  const calls = [];
  const request = await serve(t, { getEnv: () => gatedSpeechEnv,
    voiceprintRequest: async (input) => {
      calls.push('verify');
      assert.equal(input.route, '/voiceprint/verify');
      const form = await new Response(input.body, { headers: { 'Content-Type': input.contentType } }).formData();
      assert.equal(form.get('profile_id'), 'owner');
      assert.equal(form.get('threshold'), '0.18');
      assert.equal(await form.get('file').text(), 'a');
      return { verified: true, profileId: 'owner', distance: 0.1 };
    },
    transcribe: async () => { calls.push('transcribe'); return { text: 'recognized' }; },
  });
  const result = await request('/transcribe', gatedAudio);
  assert.equal(result.status, 200);
  assert.deepEqual(calls, ['verify', 'transcribe']);
  assert.equal((await result.json()).voiceprint.verified, true);
});

test('enforcement rejects mismatches, unavailable engines and malformed verdicts without sending audio to STT', async (t) => {
  for (const verdict of [{ verified: false, profileId: null, distance: 0.7 }, {},
    { verified: 'true' }, { verified: true, profileId: 'different', distance: 0.1 },
    { verified: true, profileId: 'owner', distance: 0.9 }, new Error('private server detail')]) {
    let transcribed = false;
    const request = await serve(t, { getEnv: () => gatedSpeechEnv,
      voiceprintRequest: async () => { if (verdict instanceof Error) throw verdict; return verdict; },
      transcribe: async () => { transcribed = true; return { text: 'must not run' }; },
    });
    const response = await request('/transcribe', gatedAudio);
    assert.notEqual(response.status, 200);
    assert.equal(transcribed, false);
    assert.doesNotMatch(await response.text(), /private server detail/);
  }
});

test('observation does not interrupt transcription when speaker matching fails', async (t) => {
  for (const verdict of [{ verified: false, profileId: null, distance: 0.7 }, new Error('engine unavailable')]) {
    const request = await serve(t, { getEnv: () => ({ ...gatedSpeechEnv, VOICEPRINT_MODE: 'observe' }),
      voiceprintRequest: async () => { if (verdict instanceof Error) throw verdict; return verdict; },
      transcribe: async () => ({ text: 'recognized' }),
    });
    const result = await request('/transcribe', gatedAudio);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).voiceprint.verified, false);
  }
});

test('enforcement rejects nonnumeric and nonfinite voiceprint distances', async (t) => {
  for (const distance of [null, false, '', [], '0.1', undefined, NaN, Infinity, -0.1]) {
    let calls = 0;
    const request = await serve(t, { getEnv: () => gatedSpeechEnv,
      voiceprintRequest: async () => ({ verified: true, profileId: 'owner', distance }),
      transcribe: async () => { calls++; return { text: 'must not run' }; },
    });
    const result = await request('/transcribe', gatedAudio);
    assert.equal(result.status, 403, `distance ${JSON.stringify(distance)} must not pass`);
    assert.equal(calls, 0);
  }
});

test('observation without an enrolled profile leaves speech usable and unmatched', async (t) => {
  let verifications = 0;
  const request = await serve(t, { getEnv: () => ({ ...gatedSpeechEnv, VOICEPRINT_MODE: 'observe', VOICEPRINT_PROFILE: '' }),
    voiceprintRequest: async () => { verifications++; throw new Error('must not verify without a profile'); },
    transcribe: async () => ({ text: 'recognized' }),
  });
  const result = await request('/transcribe', gatedAudio);
  assert.equal(result.status, 200);
  assert.equal(verifications, 0);
  assert.deepEqual((await result.json()).voiceprint, { verified: false, profileId: null, distance: null });
});

test('missing enrollment and invalid gate configuration fail closed before processing audio', async (t) => {
  for (const update of [{ VOICEPRINT_PROFILE: '' }, { VOICEPRINT_THRESHOLD: 'NaN' }, { VOICEPRINT_MODE: 'typo' }]) {
    let calls = 0;
    const request = await serve(t, { getEnv: () => ({ ...gatedSpeechEnv, ...update }),
      voiceprintRequest: async () => { calls++; return { verified: true }; },
      transcribe: async () => { calls++; return { text: 'must not run' }; },
    });
    assert.notEqual((await request('/transcribe', gatedAudio)).status, 200);
    assert.equal(calls, 0);
  }
});

test('config reports provider presence without exposing credentials', async (t) => {
  const request = await serve(t, { getEnv: () => ({ GEV_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test-private-token' }) });
  const response = await request('/config');
  const config = await response.json();
  assert.equal(config.provider, 'deepseek');
  assert.equal(config.configured, true);
  assert.ok(config.providers.some((provider) => provider.id === 'ollama'));
  assert.equal(JSON.stringify(config).includes('test-private-token'), false);
});

test('search endpoint keeps Firecrawl credentials server-side and validates bounded requests', async (t) => {
  const calls = [];
  const request = await serve(t, {
    getEnv: () => ({ FIRECRAWL_API_KEY: 'firecrawl-private' }),
    search: async (input) => { calls.push(input); return { available: true, provider: 'firecrawl', query: input.query, results: [], count: 0 }; },
  });
  const result = await request('/search', { query: 'latest airport status', limit: 3 });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { available: true, provider: 'firecrawl', query: 'latest airport status', results: [], count: 0 });
  assert.equal(calls[0].config.apiKey, 'firecrawl-private');
  const config = await (await request('/config')).json();
  assert.equal(config.search.configured, true);
  assert.equal(Object.hasOwn(config.search, 'apiKey'), false);
  const invalid = await request('/search', { query: 'x'.repeat(501) });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, 'SEARCH_INVALID_REQUEST');
});

test('search endpoint maps provider failures to safe status codes', async (t) => {
  const request = await serve(t, {
    getEnv: () => ({ FIRECRAWL_API_KEY: 'firecrawl-private' }),
    search: async () => { throw Object.assign(new Error('private Firecrawl response'), { code: 'SEARCH_TIMEOUT' }); },
  });
  const result = await request('/search', { query: 'news' });
  assert.equal(result.status, 504);
  assert.deepEqual(await result.json(), { error: 'Search provider timed out', code: 'SEARCH_TIMEOUT' });
});

test('search config supports shared local Firecrawl and optional Agent Pro without breaking chat', async (t) => {
  let env = { FIRECRAWL_BASE_URL: 'http://127.0.0.1:3002/v2' };
  const request = await serve(t, { getEnv: () => env });
  let value = await (await request('/config')).json();
  assert.equal(value.search.configured, true);
  assert.equal(value.search.keyOptional, true);
  env = { AGENT_PRO_SEARCH_ENABLED: '1', AGENT_PRO_LOCAL_HEADER: 'test-local-client-secret', FIRECRAWL_BASE_URL: 'invalid-inactive' };
  value = await (await request('/config')).json();
  assert.equal(value.search.provider, 'agent-pro');
  assert.equal(value.search.configured, true);
  assert.doesNotMatch(JSON.stringify(value), /test-local-client-secret/);
  env = { FIRECRAWL_BASE_URL: 'broken' };
  const configResponse = await request('/config');
  assert.equal(configResponse.status, 200);
  assert.equal((await configResponse.json()).search.error, 'SEARCH_INVALID_CONFIG');
});

test('search proxy preserves real local results and never forwards browser credentials', async (t) => {
  const received = [];
  const upstream = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    received.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(parts)) });
    const entry = { url: 'https://www.nasa.gov/artemis/', title: 'Artemis', content: 'Mission overview' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/search' ? { success: true, results: [entry] } : { success: true, data: { web: [entry] } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  let env = { FIRECRAWL_BASE_URL: `${base}/v2` };
  const request = await serve(t, { getEnv: () => env });
  let result = await (await request('/search', { query: 'NASA Artemis', limit: 3 })).json();
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.results[0].title, 'Artemis');
  assert.equal(received[0].headers.authorization, undefined);
  env = { AGENT_PRO_SEARCH_ENABLED: '1', AGENT_PRO_SEARCH_URL: `${base}/api/search`, AGENT_PRO_LOCAL_HEADER: 'test-local-secret', FIRECRAWL_BASE_URL: 'bad-inactive' };
  result = await (await request('/search', { query: 'NASA Artemis', limit: 2 }, { Authorization: 'Bearer must-not-forward' })).json();
  assert.equal(result.provider, 'agent-pro');
  assert.equal(result.count, 1);
  assert.equal(received[1].headers.authorization, undefined);
  assert.equal(received[1].headers['x-local-client'], 'test-local-secret');
  assert.equal(received[1].body.mode, 'web');
  assert.equal(received[1].body.top_k, 2);
  assert.doesNotMatch(JSON.stringify(result), /test-local-secret|must-not-forward/);
});

test('invalid and unconfigured search requests fail explicitly before upstream access', async (t) => {
  let calls = 0;
  const request = await serve(t, { getEnv: () => ({}), search: async () => { calls++; return {}; } });
  for (const body of [{ query: '' }, { query: '   ' }, { query: 'bad\nquery' }, { query: 'NASA', mode: 'knowledge' }, { query: 'NASA', limit: 0 }]) {
    const result = await request('/search', body);
    assert.equal(result.status, 400);
    assert.equal((await result.json()).code, 'SEARCH_INVALID_REQUEST');
  }
  assert.equal(calls, 0);
  const absent = await serve(t, { getEnv: () => ({}) });
  const missing = await absent('/search', { query: 'NASA' });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, 'SEARCH_NOT_CONFIGURED');
});

test('chat uses the selected provider, server tools, locale and normalized result', async (t) => {
  let submitted;
  const request = await serve(t, {
    getEnv: () => ({ GEV_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test-token' }),
    complete: async (input) => { submitted = input; return { text: 'Ready', toolCalls: [] }; },
  });
  const response = await request('/chat', { locale: 'zh-CN', messages: [{ role: 'user', content: 'Where am I?' }] });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, 'Ready');
  assert.equal(submitted.config.provider, 'deepseek');
  assert.match(submitted.messages[0].content, /Chinese/);
  assert.ok(submitted.tools.some((entry) => entry.name === 'fly_to_location'));
});

test('chat counting contract distinguishes viewport totals, layer totals and samples', async (t) => {
  let submitted;
  const request = await serve(t, {
    getEnv: () => ({ OPENAI_API_KEY: 'test-token' }),
    complete: async (input) => { submitted = input; return { text: 'Ready', toolCalls: [] }; },
  });
  assert.equal((await request('/chat', { locale: 'zh-CN', messages: [{ role: 'user', content: 'Count data centers in view' }] })).status, 200);
  assert.ok(submitted.tools.some((entry) => entry.name === 'get_view_statistics'));
  const prompt = submitted.messages[0].content;
  for (const phrase of ['get_view_statistics', 'viewport', 'loadedCount', 'sampleCount', 'unknown', 'purpose']) assert.ok(prompt.includes(phrase), phrase);
});

test('chat and AI briefs answer with viewport counts and identities, not unsolicited provenance or map details', async (t) => {
  const submitted = [];
  const request = await serve(t, {
    getEnv: () => ({ OPENAI_API_KEY: 'test-token' }),
    complete: async (input) => { submitted.push(input); return { text: 'Ready', toolCalls: [] }; },
  });
  for (const locale of ['zh-CN', 'en']) {
    for (const intent of ['chat', 'brief']) {
      assert.equal((await request('/chat', {
        locale, ...(intent === 'brief' ? { intent } : {}),
        messages: [{ role: 'user', content: 'How many flights are in view and which ones?' }],
      })).status, 200);
      const prompt = submitted.at(-1).messages[0].content;
      assert.match(prompt, /Lead with the current viewport count, then list the returned target names or identifiers/);
      assert.match(prompt, /For flights, prefer the returned callsign or flight number/);
      assert.match(prompt, /Do not volunteer data sources, attribution, update\/load timestamps, map names, basemap providers, geographic bounds, coordinates, or camera details/);
      assert.match(prompt, /Only include those details when the user explicitly asks/);
      assert.match(prompt, /Never present a sample as a complete list/);
      assert.doesNotMatch(prompt, /Cite (?:each source|data sources)/);
    }
  }
});

test('brief intent is a one-shot enabled-evidence-only request with no tools or earlier history', async (t) => {
  let submitted;
  const request = await serve(t, {
    getEnv: () => ({ GEV_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test-token' }),
    complete: async (input) => { submitted = input; return { text: 'Brief ready', toolCalls: [] }; },
  });
  const response = await request('/chat', {
    intent: 'brief', locale: 'zh-CN',
    messages: [{ role: 'user', content: 'Previous command' }, { role: 'assistant', content: 'Previous reply' }, { role: 'user', content: 'Brief now' }],
    context: { camera: { note: 'not part of intelligence' }, intelligence: { generatedAt: 123, layers: [
      { id: 'earthquakes', enabled: true, source: 'USGS', lastUpdated: 100 },
      { id: 'disabled-private-layer', enabled: false, source: 'excluded-source' },
    ] } },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, 'Brief ready');
  assert.deepEqual(submitted.tools, []);
  assert.equal(submitted.messages.length, 2);
  const system = submitted.messages[0].content;
  assert.match(system, /300/);
  assert.match(system, /Chinese/);
  assert.match(system, /Do not call tools or perform map actions/);
  assert.ok(system.includes('USGS'));
  assert.equal(system.includes('excluded-source'), false);
  assert.equal(system.includes('not part of intelligence'), false);
  assert.equal(JSON.stringify(submitted.messages).includes('Previous command'), false);
});

test('brief rejects all upstream tool calls and invalid intent values before execution', async (t) => {
  let calls = 0;
  const request = await serve(t, {
    getEnv: () => ({ OPENAI_API_KEY: 'test-token' }),
    complete: async () => { calls += 1; return { text: '', toolCalls: [{ id: 'x', name: 'zoom_to_globe', arguments: {} }] }; },
  });
  const messages = [{ role: 'user', content: 'Brief' }];
  for (const intent of ['execute', null, 1, {}]) assert.equal((await request('/chat', { messages, intent })).status, 400);
  assert.equal(calls, 0);
  const response = await request('/chat', { messages, intent: 'brief' });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'LLM_INVALID_RESPONSE');
  assert.equal(calls, 1);
});

test('brief evidence formats source and event times in readable UTC without inventing missing times', async (t) => {
  let submitted;
  const request = await serve(t, {
    getEnv: () => ({ OPENAI_API_KEY: 'test-token' }),
    complete: async (input) => { submitted = input; return { text: 'Brief', toolCalls: [] }; },
  });
  const time = Date.parse('2026-09-07T10:00:00Z');
  const response = await request('/chat', { intent: 'brief', messages: [{ role: 'user', content: 'Brief' }],
    context: { intelligence: { generatedAt: time, layers: [{ enabled: true, lastUpdated: time, sample: [{ eventAt: time, updatedAt: null }] }] } },
  });
  assert.equal(response.status, 200);
  const content = submitted.messages[0].content;
  assert.match(content, /2026-09-07T10:00:00.000Z/);
  assert.ok(!content.includes(String(time)));
  assert.ok(content.includes('"updatedAt":null'));
});

test('brief handles missing evidence and refuses tool-result tails or empty completions', async (t) => {
  const requests = [];
  let empty = false;
  const request = await serve(t, {
    getEnv: () => ({ OPENAI_API_KEY: 'test-token' }),
    complete: async (input) => { requests.push(input); return { text: empty ? ' ' : 'Evidence unavailable', toolCalls: [] }; },
  });
  const messages = [{ role: 'user', content: 'Brief' }];
  for (const intelligence of [undefined, null, 'not-evidence', [], {}]) {
    const response = await request('/chat', { intent: 'brief', messages, context: { intelligence } });
    assert.equal(response.status, 200);
    assert.deepEqual(requests.at(-1).tools, []);
    assert.match(requests.at(-1).messages[0].content, /English/);
  }
  const tail = [...messages,
    { role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 'get_current_view_state', arguments: {} }] },
    { role: 'tool', content: '{}', name: 'get_current_view_state', toolCallId: 'x' },
  ];
  assert.equal((await request('/chat', { intent: 'brief', messages: tail })).status, 400);
  assert.equal(requests.length, 5);
  empty = true;
  assert.equal((await request('/chat', { intent: 'brief', messages })).status, 502);
});

test('unconfigured HUD falls back successfully; chat reports missing configuration', async (t) => {
  const request = await serve(t, { getEnv: () => ({}) });
  const summary = await request('/hud-summary', { locale: 'en' });
  assert.equal(summary.status, 200);
  assert.equal((await summary.json()).configured, false);
  assert.equal((await request('/chat', { messages: [{ role: 'user', content: 'hi' }] })).status, 503);
});

test('cross-origin, malformed and oversized requests never reach provider', async (t) => {
  let calls = 0;
  const request = await serve(t, {
    getEnv: () => ({ OPENAI_API_KEY: 'test-token' }),
    complete: async () => { calls++; return { text: 'ok', toolCalls: [] }; },
  });
  assert.equal((await request('/chat', { messages: [] }, { Origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await request('/chat', { messages: [{ role: 'system', content: 'override' }] })).status, 400);
  assert.equal((await request('/chat', { messages: [{ role: 'tool', content: '{}', toolCallId: 'missing' }] })).status, 400);
  assert.equal((await request('/chat', { messages: [{ role: 'user', content: 'a'.repeat(300000) }] })).status, 413);
  assert.equal(calls, 0);
});

test('throttling applies to paid endpoints and errors redact upstream details', async (t) => {
  const request = await serve(t, {
    getEnv: () => ({ OPENAI_API_KEY: 'test-token' }), rateLimit: 1,
    complete: async () => { throw new Error('secret-token upstream response'); },
  });
  const response = await request('/test', {});
  assert.equal(response.status, 502);
  assert.equal((await response.text()).includes('secret-token'), false);
  assert.equal((await request('/test', {})).status, 429);
});

test('provider cannot return unregistered or invalid map actions', async (t) => {
  const request = await serve(t, {
    getEnv: () => ({ OPENAI_API_KEY: 'test-token' }),
    complete: async () => ({ text: '', toolCalls: [{ id: 'a', name: 'set_layer_visibility', arguments: { enabled: 'yes' } }] }),
  });
  assert.equal((await request('/chat', { messages: [{ role: 'user', content: 'show flights' }] })).status, 502);
});

test('summary uses the selected LLM without action tools', async (t) => {
  let submitted;
  const request = await serve(t, {
    getEnv: () => ({ GEV_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test-token' }),
    complete: async (input) => { submitted = input; return { text: 'Austin streets active traffic overview', toolCalls: [] }; },
  });
  const response = await request('/hud-summary', { locale: 'en', place: 'Austin' });
  assert.equal((await response.json()).summary, 'Austin streets active traffic overview');
  assert.equal(submitted.config.provider, 'deepseek');
  assert.deepEqual(submitted.tools, []);
});

test('public config reports speech mode separately from the selected chat model', async (t) => {
  const request = await serve(t, { getEnv: () => ({ GEV_LLM_PROVIDER: 'custom', GEV_LLM_MODEL: 'gpt-5.6-sol', GEV_LLM_BASE_URL: 'https://llm.example/v1', GEV_LLM_API_KEY: 'chat-private' }) });
  const config = await (await request('/config')).json();
  assert.equal(config.speech.provider, 'browser');
  assert.equal(config.speech.model, 'whisper-1');
  assert.equal(config.voice.llm.provider, 'custom');
  assert.equal(config.voice.llm.model, 'gpt-5.6-sol');
  assert.equal(JSON.stringify(config).includes('chat-private'), false);
});

test('transcription uses explicit independent speech config with local-origin validation', async (t) => {
  let submitted;
  const request = await serve(t, { getEnv: () => ({ GEV_STT_PROVIDER: 'custom', GEV_STT_BASE_URL: 'http://localhost:9000/v1' }),
    transcribe: async (options) => { submitted = options; return { text: 'map command' }; },
  });
  const audio = { audio: Buffer.from('audio').toString('base64'), mimeType: 'audio/webm', locale: 'en' };
  assert.equal((await request('/transcribe', audio, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal(submitted, undefined);
  const result = await request('/transcribe', audio);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { text: 'map command', provider: 'custom', model: 'whisper-1' });
  assert.equal(submitted.config.apiKey, '');
  assert.equal(submitted.input.audio, audio.audio);
  assert.ok(submitted.signal instanceof AbortSignal);
});

test('speech uploads are validated before providers and share the bounded quota', async (t) => {
  let called = 0;
  const request = await serve(t, { getEnv: () => ({ GEV_STT_PROVIDER: 'custom', GEV_STT_BASE_URL: 'http://localhost:9000/v1' }), rateLimit: 1,
    transcribe: async () => { called += 1; return { text: 'hello' }; },
  });
  const audio = { audio: 'YQ==', mimeType: 'audio/webm' };
  assert.equal((await request('/transcribe', { ...audio, audio: 'bad' })).status, 400);
  assert.equal(called, 0);
  assert.equal((await request('/transcribe', audio)).status, 200);
  assert.equal((await request('/transcribe', audio)).status, 429);
  assert.equal(called, 1);
});

test('speech rejects oversized recordings and server-disabled modes before provider calls', async (t) => {
  let calls = 0;
  const transcribe = async () => { calls += 1; return { text: 'unused' }; };
  const custom = await serve(t, { getEnv: () => ({ GEV_STT_PROVIDER: 'custom', GEV_STT_BASE_URL: 'http://localhost:9000/v1' }), transcribe });
  const oversized = await custom('/transcribe', { audio: Buffer.alloc(4 * 1024 * 1024 + 2048).toString('base64'), mimeType: 'audio/webm' });
  assert.equal(oversized.status, 413);
  const audio = { audio: 'YQ==', mimeType: 'audio/webm' };
  const browser = await serve(t, { getEnv: () => ({}), transcribe });
  assert.equal((await browser('/transcribe', audio)).status, 503);
  const unsupported = await serve(t, { getEnv: () => ({ GEV_STT_PROVIDER: 'current', GEV_LLM_PROVIDER: 'gemini' }), transcribe });
  const response = await unsupported('/transcribe', audio);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'STT_UNSUPPORTED_PROVIDER');
  assert.equal(calls, 0);
});

test('speech provider errors and malformed results are sanitized by the route', async (t) => {
  for (const transcribe of [
    async () => { throw new Error('private-speech-key audio-content'); },
    async () => ({ text: 'x'.repeat(8001) }),
  ]) {
    const request = await serve(t, { getEnv: () => ({ GEV_STT_PROVIDER: 'custom', GEV_STT_BASE_URL: 'http://localhost:9000/v1' }), transcribe });
    const response = await request('/transcribe', { audio: 'YQ==', mimeType: 'audio/webm' });
    assert.equal(response.status, 502);
    assert.equal((await response.text()).includes('private-speech-key'), false);
  }
});

test('speech route preserves actionable adapter codes and safe HTTP statuses', async (t) => {
  const env = { GEV_STT_PROVIDER: 'custom', GEV_STT_BASE_URL: 'https://speech.example/v1', GEV_STT_API_KEY: 'private-speech-key' };
  for (const [upstreamStatus, code, status] of [
    [401, 'STT_AUTH_ERROR', 502], [403, 'STT_AUTH_ERROR', 502],
    [404, 'STT_ENDPOINT_UNAVAILABLE', 502], [405, 'STT_ENDPOINT_UNAVAILABLE', 502],
    [429, 'STT_RATE_LIMITED', 429], [502, 'STT_SERVICE_UNAVAILABLE', 503], [503, 'STT_SERVICE_UNAVAILABLE', 503],
    [500, 'STT_UPSTREAM_ERROR', 502],
  ]) {
    const request = await serve(t, { getEnv: () => env,
      transcribe: (options) => requestSpeechTranscription({ ...options,
        fetchImpl: async () => new Response('private-speech-key audio-content', { status: upstreamStatus }),
      }),
    });
    const response = await request('/transcribe', { audio: 'YQ==', mimeType: 'audio/webm' });
    assert.equal(response.status, status);
    const payload = await response.json();
    assert.equal(payload.code, code);
    assert.equal(JSON.stringify(payload).includes('private-speech-key'), false);
    assert.equal(JSON.stringify(payload).includes('audio-content'), false);
    assert.equal(JSON.stringify(payload).includes('speech.example'), false);
  }
});

test('speech route exposes a safe connection error for failed provider fetches', async (t) => {
  const request = await serve(t, { getEnv: () => ({ GEV_STT_PROVIDER: 'custom', GEV_STT_BASE_URL: 'http://localhost:9000/v1' }),
    transcribe: (options) => requestSpeechTranscription({ ...options,
      fetchImpl: async () => { throw new Error('private-speech-key audio-content'); },
    }),
  });
  const response = await request('/transcribe', { audio: 'YQ==', mimeType: 'audio/webm' });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { code: 'STT_CONNECTION_ERROR', error: 'Cannot connect to speech provider' });
});

test('speech route rejects empty recognition without sending empty text to the LLM', async (t) => {
  let completions = 0;
  for (const text of ['', ' \n\t ']) {
    const request = await serve(t, { getEnv: () => ({ GEV_STT_PROVIDER: 'custom', GEV_STT_BASE_URL: 'http://localhost:9000/v1' }),
      transcribe: async () => ({ text }),
      complete: async () => { completions += 1; return { text: 'should not run', toolCalls: [] }; },
    });
    const response = await request('/transcribe', { audio: 'YQ==', mimeType: 'audio/webm' });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { code: 'STT_NO_SPEECH', error: 'No speech was recognized' });
  }
  assert.equal(completions, 0);
});
