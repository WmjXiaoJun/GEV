import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlmConversation } from './conversation.js';
import { validateChatMessages } from './proxy.mjs';
import { createActionGuard } from './actionGuard.js';

const reply = (body, ok = true) => ({ ok, json: async () => body });

test('normalizes submitted Chinese and final replies without modifying tool identifiers', async () => {
  let sent;
  const shown = [];
  const conversation = createLlmConversation({
    getLocale: () => 'zh-CN', runAction: async () => ({}),
    onMessage: (message) => shown.push(message),
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return reply({ text: '可以查看飛機與衛星。', toolCalls: [] });
    },
  });
  assert.equal(await conversation.send('請問你能幹什麼工作'), '可以查看飞机与卫星。');
  assert.equal(sent.messages[0].content, '请问你能干什么工作');
  assert.equal(shown[0].content, sent.messages[0].content);
  assert.equal(sent.stream, true);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
function streamingReply() {
  let sink;
  const response = new Response(new ReadableStream({ start(controller) { sink = controller; } }), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
  const emit = (event) => sink.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  return { response, emit, close: () => sink.close() };
}

test('streams simplified partial text before completion using one stable message id', async () => {
  const stream = streamingReply();
  const updates = [];
  const conversation = createLlmConversation({
    getLocale: () => 'zh-CN', runAction: async () => ({}),
    fetchImpl: async () => stream.response,
    onMessage: (message) => updates.push(message),
  });
  let completed = false;
  const pending = conversation.send('介紹').then((value) => { completed = true; return value; });
  await tick();
  stream.emit({ type: 'delta', text: '飛機' });
  await tick();
  assert.equal(completed, false);
  assert.equal(updates.at(-1).content, '飞机');
  assert.equal(updates.at(-1).streaming, true);
  const id = updates.at(-1).id;
  stream.emit({ type: 'delta', text: '與衛星' });
  stream.emit({ type: 'done', text: '飛機與衛星', toolCalls: [] });
  stream.close();
  assert.equal(await pending, '飞机与卫星');
  assert.equal(updates.at(-1).id, id);
  assert.equal(updates.at(-1).streaming, false);
});

test('cancellation preserves partial text as incomplete and prevents tool execution', async () => {
  const stream = streamingReply();
  const updates = [];
  const actions = [];
  const conversation = createLlmConversation({
    runAction: async (name) => { actions.push(name); return {}; },
    fetchImpl: async () => stream.response, onMessage: (message) => updates.push(message),
  });
  const pending = conversation.send('change map');
  await tick();
  stream.emit({ type: 'delta', text: 'Preview' });
  await tick();
  conversation.cancel();
  await assert.rejects(pending, { code: 'LLM_CANCELLED' });
  assert.equal(updates.at(-1).content, 'Preview');
  assert.equal(updates.at(-1).incomplete, true);
  assert.equal(updates.at(-1).streaming, false);
  assert.deepEqual(actions, ['get_current_view_state']);
});

test('unterminated streams do not commit history or execute partial tool calls', async () => {
  const updates = [];
  const stream = streamingReply();
  const conversation = createLlmConversation({
    runAction: async () => ({}), fetchImpl: async () => stream.response,
    onMessage: (message) => updates.push(message),
  });
  const pending = conversation.send('hello');
  await tick();
  stream.emit({ type: 'delta', text: 'partial' });
  stream.close();
  await assert.rejects(pending, { code: 'LLM_INVALID_RESPONSE' });
  assert.equal(updates.at(-1).incomplete, true);
});

test('conversation carries real tool results into the next model round', async () => {
  const requests = [];
  const actions = [];
  const messages = [];
  const controller = createLlmConversation({
    getLocale: () => 'zh-CN',
    onMessage: (message) => messages.push(message),
    runAction: async (name, args) => { actions.push({ name, args }); return { ok: true, style: args.style }; },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return reply(requests.length === 1
        ? { text: '', toolCalls: [{ id: 'call_1', name: 'set_visual_style', arguments: { style: 'thermal' } }] }
        : { text: 'Thermal view enabled.', toolCalls: [] });
    },
  });
  await controller.send('Use thermal view');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].locale, 'zh-CN');
  assert.equal(requests[1].messages.at(-1).role, 'tool');
  assert.equal(JSON.parse(requests[1].messages.at(-1).content).style, 'thermal');
  assert.equal(actions.filter((action) => action.name === 'set_visual_style').length, 1);
  assert.equal(messages.at(-1).content, 'Thermal view enabled.');
});

