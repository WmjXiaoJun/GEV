import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { LLM_TIMEOUT_MS, requestLlmCompletion } from './adapters.mjs';
import { createAiHandler } from './proxy.mjs';
import { resolveLlmConfig } from './providers.js';
import { readUpstreamStream } from './upstreamStream.mjs';

const messages = [{ role: 'user', content: 'hello' }];
const tools = [{ name: 'zoom_to_globe', description: 'Globe', parameters: { type: 'object', properties: {} } }];
const config = (provider = 'openai') => resolveLlmConfig({ GEV_LLM_PROVIDER: provider,
  OPENAI_API_KEY: 'test', ANTHROPIC_API_KEY: 'test', GEMINI_API_KEY: 'test',
});
const sse = (value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\r\n\r\n`;
const openChunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
function response(events, step = 5) {
  const bytes = new TextEncoder().encode(events.join(''));
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += step) controller.enqueue(bytes.slice(offset, offset + step));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('OpenAI streams fragmented UTF-8 text immediately and assembles tools only on completion', async () => {
  const deltas = [];
  const result = await requestLlmCompletion({ config: config(), messages, tools, stream: true, onDelta: (text) => deltas.push(text),
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).stream, true);
      return response([
        sse(openChunk({ content: '你好' })),
        sse(openChunk({ tool_calls: [{ index: 0, id: 'call-1', function: { name: 'zoom_to_', arguments: '{' } }] })),
        sse(openChunk({ content: '世界', tool_calls: [{ index: 0, function: { name: 'globe', arguments: '}' } }] })),
        sse(openChunk({}, 'tool_calls')), sse('[DONE]'),
      ], 1);
    },
  });
  assert.deepEqual(deltas, ['你好', '世界']);
  assert.equal(result.text, '你好世界');
  assert.deepEqual(result.toolCalls, [{ id: 'call-1', name: 'zoom_to_globe', arguments: {} }]);
});

test('Anthropic streams native text and JSON tool deltas without leaking thinking', async () => {
  const deltas = [];
  const result = await requestLlmCompletion({ config: config('anthropic'), messages, tools, stream: true, onDelta: (text) => deltas.push(text),
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).stream, true);
      return response([
        sse({ type: 'message_start', message: { usage: { input_tokens: 3 } } }),
        sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
        sse({ type: 'content_block_stop', index: 0 }),
        sse({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } }),
        sse({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'private' } }),
        sse({ type: 'content_block_stop', index: 1 }),
        sse({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'a', name: 'zoom_to_globe', input: {} } }),
        sse({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } }),
        sse({ type: 'content_block_stop', index: 2 }),
        sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } }),
        sse({ type: 'message_stop' }),
      ]);
    },
  });
  assert.deepEqual(deltas, ['Hello']);
  assert.deepEqual(result.toolCalls, [{ id: 'a', name: 'zoom_to_globe', arguments: {} }]);
  assert.equal(result.usage.output_tokens, 8);
});

function anthropicTextBlocks(blocks) {
  return [...blocks.flatMap((text, index) => [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index },
  ]), { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }].map(sse);
}

test('Anthropic multiblock proxy deltas exactly match final text including empty block separators', async (t) => {
  const request = await serve(t, (options) => requestLlmCompletion({ ...options, config: config('anthropic'),
    fetchImpl: async () => response(anthropicTextBlocks(['First.', '', 'Second.'])),
  }));
  const body = await (await request({ messages, stream: true, locale: 'en' })).text();
  const events = body.trim().split('\n\n').map((event) => JSON.parse(event.slice('data: '.length)));
  const streamedText = events.filter(({ type }) => type === 'delta').map(({ text }) => text).join('');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).text, 'First.\n\nSecond.');
  assert.equal(streamedText, events.at(-1).text);
});

test('Anthropic counts separators against the streamed text budget before emitting overflow', async () => {
  const deltas = [];
  await assert.rejects(requestLlmCompletion({ config: config('anthropic'), messages, stream: true,
    onDelta: (text) => deltas.push(text),
    fetchImpl: async () => response(anthropicTextBlocks(['x'.repeat(18000), 'Overflow']), 4096),
  }), { code: 'LLM_INVALID_RESPONSE' });
  assert.equal(deltas.join(''), 'x'.repeat(18000));
  const result = await requestLlmCompletion({ config: config('anthropic'), messages, stream: true,
    fetchImpl: async () => response(anthropicTextBlocks(['x'.repeat(17999), '']), 4096),
  });
  assert.equal(result.text.length, 18000);
});

test('Gemini streams its native endpoint and preserves complete tool signatures', async () => {
  const deltas = [];
  const result = await requestLlmCompletion({ config: config('gemini'), messages, tools, stream: true, onDelta: (text) => deltas.push(text),
    fetchImpl: async (url) => {
      assert.match(url, /:streamGenerateContent\?alt=sse$/);
      return response([
        sse({ candidates: [{ content: { parts: [{ text: 'private', thought: true }, { text: 'Hello ' }] } }] }),
        sse({ candidates: [{ content: { parts: [{ text: 'world' }, { functionCall: { id: 'g', name: 'zoom_to_globe', args: {} }, thoughtSignature: 'signature' }] }, finishReason: 'STOP' }] }),
      ]);
    },
  });
  assert.deepEqual(deltas, ['Hello ', 'world']);
  assert.equal(result.text, 'Hello world');
  assert.equal(result.toolCalls[0].thoughtSignature, 'signature');
  assert.equal(result.toolCalls[0].providerCallId, 'g');
});

test('providers ignoring streaming retain JSON compatibility and emit a single real delta', async () => {
  const deltas = [];
  const result = await requestLlmCompletion({ config: config(), messages, stream: true, onDelta: (text) => deltas.push(text),
    fetchImpl: async () => Response.json({ choices: [{ message: { content: 'Fallback' } }] }),
  });
  assert.equal(result.text, 'Fallback');
  assert.deepEqual(deltas, ['Fallback']);
});

test('truncated, malformed, oversized, unknown-tool and upstream-error streams fail closed', async () => {
  const cases = [
    [sse(openChunk({ content: 'partial' }))],
    ['data: {bad}\n\n'],
    [sse({ error: { message: 'private-key' } })],
    [sse(openChunk({ content: 'x'.repeat(18001) })), sse(openChunk({}, 'stop'))],
    [sse(openChunk({ tool_calls: [{ index: 0, id: 'x', function: { name: 'zoom_to_globe', arguments: '{' } }] })), sse(openChunk({}, 'tool_calls'))],
    [sse(openChunk({ tool_calls: [{ index: 0, id: 'x', function: { name: 'unknown', arguments: '{}' } }] })), sse(openChunk({}, 'tool_calls'))],
    [sse(openChunk({ content: 'partial' }, 'length'))],
    ['data: ' + 'x'.repeat(140000)],
  ];
  for (const events of cases) {
    await assert.rejects(requestLlmCompletion({ config: config(), messages, tools, stream: true, fetchImpl: async () => response(events, 512) }), (failure) => {
      assert.ok(['LLM_INVALID_RESPONSE', 'LLM_UPSTREAM_ERROR'].includes(failure.code));
      assert.equal(failure.message.includes('private-key'), false);
      return true;
    });
  }
});

test('abort cancels an idle upstream reader promptly', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const pending = requestLlmCompletion({ config: config(), messages, stream: true, signal: controller.signal,
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } }),
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(pending, { code: 'LLM_CANCELLED' });
  assert.equal(cancelled, true);
});

test('abort also interrupts blocked downstream delivery without waiting for its callback', async () => {
  const controller = new AbortController();
  const pending = requestLlmCompletion({ config: config(), messages, stream: true, signal: controller.signal,
    onDelta: () => { controller.abort(); return new Promise(() => {}); },
    fetchImpl: async () => response([sse(openChunk({ content: 'Hello' })), sse(openChunk({}, 'stop'))]),
  });
  const outcome = await Promise.race([pending.catch((error) => error.code), new Promise((resolve) => setTimeout(() => resolve('STALLED'), 100))]);
  assert.equal(outcome, 'LLM_CANCELLED');
});

test('deadline aborts a stalled SSE or JSON reader and cleans up its body', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const type of ['text/event-stream', 'application/json']) {
    let cancelled = false;
    const pending = requestLlmCompletion({ config: config(), messages, stream: true,
      fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': type } }),
    });
    await Promise.resolve();
    t.mock.timers.tick(LLM_TIMEOUT_MS + 1);
    await assert.rejects(pending, { code: 'LLM_TIMEOUT' });
    assert.equal(cancelled, true);
  }
});

async function serve(t, complete) {
  const server = createServer(createAiHandler({ getEnv: () => ({ OPENAI_API_KEY: 'test' }), complete }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return (body, options = {}) => fetch(`${origin}/chat`, { ...options, method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('chat SSE forwards deltas before completion with only validated final tools', async (t) => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  t.after(() => finish());
  const request = await serve(t, async ({ stream, onDelta, messages: submitted }) => {
    assert.equal(stream, true);
    assert.match(submitted[0].content, /Never use Traditional Chinese/);
    await onDelta('Hello');
    await gate;
    return { text: 'Hello', toolCalls: [{ id: 'x', name: 'zoom_to_globe', arguments: {} }] };
  });
  const result = await request({ messages, locale: 'zh-CN', stream: true });
  assert.match(result.headers.get('content-type'), /text\/event-stream/);
  const reader = result.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"type":"delta","text":"Hello"/);
  assert.equal(first.includes('toolCalls'), false);
  finish();
  let rest = '';
  for (;;) { const { done, value } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
  assert.match(rest, /"type":"done"/);
  assert.match(rest, /zoom_to_globe/);
});

test('chat streaming errors remain sanitized SSE and never publish invalid tools', async (t) => {
  const request = await serve(t, async ({ onDelta }) => {
    await onDelta('Partial');
    return { text: 'Partial', toolCalls: [{ id: 'x', name: 'delete_data', arguments: {} }] };
  });
  const result = await request({ messages, stream: true });
  const body = await result.text();
  assert.match(body, /"type":"error","code":"LLM_INVALID_RESPONSE"/);
  assert.equal(body.includes('delete_data'), false);
  assert.equal(body.includes('"type":"done"'), false);
});

test('chat rejects nonboolean stream selection before upstream requests', async (t) => {
  let calls = 0;
  const request = await serve(t, async () => { calls += 1; return { text: 'Hi', toolCalls: [] }; });
  for (const stream of ['true', 1, null, {}]) assert.equal((await request({ messages, stream })).status, 400);
  assert.equal(calls, 0);
});

test('SSE framing accepts comments, multiline JSON, bare CR and metadata-only chunks', async () => {
  const result = await requestLlmCompletion({ config: config(), messages, stream: true, fetchImpl: async () => response([
    ': heartbeat\rid: 1\revent: message\rdata: {"choices":[\rdata: {"delta":{"content":"Hi"},"finish_reason":"stop"}]}\r\r',
    sse({ choices: [], usage: { completion_tokens: 1 } }), sse('[DONE]'),
  ], 1) });
  assert.equal(result.text, 'Hi');
  assert.equal(result.usage.completion_tokens, 1);
});

test('SSE input enforces response and event byte limits including unfinished frames', async () => {
  for (const upstream of [
    new Response(null, { headers: { 'Content-Type': 'text/event-stream' } }),
    new Response('', { headers: { 'Content-Type': 'text/event-stream', 'Content-Length': '2000001' } }),
    response([': ' + 'x'.repeat(128001) + '\n\n'], 256),
    response([sse(openChunk({ content: 'Hi' }, 'stop')).trimEnd()], 256),
    response([': ' + 'x'.repeat(10_000) + '\n\n'].concat(Array(201).fill(': ' + 'x'.repeat(10_000) + '\n\n')), 32000),
  ]) {
    await assert.rejects(requestLlmCompletion({ config: config(), messages, stream: true, fetchImpl: async () => upstream }), { code: 'LLM_INVALID_RESPONSE' });
  }
});

test('OpenAI rejects malformed stream metadata, tool fields and post-finish mutations', async () => {
  const call = { index: 0, id: 'x', type: 'function', function: { name: 'zoom_to_globe', arguments: '{}' } };
  const cases = [
    [sse('[DONE]')], [sse('[]')], [sse({ choices: {} })], [sse({ choices: [{ delta: {} }, { delta: {} }] })],
    [sse({ choices: [{ index: 1, delta: {} }] })], [sse({ choices: [{ delta: null }] })],
    [sse(openChunk({ content: 'Hi' }, 'stop')), sse(openChunk({ content: 'after' }))],
    [sse(openChunk({ tool_calls: {} }))],
    ...[-1, 4, 0.5].map((index) => [sse(openChunk({ tool_calls: [{ ...call, index }] }))]),
    [sse(openChunk({ tool_calls: [{ ...call, type: 'not-a-function' }] }))],
    [sse(openChunk({ tool_calls: [{ ...call, function: 'bad' }] }))],
    [sse(openChunk({ tool_calls: [{ ...call, id: 99 }] }))],
    [sse(openChunk({ tool_calls: [{ ...call, function: { name: 'a'.repeat(65) } }] }))],
    [sse(openChunk({ tool_calls: [{ ...call, function: { arguments: 'x'.repeat(16001) } }] }))],
    [sse(openChunk({ tool_calls: Array(5).fill(call) }))],
    [sse(openChunk({ tool_calls: [call, { ...call, index: 1 }] }, 'tool_calls'))],
  ];
  for (const events of cases) await assert.rejects(requestLlmCompletion({ config: config(), messages, tools, stream: true,
    fetchImpl: async () => response(events, 4096),
  }), { code: 'LLM_INVALID_RESPONSE' });
});

test('Anthropic validates event order and only accepts completed native tools', async () => {
  const start = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
  const stop = { type: 'content_block_stop', index: 0 };
  const finish = [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }];
  const cases = [
    [{ type: 'error', error: { message: 'private' } }], [{ type: 'surprise' }], [start, start],
    [{ ...start, content_block: null }], [stop], [start, stop, stop],
    [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }],
    [start, stop, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }],
    [start, { type: 'content_block_delta', index: 0, delta: { type: 'unexpected' } }],
    [start, { type: 'content_block_delta', index: 0, delta: null }],
    [start, ...finish], [start, stop, { type: 'message_stop' }],
    [start, stop, { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' }],
    [start, stop],
    Array.from({ length: 5 }, (_, index) => ({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `x${index}`, name: 'zoom_to_globe', input: {} } })),
    [{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'x', name: 'zoom_to_globe', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '[]' } }, stop, ...finish],
  ];
  for (const events of cases) await assert.rejects(requestLlmCompletion({ config: config('anthropic'), messages, tools, stream: true,
    fetchImpl: async () => response(events.map(sse)),
  }), (error) => ['LLM_UPSTREAM_ERROR', 'LLM_INVALID_RESPONSE'].includes(error.code));
  const valid = await requestLlmCompletion({ config: config('anthropic'), messages, tools, stream: true, fetchImpl: async () => response([
    sse({ type: 'ping' }), sse({ type: 'message_start', message: {} }),
    sse({ ...start, content_block: { type: 'text', text: 'Hi' } }), sse(stop),
    sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'x', name: 'zoom_to_globe', input: {} } }),
    sse({ type: 'content_block_stop', index: 1 }), ...finish.map(sse),
  ]) });
  assert.equal(valid.text, 'Hi');
  assert.deepEqual(valid.toolCalls[0].arguments, {});
});

test('Gemini validates stream shape, completion reason and bounded function metadata', async () => {
  const chunk = (parts, extra = {}) => ({ candidates: [{ content: { parts }, ...extra }] });
  const call = { functionCall: { name: 'zoom_to_globe', args: {} } };
  for (const events of [
    [{ error: { message: 'private' } }], [{ candidates: null }], [{ candidates: [{}, {}] }],
    [chunk([], { index: 1 })], [chunk(null)], [chunk([null])], [chunk([{ text: 'Hi' }])],
    [chunk([{ text: 'Hi' }], { finishReason: 'STOP' }), chunk([{ text: 'after' }])],
    [chunk([{ text: 'Hi' }], { finishReason: 'MAX_TOKENS' })],
    [chunk([{ functionCall: 'bad' }])], [chunk(Array(5).fill(call))],
    [chunk([{ ...call, thoughtSignature: 5 }])], [chunk([{ ...call, thoughtSignature: 'x'.repeat(16001) }])],
    [chunk([{ functionCall: { name: 'zoom_to_globe', args: { text: 'x'.repeat(16001) } } }])],
  ]) await assert.rejects(requestLlmCompletion({ config: config('gemini'), messages, tools, stream: true,
    fetchImpl: async () => response(events.map(sse), 4096),
  }), (error) => ['LLM_UPSTREAM_ERROR', 'LLM_INVALID_RESPONSE'].includes(error.code));
  const result = await requestLlmCompletion({ config: config('gemini'), messages, stream: true, fetchImpl: async () => response([
    sse({ candidates: [], usageMetadata: { promptTokenCount: 1 } }), sse(chunk([{ text: 'Hi' }], { finishReason: 'STOP' })),
  ]) });
  assert.equal(result.text, 'Hi');
  assert.equal(result.usage.promptTokenCount, 1);
});

test('native stream reader is usable without a signal or delta callback', async () => {
  const result = await readUpstreamStream({ provider: 'openai', response: response([sse(openChunk({ content: 'Hi' }, 'stop'))]) });
  assert.equal(result.choices[0].message.content, 'Hi');
});

test('chat final JSON and SSE output are normalized to Simplified Chinese', async (t) => {
  const request = await serve(t, async ({ onDelta }) => { await onDelta?.('請問你能幹什麼工作'); return { text: '請問你能幹什麼工作', toolCalls: [] }; });
  assert.equal((await (await request({ messages, locale: 'zh-CN' })).json()).text, '请问你能干什么工作');
  const body = await (await request({ messages, locale: 'zh-CN', stream: true })).text();
  assert.match(body, /"type":"done","text":"请问你能干什么工作"/);
});

test('brief SSE rejects tool output and client disconnect aborts an active completion', async (t) => {
  const request = await serve(t, async ({ onDelta }) => { await onDelta('Brief'); return { text: 'Brief', toolCalls: [{ id: 'x', name: 'zoom_to_globe', arguments: {} }] }; });
  assert.match(await (await request({ messages, intent: 'brief', stream: true })).text(), /LLM_INVALID_RESPONSE/);
  let disconnected;
  const aborted = new Promise((resolve) => { disconnected = resolve; });
  const cancellable = await serve(t, async ({ onDelta, signal }) => {
    await onDelta('Hi');
    await new Promise((resolve) => signal.addEventListener('abort', () => { disconnected(); resolve(); }, { once: true }));
    return { text: 'Hi', toolCalls: [] };
  });
  const client = new AbortController();
  const response = await cancellable({ messages, stream: true }, { signal: client.signal });
  await response.body.getReader().read();
  client.abort();
  await aborted;
});
