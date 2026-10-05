import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLlmConfig } from './providers.js';
import { requestLlmCompletion } from './adapters.mjs';

const tools = [{ name: 'fly_to', description: 'Move the map', parameters: {
  type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false,
} }];
const messages = [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: 'Show Beijing' }];
function config(provider = 'openai') {
  return resolveLlmConfig({
    GEV_LLM_PROVIDER: provider, OPENAI_API_KEY: 'openai-secret', DEEPSEEK_API_KEY: 'deepseek-secret',
    QWEN_API_KEY: 'qwen-secret', MOONSHOT_API_KEY: 'moonshot-secret', ANTHROPIC_API_KEY: 'anthropic-secret',
    GEMINI_API_KEY: 'gemini-secret', GEV_LLM_API_KEY: 'custom-secret',
    ...(provider === 'custom' ? { GEV_LLM_MODEL: 'custom-model', GEV_LLM_BASE_URL: 'https://example.com/v1' } : {}),
  });
}
const roundTrip = [
  ...messages,
  { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'fly_to', arguments: { city: 'Beijing' }, thoughtSignature: 'opaque-signature' }] },
  { role: 'tool', toolCallId: 'call-1', name: 'fly_to', content: '{"ok":true}' },
];
function stub(payload, inspect = () => {}) {
  return async (url, options) => {
    inspect(url, options, JSON.parse(options.body));
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify(payload));
  };
}