test('unknown tools and invalid arguments never reach the action runner', async () => {
  for (const call of [
    { id: 'a', name: 'run_shell', arguments: { command: 'no' } },
    { id: 'b', name: 'set_layer_visibility', arguments: { layerId: 'flights', enabled: 'false' } },
    { id: 'c', name: 'fly_to_location', arguments: { latitude: 100, longitude: 0 } },
  ]) {
    const executed = [];
    const conversation = createLlmConversation({
      runAction: async (name) => { executed.push(name); return {}; },
      fetchImpl: async () => reply({ text: '', toolCalls: [call] }),
    });
    await assert.rejects(conversation.send('test'), { code: 'LLM_INVALID_RESPONSE' });
    assert.deepEqual(executed.filter((name) => name !== 'get_current_view_state'), []);
  }
});

test('cancellation prevents a delayed model response from executing tools', async () => {
  let release;
  const actions = [];
  const conversation = createLlmConversation({
    runAction: async (name) => { actions.push(name); return {}; },
    fetchImpl: async () => new Promise((resolve) => { release = resolve; }),
  });
  const pending = conversation.send('change style');
  await new Promise((resolve) => setImmediate(resolve));
  conversation.cancel();
  release(reply({ text: '', toolCalls: [{ id: 'x', name: 'set_visual_style', arguments: { style: 'noir' } }] }));
  await assert.rejects(pending, { code: 'LLM_CANCELLED' });
  assert.equal(actions.includes('set_visual_style'), false);
});

test('tool rounds are bounded and failures never masquerade as successful actions', async () => {
  let round = 0;
  const requests = [];
  const conversation = createLlmConversation({
    runAction: async (name) => { if (name === 'set_visual_style') throw new Error('private details'); return {}; },
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return reply({ text: '', toolCalls: [{ id: `x${++round}`, name: 'set_visual_style', arguments: { style: 'noir' } }] });
    },
  });
  await assert.rejects(conversation.send('test'), { code: 'LLM_TOOL_LIMIT' });
  assert.ok(round <= 8);
  assert.equal(JSON.parse(requests[1].messages.at(-1).content).ok, false);
  assert.equal(JSON.stringify(requests).includes('private details'), false);
});

test('failed requests and clear do not retain incomplete conversation history', async () => {
  const requests = [];
  let fail = true;
  const conversation = createLlmConversation({
    runAction: async () => ({}),
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return fail ? reply({ code: 'LLM_NOT_CONFIGURED', error: 'missing' }, false) : reply({ text: 'ok', toolCalls: [] });
    },
  });
  await assert.rejects(conversation.send('failed'), { code: 'LLM_NOT_CONFIGURED' });
  fail = false;
  await conversation.send('next');
  assert.equal(requests[1].messages.length, 1);
  conversation.clear();
  await conversation.send('fresh');
  assert.equal(requests[2].messages.length, 1);
});

test('a long model answer is shown without poisoning subsequent message validation', async () => {
  const requests = [];
  const displayed = [];
  const conversation = createLlmConversation({
    runAction: async () => ({}), onMessage: (message) => displayed.push(message),
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return reply({ text: requests.length === 1 ? 'x'.repeat(20000) : 'ok', toolCalls: [] });
    },
  });
  await conversation.send('long answer');
  assert.equal(displayed.at(-1).content.length, 20000);
  await conversation.send('follow up');
  assert.equal(requests[1].messages.length, 1);
});

test('compatible servers may reuse their tool IDs without breaking later turns', async () => {
  const conversation = createLlmConversation({
    runAction: async () => ({ ok: true }),
    fetchImpl: async (_url, options) => {
      const { messages } = JSON.parse(options.body);
      assert.equal(validateChatMessages(messages), true);
      return reply(messages.at(-1).role === 'tool' ? { text: 'ok', toolCalls: [] }
        : { text: '', toolCalls: [{ id: 'call_0', name: 'zoom_to_globe', arguments: {} }] });
    },
  });
  await conversation.send('first');
  await conversation.send('second');
});

