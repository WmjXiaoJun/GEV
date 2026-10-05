import { LLM_PROVIDERS, validateLlmBaseUrl } from './providers.js';
import { emitStreamDelta, readUpstreamStream } from './upstreamStream.mjs';

export const LLM_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REQUEST_BYTES = 1_000_000;
const validName = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
const error = (code, message) => Object.assign(new Error(message), { code });
const invalidInput = () => error('LLM_INVALID_INPUT', 'Invalid LLM conversation or tools.');
const invalidResponse = () => error('LLM_INVALID_RESPONSE', 'The LLM provider returned an invalid response.');

function checkedConfig(config) {
  const selected = LLM_PROVIDERS.find(({ id }) => id === config?.provider);
  if (!selected) throw error('LLM_INVALID_CONFIG', 'Unsupported LLM provider.');
  const baseUrl = validateLlmBaseUrl(config.baseUrl);
  if (typeof config.model !== 'string' || config.model.length > 256 || /[\u0000-\u001f\u007f]/.test(config.model)
    || typeof config.apiKey !== 'string' || config.apiKey.length > 2048 || /[\u0000-\u001f\u007f]/.test(config.apiKey)) {
    throw error('LLM_INVALID_CONFIG', 'Invalid LLM model or API key.');
  }
  if (!config.model.trim() || !baseUrl || (!config.apiKey.trim() && !selected.keyOptional)) {
    throw error('LLM_NOT_CONFIGURED', 'Configure an LLM provider, model and API key first.');
  }
  return { ...config, model: config.model.trim(), apiKey: config.apiKey.trim(), baseUrl };
}

function checkedInput(messages, tools) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 128 || !Array.isArray(tools) || tools.length > 100) throw invalidInput();
  const names = tools.map((tool) => tool?.name);
  if (new Set(names).size !== names.length) throw invalidInput();
  if (tools.some((tool) => !validName(tool?.name) || typeof tool.description !== 'string' || !isObject(tool.parameters))) throw invalidInput();
  for (const message of messages) {
    if (!['system', 'user', 'assistant', 'tool'].includes(message?.role)
      || typeof message.content !== 'string' || message.content.length > 256_000) throw invalidInput();
    if (message.role === 'tool' && (!safeId(message.toolCallId) || !validName(message.name))) throw invalidInput();
    if (message.toolCalls !== undefined && (!Array.isArray(message.toolCalls) || message.role !== 'assistant'
      || message.toolCalls.some((call) => !safeId(call.id) || !names.includes(call.name) || !isObject(call.arguments)))) throw invalidInput();
  }
  return new Set(names);
}

function openAiRequest(config, messages, tools, stream) {
  return {
    url: `${config.baseUrl}/chat/completions`,
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    body: {
      model: config.model,
      messages: messages.map((message) => ({
        role: message.role, content: message.content,
        ...(message.role === 'tool' ? { tool_call_id: message.toolCallId } : {}),
        ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({
          id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })) } : {}),
      })),
      ...(tools.length ? { tools: tools.map((tool) => ({ type: 'function', function: tool })) } : {}),
      stream,
    },
  };
}

function mergeTurns(turns, key) {
  return turns.reduce((merged, turn) => {
    const previous = merged.at(-1);
    return previous?.role === turn.role
      ? [...merged.slice(0, -1), { ...turn, [key]: [...previous[key], ...turn[key]] }]
      : [...merged, turn];
  }, []);
}

function anthropicRequest(config, messages, tools, stream) {
  const turns = messages.filter(({ role }) => role !== 'system').map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.role === 'tool'
      ? [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }]
      : [
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...(message.toolCalls ?? []).map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })),
      ],
  }));
  return {
    url: `${config.baseUrl}/messages`,
    headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
    body: {
      model: config.model, max_tokens: 4096,
      ...(stream ? { stream: true } : {}),
      system: messages.filter(({ role }) => role === 'system').map(({ content }) => content).join('\n\n'),
      messages: mergeTurns(turns, 'content'),
      ...(tools.length ? { tools: tools.map(({ name, description, parameters }) => ({ name, description, input_schema: parameters })) } : {}),
    },
  };
}

// Gemini's Schema dialect does not support every JSON Schema keyword.
function geminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!isObject(schema)) return schema;
  return Object.fromEntries(Object.entries(schema)
    .filter(([key]) => !['additionalProperties', '$schema', '$id', 'strict'].includes(key))
    .map(([key, value]) => [key, key === 'properties' && isObject(value)
      ? Object.fromEntries(Object.entries(value).map(([name, property]) => [name, geminiSchema(property)]))
      : geminiSchema(value)]));
}

function toolResult(content) {
  try {
    const parsed = JSON.parse(content);
    return isObject(parsed) ? parsed : { result: parsed };
  } catch { return { result: content }; }
}