test('OpenAI-compatible providers serialize messages, tools and only their own keys', async () => {
  for (const provider of ['openai', 'deepseek', 'qwen', 'moonshot', 'ollama', 'custom']) {
    const cfg = config(provider);
    const result = await requestLlmCompletion({ config: cfg, messages: roundTrip, tools, fetchImpl: stub({
      choices: [{ message: { content: 'Done', tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'fly_to', arguments: '{"city":"Shanghai"}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }, (url, options, body) => {
      assert.equal(url, `${cfg.baseUrl}/chat/completions`);
      assert.equal(options.headers.Authorization, cfg.apiKey ? `Bearer ${cfg.apiKey}` : undefined);
      assert.equal(body.model, cfg.model);
      assert.deepEqual(body.tools[0], { type: 'function', function: tools[0] });
      assert.equal(body.messages[2].tool_calls[0].function.arguments, '{"city":"Beijing"}');
      assert.equal(body.messages[3].tool_call_id, 'call-1');
      assert.equal(body.messages[2].thoughtSignature, undefined);
    }) });
    assert.equal(result.text, 'Done');
    assert.deepEqual(result.toolCalls, [{ id: 'call-2', name: 'fly_to', arguments: { city: 'Shanghai' } }]);
    assert.equal(result.usage.prompt_tokens, 10);
  }
});

test('Anthropic serializes system instructions and native multi-round tool blocks', async () => {
  const result = await requestLlmCompletion({ config: config('anthropic'), messages: roundTrip, tools, fetchImpl: stub({
    content: [{ type: 'text', text: 'Moving.' }, { type: 'tool_use', id: 'toolu-1', name: 'fly_to', input: { city: 'Shanghai' } }],
    usage: { input_tokens: 4 },
  }, (url, options, body) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(options.headers['x-api-key'], 'anthropic-secret');
    assert.equal(options.headers['anthropic-version'], '2023-06-01');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(body.system, 'Be concise.');
    assert.deepEqual(body.tools[0].input_schema, tools[0].parameters);
    assert.deepEqual(body.messages[1].content, [{ type: 'tool_use', id: 'call-1', name: 'fly_to', input: { city: 'Beijing' } }]);
    assert.deepEqual(body.messages[2].content, [{ type: 'tool_result', tool_use_id: 'call-1', content: '{"ok":true}' }]);
    assert.ok(body.max_tokens > 0);
  }) });
  assert.deepEqual(result.toolCalls, [{ id: 'toolu-1', name: 'fly_to', arguments: { city: 'Shanghai' } }]);
});

test('Gemini uses native function responses, sanitized schemas and preserved thought signatures', async () => {
  const result = await requestLlmCompletion({ config: config('gemini'), messages: roundTrip, tools, fetchImpl: stub({
    candidates: [{ content: { parts: [{ text: 'Moving.' }, { thought: true, text: 'Internal reasoning' }, { functionCall: { name: 'fly_to', args: { city: 'Shanghai' } }, thoughtSignature: 'next-signature' }] } }],
    usageMetadata: { promptTokenCount: 10 },
  }, (url, options, body) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    assert.equal(options.headers['x-goog-api-key'], 'gemini-secret');
    assert.ok(!url.includes('secret'));
    assert.deepEqual(body.systemInstruction, { parts: [{ text: 'Be concise.' }] });
    assert.equal(body.contents[1].role, 'model');
    assert.equal(body.contents[1].parts[0].thoughtSignature, 'opaque-signature');
    assert.deepEqual(body.contents[2].parts[0].functionResponse, { name: 'fly_to', response: { ok: true } });
    assert.equal(body.tools[0].functionDeclarations[0].parameters.additionalProperties, undefined);
  }) });
  assert.equal(result.text, 'Moving.');
  assert.equal(result.toolCalls[0].thoughtSignature, 'next-signature');
  assert.equal(result.toolCalls[0].name, 'fly_to');
  assert.equal(typeof result.toolCalls[0].id, 'string');
});

test('requests without tools omit optional tool fields', async () => {
  for (const provider of ['openai', 'anthropic', 'gemini']) {
    const payload = provider === 'openai' ? { choices: [{ message: { content: 'Hello' } }] }
      : provider === 'anthropic' ? { content: [{ type: 'text', text: 'Hello' }] }
        : { candidates: [{ content: { parts: [{ text: 'Hello' }] } }] };
    const result = await requestLlmCompletion({ config: config(provider), messages, fetchImpl: stub(payload, (_url, _options, body) => {
      assert.equal(body.tools, undefined);
    }) });
    assert.deepEqual(result, { text: 'Hello', toolCalls: [] });
  }
});

test('invalid tool names, argument JSON and missing IDs reject the entire response', async () => {
  for (const call of [
    { id: 'id', function: { name: 'not_registered', arguments: '{}' } },
    { id: 'id', function: { name: 'fly_to', arguments: '{' } },
    { id: 'id', function: { name: 'fly_to', arguments: '[]' } },
    { id: 'id', function: { name: 'fly_to', arguments: 'null' } },
    { function: { name: 'fly_to', arguments: '{}' } },
  ]) {
    await assert.rejects(requestLlmCompletion({ config: config(), messages, tools, fetchImpl: stub({ choices: [{ message: { tool_calls: [call] } }] }) }), { code: 'LLM_INVALID_RESPONSE' });
  }
});

test('provider failures never expose upstream bodies or fetch messages', async () => {
  for (const fetchImpl of [
    async () => new Response('secret-api-key and private backend error', { status: 401 }),
    async () => { throw new Error('secret-api-key network error'); },
    async () => new Response('secret-api-key invalid JSON'),
    stub({ candidates: [] }),
  ]) {
    await assert.rejects(requestLlmCompletion({ config: config(), messages, fetchImpl }), (error) => {
      assert.ok(error.code.startsWith('LLM_'));
      assert.ok(!error.message.includes('secret-api-key'));
      return true;
    });
  }
});

test('missing credentials, invalid URLs and malformed inputs never reach fetch', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => { fetchCount += 1; throw new Error('unexpected'); };
  await assert.rejects(requestLlmCompletion({ config: resolveLlmConfig({}), messages, fetchImpl }), { code: 'LLM_NOT_CONFIGURED' });
  await assert.rejects(requestLlmCompletion({ config: { ...config(), baseUrl: 'http://example.com' }, messages, fetchImpl }), { code: 'LLM_INVALID_CONFIG' });
  await assert.rejects(requestLlmCompletion({ config: config(), messages: [{ role: 'user', content: {} }], fetchImpl }), { code: 'LLM_INVALID_INPUT' });
  assert.equal(fetchCount, 0);
});

