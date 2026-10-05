const MAX_BYTES = 2_000_000;
const MAX_EVENT = 128_000;
const MAX_TEXT = 18_000;
const MAX_ARGUMENTS = 16_000;
const MAX_TOOLS = 4;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code = 'LLM_INVALID_RESPONSE') => Object.assign(new Error('The LLM provider returned an invalid stream.'), { code });
const checkedString = (value, limit) => {
  if (typeof value !== 'string' || value.length > limit) throw failure();
  return value;
};
const indexOf = (value, limit = 128) => {
  if (!Number.isInteger(value) || value < 0 || value >= limit) throw failure();
  return value;
};
const parseObject = (text) => {
  let result;
  try { result = JSON.parse(text); } catch { throw failure(); }
  if (!object(result)) throw failure();
  return result;
};

// SSE framing is independent of network chunk boundaries, including UTF-8 and CRLF.
async function readEvents(response, signal, receive) {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_BYTES) throw failure();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let lines = [];
  let eventSize = 0;
  let bytes = 0;
  let ended = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  const consume = async (flush = false) => {
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer);
      if (!match || (!flush && match[0] === '\r' && match.index === buffer.length - 1)) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      eventSize += line.length;
      if (eventSize > MAX_EVENT) throw failure();
      if (line === '') {
        const data = lines.join('\n');
        lines = [];
        eventSize = 0;
        if (data && await receive(data)) { ended = true; return; }
      } else if (line.startsWith('data:')) {
        lines = [...lines, line.slice(5).replace(/^ /, '')];
      }
    }
    if (buffer.length + eventSize > MAX_EVENT) throw failure();
  };
  try {
    while (!ended) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        buffer += decoder.decode();
        await consume(true);
        if (buffer.trim() || lines.length) throw failure();
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw failure();
      buffer += decoder.decode(value, { stream: true });
      await consume();
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function openAiState(append) {
  let calls = {};
  let text = '';
  let finished = false;
  let usage;
  return {
    async accept(payload) {
      if (payload === '[DONE]') { if (!finished) throw failure(); return true; }
      if (payload.error) throw failure('LLM_UPSTREAM_ERROR');
      if (object(payload.usage)) usage = payload.usage;
      if (!Array.isArray(payload.choices) || payload.choices.length > 1) throw failure();
      const choice = payload.choices[0];
      if (!choice) return false;
      if (choice.index !== undefined && choice.index !== 0) throw failure();
      if (!object(choice.delta)) throw failure();
      if (finished && (choice.delta.content || choice.delta.tool_calls?.length)) throw failure();
      if (choice.delta.content != null) {
        const delta = checkedString(choice.delta.content, MAX_TEXT - text.length);
        text += delta;
        await append(delta);
      }
      if (choice.delta.tool_calls !== undefined) {
        if (!Array.isArray(choice.delta.tool_calls) || choice.delta.tool_calls.length > MAX_TOOLS) throw failure();
        for (const part of choice.delta.tool_calls) {
          const index = indexOf(part.index, MAX_TOOLS);
          const current = calls[index] ?? { id: '', name: '', args: '' };
          if (part.type !== undefined && part.type !== 'function') throw failure();
          if (part.function !== undefined && !object(part.function)) throw failure();
          calls = { ...calls, [index]: {
            id: checkedString(current.id + (part.id ?? ''), 256),
            name: checkedString(current.name + (part.function?.name ?? ''), 64),
            args: checkedString(current.args + (part.function?.arguments ?? ''), MAX_ARGUMENTS),
          } };
          for (const value of [part.id, part.function?.name, part.function?.arguments]) {
            if (value !== undefined && typeof value !== 'string') throw failure();
          }
        }
      }
      if (choice.finish_reason != null) {
        if (!['stop', 'tool_calls'].includes(choice.finish_reason)) throw failure();
        finished = true;
      }
      return false;
    },
    result() {
      if (!finished) throw failure();
      return { choices: [{ message: { content: text, tool_calls: Object.values(calls).map((call) => ({
        id: call.id, function: { name: call.name, arguments: call.args },
      })) } }], ...(usage ? { usage } : {}) };
    },
  };
}

function anthropicState(append) {
  let blocks = {};
  let stopped = new Set();
  let textLength = 0;
  let textBlocks = 0;
  let toolCount = 0;
  let finished = false;
  let stopReason = null;
  let usage = {};
  return {
    async accept(payload) {
      if (payload.type === 'error') throw failure('LLM_UPSTREAM_ERROR');
      if (payload.type === 'message_start') {
        if (object(payload.message?.usage)) usage = payload.message.usage;
      } else if (payload.type === 'content_block_start') {
        const index = indexOf(payload.index);
        const block = payload.content_block;
        if (blocks[index] || !object(block)) throw failure();
        if (block.type === 'tool_use' && ++toolCount > MAX_TOOLS) throw failure();
        blocks = { ...blocks, [index]: { ...block } };
        if (block.type === 'text') {
          const separator = textBlocks > 0 ? '\n' : '';
          const text = separator + checkedString(block.text, MAX_TEXT - textLength - separator.length);
          textBlocks += 1;
          textLength += text.length;
          await append(text);
        }
      } else if (payload.type === 'content_block_delta') {
        const index = indexOf(payload.index);
        const block = blocks[index];
        const delta = payload.delta;
        if (!block || stopped.has(index) || !object(delta)) throw failure();
        if (delta.type === 'text_delta' && block.type === 'text') {
          const text = checkedString(delta.text, MAX_TEXT - textLength);
          textLength += text.length;
          blocks = { ...blocks, [index]: { ...block, text: block.text + text } };
          await append(text);
        } else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
          const json = checkedString(delta.partial_json, MAX_ARGUMENTS);
          blocks = { ...blocks, [index]: { ...block, json: checkedString((block.json ?? '') + json, MAX_ARGUMENTS) } };
        } else if (!['thinking_delta', 'signature_delta', 'citations_delta'].includes(delta.type)) throw failure();
      } else if (payload.type === 'content_block_stop') {
        const index = indexOf(payload.index);
        if (!blocks[index] || stopped.has(index)) throw failure();
        stopped = new Set([...stopped, index]);
      } else if (payload.type === 'message_delta') {
        stopReason = payload.delta?.stop_reason ?? stopReason;
        if (object(payload.usage)) usage = { ...usage, ...payload.usage };
      } else if (payload.type === 'message_stop') {
        if (!['end_turn', 'tool_use', 'stop_sequence'].includes(stopReason)
          || stopped.size !== Object.keys(blocks).length) throw failure();
        finished = true;
        return true;
      } else if (payload.type !== 'ping') throw failure();
      return false;
    },
    result() {
      if (!finished) throw failure();
      return { content: Object.values(blocks).map((block) => block.type === 'tool_use'
        ? { type: block.type, id: block.id, name: block.name, input: block.json === undefined ? block.input : parseObject(block.json) }
        : block), usage };
    },
  };
}