function geminiRequest(config, messages, tools, stream) {
  const callsById = new Map(messages.flatMap((message) => (message.toolCalls ?? []).map((call) => [call.id, call])));
  const turns = messages.filter(({ role }) => role !== 'system').map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: message.role === 'tool' ? [{ functionResponse: {
      name: message.name, response: toolResult(message.content),
      ...(callsById.get(message.toolCallId)?.providerCallId ? { id: callsById.get(message.toolCallId).providerCallId } : {}),
    } }] : [
      ...(message.content ? [{ text: message.content }] : []),
      ...(message.toolCalls ?? []).map((call) => ({
        functionCall: { name: call.name, args: call.arguments, ...(call.providerCallId ? { id: call.providerCallId } : {}) },
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
      })),
    ],
  }));
  const model = config.model.replace(/^models\//, '');
  return {
    url: `${config.baseUrl}/models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
    headers: { 'x-goog-api-key': config.apiKey },
    body: {
      systemInstruction: { parts: [{ text: messages.filter(({ role }) => role === 'system').map(({ content }) => content).join('\n\n') }] },
      contents: mergeTurns(turns, 'parts'),
      ...(tools.length ? { tools: [{ functionDeclarations: tools.map((tool) => ({ ...tool, parameters: geminiSchema(tool.parameters) })) }] } : {}),
    },
  };
}

function checkedCall(call, names) {
  if (!safeId(call.id) || !names.has(call.name) || !isObject(call.arguments)
    || JSON.stringify(call.arguments).length > 16_000) throw invalidResponse();
  return call;
}

function parseOpenAi(payload, names) {
  const message = payload?.choices?.[0]?.message;
  if (!isObject(message) || (message.content != null && typeof message.content !== 'string')
    || (message.tool_calls != null && !Array.isArray(message.tool_calls))) throw invalidResponse();
  const toolCalls = (message.tool_calls ?? []).map((call) => {
    if (typeof call?.function?.arguments !== 'string') throw invalidResponse();
    let args;
    try { args = JSON.parse(call.function.arguments); } catch { throw invalidResponse(); }
    return checkedCall({ id: call.id, name: call.function.name, arguments: args }, names);
  });
  return { text: message.content ?? '', toolCalls, ...(isObject(payload.usage) ? { usage: payload.usage } : {}) };
}

function parseAnthropic(payload, names) {
  if (!Array.isArray(payload?.content) || !payload.content.every(isObject)) throw invalidResponse();
  const text = payload.content.filter((block) => block.type === 'text').map((block) => {
    if (typeof block.text !== 'string') throw invalidResponse();
    return block.text;
  }).join('\n');
  const toolCalls = payload.content.filter((block) => block.type === 'tool_use').map((block) => checkedCall({
    id: block.id, name: block.name, arguments: block.input,
  }, names));
  return { text, toolCalls, ...(isObject(payload.usage) ? { usage: payload.usage } : {}) };
}

function parseGemini(payload, names) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || !parts.every(isObject)) throw invalidResponse();
  const text = parts.filter((part) => part.text !== undefined && !part.thought).map((part) => {
    if (typeof part.text !== 'string') throw invalidResponse();
    return part.text;
  }).join('\n');
  const toolCalls = parts.filter((part) => part.functionCall).map((part) => checkedCall({
    id: part.functionCall.id ?? `gemini_${crypto.randomUUID()}`,
    name: part.functionCall.name, arguments: part.functionCall.args === undefined ? {} : part.functionCall.args,
    ...(part.functionCall.id ? { providerCallId: part.functionCall.id } : {}),
    ...(typeof part.thoughtSignature === 'string' ? { thoughtSignature: part.thoughtSignature } : {}),
  }, names));
  return { text, toolCalls, ...(isObject(payload.usageMetadata) ? { usage: payload.usageMetadata } : {}) };
}

async function readJsonBounded(response, signal) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES || !response.body) throw invalidResponse();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw invalidResponse();
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw invalidResponse(); }
}

export async function requestLlmCompletion({ config, messages, tools = [], fetchImpl = fetch, signal, stream = false, onDelta }) {
  if (typeof stream !== 'boolean' || (onDelta !== undefined && typeof onDelta !== 'function')) throw invalidInput();
  const resolved = checkedConfig(config);
  const names = checkedInput(messages, tools);
  const native = resolved.provider === 'anthropic' ? anthropicRequest
    : resolved.provider === 'gemini' ? geminiRequest : openAiRequest;
  const parser = resolved.provider === 'anthropic' ? parseAnthropic
    : resolved.provider === 'gemini' ? parseGemini : parseOpenAi;
  let request;
  let body;
  try {
    request = native(resolved, messages, tools, stream);
    body = JSON.stringify(request.body);
  } catch { throw invalidInput(); }
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) throw invalidInput();
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), LLM_TIMEOUT_MS);
  timer.unref?.();
  const timeout = timeoutController.signal;
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    combinedSignal.throwIfAborted();
    const response = await fetchImpl(request.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...request.headers },
      body, signal: combinedSignal, redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw error('LLM_UPSTREAM_ERROR', `The LLM provider returned HTTP ${Number(response.status) || 502}.`);
    }
    const streaming = stream && /^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '');
    const payload = streaming ? await readUpstreamStream({ response, provider: resolved.provider, signal: combinedSignal, onDelta })
      : await readJsonBounded(response, combinedSignal);
    const result = parser(payload, names);
    if (result.text.length > 18_000 || result.toolCalls.length > 4) throw invalidResponse();
    if (new Set(result.toolCalls.map(({ id }) => id)).size !== result.toolCalls.length) throw invalidResponse();
    if (!result.text.trim() && !result.toolCalls.length) throw invalidResponse();
    if (stream && !streaming) await emitStreamDelta(onDelta, result.text, combinedSignal);
    return result;
  } catch (failure) {
    if (signal?.aborted) throw error('LLM_CANCELLED', 'The LLM request was cancelled.');
    if (timeout.aborted) throw error('LLM_TIMEOUT', 'The LLM request timed out.');
    if (['LLM_INVALID_RESPONSE', 'LLM_UPSTREAM_ERROR'].includes(failure?.code)) throw failure;
    throw error('LLM_CONNECTION_ERROR', 'Unable to connect to the configured LLM provider.');
  } finally { clearTimeout(timer); }
}