test('fresh source evidence joins the view context after every completed action', async () => {
  let style = 'normal';
  const contexts = [];
  const optionsSeen = [];
  const conversation = createLlmConversation({
    runAction: async (name, args) => {
      if (name === 'set_visual_style') style = args.style;
      return { ok: true, style };
    },
    getContext: async (options) => {
      optionsSeen.push(options);
      return { intelligence: { observedStyle: style, source: 'USGS', updatedAt: '2026-09-07T00:00:00Z' } };
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      contexts.push(body.context);
      return reply(contexts.length === 1 ? {
        text: '', toolCalls: [{ id: 'style', name: 'set_visual_style', arguments: { style: 'thermal' } }],
      } : { text: 'Ready', toolCalls: [] });
    },
  });
  await conversation.send('Switch style then summarize');
  assert.equal(contexts[0].intelligence.source, 'USGS');
  assert.equal(contexts[1].style, 'thermal');
  assert.equal(contexts[1].intelligence.observedStyle, 'thermal');
  assert.equal(optionsSeen[0].viewState.style, 'normal');
  assert.ok(optionsSeen[0].signal instanceof AbortSignal);
});

test('unavailable evidence is explicit while preserving the current view state', async () => {
  let request;
  const conversation = createLlmConversation({
    runAction: async () => ({ style: 'normal' }),
    getContext: async () => { throw new Error('private internal data'); },
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return reply({ text: 'Map only', toolCalls: [] });
    },
  });
  await conversation.send('Brief');
  assert.equal(request.context.style, 'normal');
  assert.deepEqual(request.context.intelligence, { available: false });
  assert.equal(JSON.stringify(request).includes('private internal data'), false);
});

test('cancellation while collecting evidence prevents a model request', async () => {
  let release;
  let calls = 0;
  const conversation = createLlmConversation({
    runAction: async () => ({}),
    getContext: async () => new Promise((resolve) => { release = resolve; }),
    fetchImpl: async () => { calls += 1; return reply({ text: 'No', toolCalls: [] }); },
  });
  const waiting = conversation.send('Brief');
  await new Promise((resolve) => setImmediate(resolve));
  conversation.cancel();
  release({ intelligence: {} });
  await assert.rejects(waiting, { code: 'LLM_CANCELLED' });
  assert.equal(calls, 0);
});

test('conversation leaves an action pending without further model rounds until confirmed', async () => {
  let style = 'normal';
  let rounds = 0;
  const guard = createActionGuard({
    runAction: async (name, args) => {
      if (name === 'set_visual_style') style = args.style;
      return { ok: true, style };
    },
    captureState: () => ({ style }),
    restoreState: (snapshot) => { style = snapshot.style; },
  });
  const states = [];
  const conversation = createLlmConversation({
    runAction: guard.runAction,
    onState: (state) => states.push(state),
    fetchImpl: async () => {
      rounds += 1;
      return reply(rounds === 1 ? {
        text: '', toolCalls: [{ id: 'style', name: 'set_visual_style', arguments: { style: 'noir' } }],
      } : { text: 'Applied', toolCalls: [] });
    },
  });
  const waiting = conversation.send('Switch style');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(style, 'normal');
  assert.equal(rounds, 1);
  assert.equal(guard.getState().pending.name, 'set_visual_style');
  const count = states.length;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(states.length, count);
  await guard.confirm();
  await waiting;
  assert.equal(style, 'noir');
  assert.equal(rounds, 2);
  await guard.undo();
  assert.equal(style, 'normal');
});

test('clearing a conversation releases pending confirmation without altering the map', async () => {
  let changes = 0;
  const guard = createActionGuard({
    runAction: async (name) => { if (name !== 'get_current_view_state') changes += 1; return { ok: true }; },
    captureState: () => ({}), restoreState: () => {},
  });
  const conversation = createLlmConversation({
    runAction: guard.runAction,
    fetchImpl: async () => reply({ text: '', toolCalls: [{ id: 'globe', name: 'zoom_to_globe', arguments: {} }] }),
  });
  const waiting = conversation.send('Show Earth');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(guard.getState().pending);
  conversation.clear();
  await assert.rejects(waiting, { code: 'LLM_CANCELLED' });
  assert.equal(guard.getState().pending, null);
  assert.equal(changes, 0);
});

