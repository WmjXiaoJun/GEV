const MAX_STREAM_BYTES = 2_000_000;
const MAX_EVENT_CHARS = 600_000;
const MAX_TEXT_CHARS = 256_000;
const fail = (code = 'LLM_INVALID_RESPONSE') => Object.assign(new Error(code), { code });

/** Read the local proxy protocol; tools are accepted only in its terminal payload. */
export async function readChatResponse(response, { signal, onDelta = () => {} } = {}) {
  const contentType = response.headers?.get?.('content-type') || '';
  if (!response.ok || !contentType.includes('text/event-stream')) {
    const payload = await response.json();
    if (!response.ok) throw fail(/^LLM_[A-Z_]+$/.test(payload?.code || '') ? payload.code : 'LLM_ERROR');
    return payload;
  }
  if (!response.body?.getReader) throw fail();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let bytes = 0;
  let text = '';
  let result;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const check = () => { if (signal?.aborted) throw fail('LLM_CANCELLED'); };
  function event(frame) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    let payload;
    try { payload = JSON.parse(data); } catch { throw fail(); }
    if (payload?.type === 'error') {
      throw fail(/^LLM_[A-Z_]+$/.test(payload.code || '') ? payload.code : 'LLM_UPSTREAM_ERROR');
    }
    if (payload?.type === 'delta' && typeof payload.text === 'string') {
      text += payload.text;
      if (text.length > MAX_TEXT_CHARS) throw fail();
      onDelta(text);
    } else if (payload?.type === 'done' && typeof payload.text === 'string'
      && payload.text.length <= MAX_TEXT_CHARS && Array.isArray(payload.toolCalls)) {
      result = payload;
    } else throw fail();
  }
  try {
    while (!result) {
      check();
      const chunk = await reader.read();
      check();
      if (chunk.done) throw fail();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) throw fail();
      buffer += decoder.decode(chunk.value, { stream: true });
      let separator;
      while (!result && (separator = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, separator.index);
        if (frame.length > MAX_EVENT_CHARS) throw fail();
        buffer = buffer.slice(separator.index + separator[0].length);
        event(frame);
      }
      if (buffer.length > MAX_EVENT_CHARS) throw fail();
    }
    check();
    return result;
  } catch (error) {
    check();
    throw /^LLM_[A-Z_]+$/.test(error?.code || '') ? error : fail();
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