test('aborted calls and oversized responses are bounded', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(requestLlmCompletion({ config: config(), messages, signal: controller.signal, fetchImpl: async (_url, options) => {
    options.signal.throwIfAborted();
  } }), { code: 'LLM_CANCELLED' });
  await assert.rejects(requestLlmCompletion({ config: config(), messages, fetchImpl: async () => new Response('x'.repeat(2_100_000)) }), { code: 'LLM_INVALID_RESPONSE' });
});

test('native providers reject malformed argument objects and duplicate call IDs', async () => {
  for (const [provider, payload] of [
    ['anthropic', { content: [{ type: 'tool_use', id: 'id', name: 'fly_to', input: null }] }],
    ['anthropic', { content: [null] }],
    ['gemini', { candidates: [{ content: { parts: [{ functionCall: { name: 'fly_to', args: null } }] } }] }],
    ['gemini', { candidates: [{ content: { parts: [null] } }] }],
    ['openai', { choices: [{ message: { tool_calls: [1, 2].map(() => ({ id: 'duplicate', function: { name: 'fly_to', arguments: '{}' } })) } }] }],
  ]) {
    await assert.rejects(requestLlmCompletion({ config: config(provider), messages, tools, fetchImpl: stub(payload) }), { code: 'LLM_INVALID_RESPONSE' });
  }
});

test('native parallel tool results are grouped into one user turn without mutating history', async () => {
  const history = [...messages,
    { role: 'assistant', content: '', toolCalls: [1, 2].map((id) => ({ id: `call-${id}`, name: 'fly_to', arguments: { city: 'Beijing' } })) },
    { role: 'tool', toolCallId: 'call-1', name: 'fly_to', content: 'first result' },
    { role: 'tool', toolCallId: 'call-2', name: 'fly_to', content: '2' },
  ];
  const before = JSON.stringify(history);
  for (const provider of ['anthropic', 'gemini']) {
    const payload = provider === 'anthropic' ? { content: [{ type: 'text', text: 'Done' }] }
      : { candidates: [{ content: { parts: [{ text: 'Done' }] } }] };
    await requestLlmCompletion({ config: config(provider), messages: history, tools, fetchImpl: stub(payload, (_url, _options, body) => {
      const turns = body.messages ?? body.contents;
      assert.equal(turns.length, 3);
      assert.equal((turns[2].content ?? turns[2].parts).length, 2);
      if (provider === 'gemini') {
        assert.deepEqual(turns[2].parts[0].functionResponse.response, { result: 'first result' });
        assert.deepEqual(turns[2].parts[1].functionResponse.response, { result: 2 });
      }
    }) });
  }
  assert.equal(JSON.stringify(history), before);
});

test('Gemini preserves actual native function IDs and property names matching schema keywords', async () => {
  const schemaTools = [{ name: 'fly_to', description: '', parameters: {
    type: 'object', additionalProperties: false,
    properties: { additionalProperties: { type: 'string' }, nested: { type: 'object', additionalProperties: false } },
  } }];
  const signatureHistory = [...messages,
    { role: 'assistant', content: '', toolCalls: [{ id: 'native-1', providerCallId: 'native-1', name: 'fly_to', arguments: {} }] },
    { role: 'tool', name: 'fly_to', toolCallId: 'native-1', content: '{}' },
  ];
  const result = await requestLlmCompletion({ config: config('gemini'), messages: signatureHistory, tools: schemaTools, fetchImpl: stub({
    candidates: [{ content: { parts: [{ functionCall: { id: 'native-2', name: 'fly_to', args: {} } }] } }],
  }, (_url, _options, body) => {
    assert.equal(body.contents[1].parts[0].functionCall.id, 'native-1');
    assert.equal(body.contents[2].parts[0].functionResponse.id, 'native-1');
    const schema = body.tools[0].functionDeclarations[0].parameters;
    assert.deepEqual(schema.properties.additionalProperties, { type: 'string' });
    assert.equal(schema.properties.nested.additionalProperties, undefined);
  }) });
  assert.equal(result.toolCalls[0].providerCallId, 'native-2');
});