function geminiState(append) {
  let text = '';
  let calls = [];
  let finished = false;
  let usage;
  return {
    async accept(payload) {
      if (payload.error) throw failure('LLM_UPSTREAM_ERROR');
      if (object(payload.usageMetadata)) usage = payload.usageMetadata;
      if (!Array.isArray(payload.candidates) || payload.candidates.length > 1) throw failure();
      const candidate = payload.candidates[0];
      if (!candidate) return false;
      if (candidate.index !== undefined && candidate.index !== 0) throw failure();
      const parts = candidate.content?.parts ?? [];
      if (!Array.isArray(parts) || (finished && parts.length)) throw failure();
      for (const part of parts) {
        if (!object(part)) throw failure();
        if (part.text !== undefined && !part.thought) {
          const delta = checkedString(part.text, MAX_TEXT - text.length);
          text += delta;
          await append(delta);
        }
        if (part.functionCall) {
          if (!object(part.functionCall) || calls.length >= MAX_TOOLS
            || JSON.stringify(part.functionCall.args ?? {}).length > MAX_ARGUMENTS
            || (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== 'string')
            || (part.thoughtSignature?.length ?? 0) > 16_000) throw failure();
          calls = [...calls, part];
        }
      }
      if (candidate.finishReason !== undefined) {
        if (candidate.finishReason !== 'STOP') throw failure();
        finished = true;
      }
      return false;
    },
    result() {
      if (!finished) throw failure();
      return { candidates: [{ content: { parts: [{ text }, ...calls] } }], ...(usage ? { usageMetadata: usage } : {}) };
    },
  };
}

export async function emitStreamDelta(onDelta, text, signal) {
  if (!text || !onDelta) return;
  signal?.throwIfAborted();
  let cancel;
  const aborted = new Promise((_, reject) => {
    cancel = () => reject(signal.reason);
    signal?.addEventListener('abort', cancel, { once: true });
  });
  try { await Promise.race([Promise.resolve().then(() => onDelta(text)), aborted]); }
  finally { signal?.removeEventListener('abort', cancel); }
}

export async function readUpstreamStream({ response, provider, signal, onDelta }) {
  const append = (text) => emitStreamDelta(onDelta, text, signal);
  const state = provider === 'anthropic' ? anthropicState(append) : provider === 'gemini' ? geminiState(append) : openAiState(append);
  await readEvents(response, signal, (data) => state.accept(data === '[DONE]' ? data : parseObject(data)));
  return state.result();
}
