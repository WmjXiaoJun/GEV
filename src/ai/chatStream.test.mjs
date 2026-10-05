import test from 'node:test';
import assert from 'node:assert/strict';
import { readChatResponse } from './chatStream.js';

const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;
const done = { type: 'done', text: '飞机', toolCalls: [] };
function response(chunks, options = {}) {
  return new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
    if (!options.hold) controller.close();
  }, cancel: options.cancel }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

test('handles fragmented UTF-8, CRLF, comments and multiline data frames', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\n\r\ndata: {"type":"delta",\r\ndata: "text":"飞"}\r\n\r\n'
    + frame({ type: 'delta', text: '机' }) + frame(done));
  const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
  const updates = [];
  assert.deepEqual(await readChatResponse(response(chunks), { onDelta: (text) => updates.push(text) }), done);
  assert.deepEqual(updates, ['飞', '飞机']);
});

test('keeps JSON compatibility and sanitizes error codes', async () => {
  assert.deepEqual(await readChatResponse(Response.json(done)), done);
  await assert.rejects(readChatResponse(Response.json({ code: 'LLM_RATE_LIMITED' }, { status: 429 })), { code: 'LLM_RATE_LIMITED' });
  await assert.rejects(readChatResponse(Response.json({ code: 'private-secret' }, { status: 500 })), { code: 'LLM_ERROR' });
  for (const code of ['private-secret', 'LLM_TIMEOUT']) {
    await assert.rejects(readChatResponse(response([frame({ type: 'error', code })])), {
      code: code === 'LLM_TIMEOUT' ? code : 'LLM_UPSTREAM_ERROR',
    });
  }
});

test('rejects truncation, malformed events, invalid UTF-8 and oversized streams', async () => {
  for (const chunks of [
    [], [frame({ type: 'delta', text: 'partial' })], ['data: broken\n\n'],
    [frame({ type: 'delta', text: 123 })], [frame({ type: 'tools', toolCalls: [] })],
    [frame({ ...done, toolCalls: null })], [new Uint8Array([0xff])],
    ['x'.repeat(600_001)], ['data: ' + 'x'.repeat(600_001) + '\n\n'],
    [frame({ type: 'delta', text: 'x'.repeat(256_001) })],
    [frame({ ...done, text: 'x'.repeat(256_001) })], [' '.repeat(2_000_001)],
  ]) await assert.rejects(readChatResponse(response(chunks)), { code: 'LLM_INVALID_RESPONSE' });
  await assert.rejects(readChatResponse({ ok: true, headers: new Headers({ 'Content-Type': 'text/event-stream' }) }), { code: 'LLM_INVALID_RESPONSE' });
});

test('aborting a waiting stream cancels its reader even if no token arrives', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const waiting = readChatResponse(response([], { hold: true, cancel: () => { cancelled = true; } }), { signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, { code: 'LLM_CANCELLED' });
  assert.equal(cancelled, true);
  await assert.rejects(readChatResponse(response([]), { signal: controller.signal }), { code: 'LLM_CANCELLED' });
});