test('invalid input, busy sends, and destroyed conversations fail without issuing requests', async () => {
  let release;
  const conversation = createLlmConversation({
    runAction: async () => ({}),
    fetchImpl: async () => new Promise((resolve) => { release = resolve; }),
  });
  for (const input of ['', ' ', null, 'x'.repeat(8001)]) {
    await assert.rejects(conversation.send(input), { code: 'LLM_EMPTY_MESSAGE' });
  }
  const waiting = conversation.send('hello');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(conversation.send('busy'), { code: 'LLM_BUSY' });
  conversation.destroy();
  release(reply({ text: 'done', toolCalls: [] }));
  await assert.rejects(waiting, { code: 'LLM_CANCELLED' });
  await assert.rejects(conversation.send('closed'), { code: 'LLM_EMPTY_MESSAGE' });
});

test('view read failures are reported as unavailable and request failures are sanitized', async () => {
  let request;
  const conversation = createLlmConversation({
    runAction: async () => { throw new Error('private'); },
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      throw new Error('private endpoint');
    },
  });
  await assert.rejects(conversation.send('hello'), { code: 'LLM_ERROR' });
  assert.deepEqual(request.context, { available: false });
});

test('invalid model payloads and empty replies do not reach map actions', async () => {
  for (const payload of [
    { text: '' }, { text: 3 }, { text: 'ok', toolCalls: {} },
    { text: '', toolCalls: Array.from({ length: 5 }, (_, i) => ({ id: `g${i}`, name: 'zoom_to_globe', arguments: {} })) },
    { text: '', toolCalls: Array.from({ length: 2 }, () => ({ id: 'g', name: 'zoom_to_globe', arguments: {} })) },
  ]) {
    let changed = false;
    const conversation = createLlmConversation({
      runAction: async (name) => { if (name !== 'get_current_view_state') changed = true; return {}; },
      fetchImpl: async () => reply(payload),
    });
    await assert.rejects(conversation.send('hello'), { code: 'LLM_INVALID_RESPONSE' });
    assert.equal(changed, false);
  }
});

test('missing, unreadable, and oversized action results become bounded failure evidence', async () => {
  const cyclic = {};
  cyclic.self = cyclic;
  for (const actionResult of [undefined, cyclic, { text: 'x'.repeat(18000) }]) {
    const requests = [];
    const conversation = createLlmConversation({
      runAction: async (name) => name === 'get_current_view_state' ? {} : actionResult,
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return reply(requests.length === 1 ? {
          text: '', toolCalls: [{ id: 'g', name: 'zoom_to_globe', arguments: {} }],
        } : { text: 'Failed', toolCalls: [] });
      },
    });
    await conversation.send('Show Earth');
    assert.equal(JSON.parse(requests[1].messages.at(-1).content).ok, false);
    assert.ok(requests[1].messages.at(-1).content.length < 200);
  }
});

test('brief intent sends only the current user request and never permits a model tool call', async () => {
  const requests = [];
  const actions = [];
  let returnTool = false;
  const conversation = createLlmConversation({
    runAction: async (name) => { actions.push(name); return { ok: true }; },
    getContext: async () => ({ intelligence: { source: 'USGS' } }),
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return reply(returnTool ? { text: '', toolCalls: [{ id: 'x', name: 'get_entity_context', arguments: {} }] } : { text: 'Brief', toolCalls: [] });
    },
  });
  await conversation.send('Old instruction');
  await conversation.send('Current brief', { intent: 'brief' });
  assert.equal(Object.hasOwn(requests[0], 'intent'), false);
  assert.equal(requests[1].intent, 'brief');
  assert.deepEqual(requests[1].messages, [{ role: 'user', content: 'Current brief' }]);
  assert.equal(requests[1].context.intelligence.source, 'USGS');
  returnTool = true;
  await assert.rejects(conversation.send('Read-only brief', { intent: 'brief' }), { code: 'LLM_INVALID_RESPONSE' });
  assert.equal(actions.includes('get_entity_context'), false);
  assert.equal(requests.length, 3);
});

test('invalid conversation intents fail before reading map data or requesting a model', async () => {
  let called = false;
  const conversation = createLlmConversation({
    runAction: async () => { called = true; return {}; },
    fetchImpl: async () => { called = true; return reply({ text: 'No', toolCalls: [] }); },
  });
  for (const intent of ['execute', null, 1, {}]) await assert.rejects(conversation.send('Test', { intent }), { code: 'LLM_INVALID_REQUEST' });
  assert.equal(called, false);
});
