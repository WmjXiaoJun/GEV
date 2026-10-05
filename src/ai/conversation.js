import { validToolCall } from './tools.js';
import { normalizeChineseText } from './chinese.js';
import { readChatResponse } from './chatStream.js';

const fail = (code) => Object.assign(new Error(code), { code });
const MAX_ROUNDS = 6;
const MAX_HISTORY_BYTES = 90000;

export function createLlmConversation({
  runAction, fetchImpl = globalThis.fetch?.bind(globalThis),
  getLocale = () => 'en', onMessage = () => {}, onState = () => {},
  getContext,
} = {}) {
  let turns = [];
  let active = null;
  let destroyed = false;
  let sequence = 0;
  let interrupt = () => {};

  const cancel = () => {
    interrupt();
    active?.abort();
    active = null;
    onState('idle');
  };

  const send = async (input, { intent } = {}) => {
    if (intent !== undefined && intent !== 'brief') throw fail('LLM_INVALID_REQUEST');
    if (active) throw fail('LLM_BUSY');
    const locale = getLocale();
    const content = normalizeChineseText(input, locale).trim();
    if (!content || content.length > 8000 || destroyed) throw fail('LLM_EMPTY_MESSAGE');
    const controller = new AbortController();
    const turnId = ++sequence;
    active = controller;
    const current = () => active === controller && !controller.signal.aborted;
    const check = () => { if (!current()) throw fail('LLM_CANCELLED'); };
    const turn = [{ role: 'user', content }];
    let partial = null;
    const finishPartial = () => {
      if (partial) onMessage({ ...partial, streaming: false, incomplete: true });
      partial = null;
    };
    interrupt = finishPartial;
    onMessage(turn[0]);
    onState('thinking');
    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        onState('thinking');
        let context;
        try { context = await runAction('get_current_view_state', {}, { signal: controller.signal }); }
        catch { context = { available: false }; }
        check();
        if (getContext) {
          try { context = { ...context, ...await getContext({ signal: controller.signal, viewState: context }) }; }
          catch { context = { ...context, intelligence: { available: false } }; }
          check();
        }
        const response = await fetchImpl('/api/ai/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({
            messages: intent === 'brief' ? turn : [...turns.flat(), ...turn], context, locale, stream: true,
            ...(intent === 'brief' ? { intent } : {}),
          }),
          signal: controller.signal,
        });
        const id = `reply_${turnId}_${round}`;
        const rawPayload = await readChatResponse(response, {
          signal: controller.signal,
          onDelta(text) {
            check();
            if (!partial) onState('streaming');
            partial = { id, role: 'assistant', content: normalizeChineseText(text, locale), streaming: true };
            onMessage(partial);
          },
        });
        check();
        const payload = { ...rawPayload, text: normalizeChineseText(rawPayload?.text, locale) };
        if (typeof rawPayload?.text !== 'string') throw fail('LLM_INVALID_RESPONSE');
        const rawCalls = payload.toolCalls ?? [];
        if (typeof payload.text !== 'string' || !Array.isArray(rawCalls) || rawCalls.length > 4
          || (intent === 'brief' && rawCalls.length > 0)
          || rawCalls.some((call) => !validToolCall(call))
          || new Set(rawCalls.map((call) => call.id)).size !== rawCalls.length) throw fail('LLM_INVALID_RESPONSE');
        // Some compatible servers reuse call IDs on each request. Local IDs keep
        // history pairs unique; Gemini's native providerCallId remains separate.
        const calls = rawCalls.map((call, index) => ({ ...call, id: `gev_${turnId}_${round}_${index}` }));
        const message = { role: 'assistant', content: payload.text, ...(calls.length ? { toolCalls: calls } : {}) };
        turn.push(message);
        if (payload.text || partial) onMessage({ id, role: 'assistant', content: payload.text, streaming: false });
        partial = null;
        if (!calls.length) {
          if (!payload.text.trim()) throw fail('LLM_INVALID_RESPONSE');
          // Trim complete turns only, preserving provider tool-call/result pairing.
          turns = turn.some((entry) => entry.content.length > 18000)
            ? [] : [...turns, turn].slice(-4);
          while (turns.length && (JSON.stringify(turns).length > MAX_HISTORY_BYTES || turns.flat().length > 24)) turns = turns.slice(1);
          return payload.text;
        }
        for (const call of calls) {
          check();
          onState('executing');
          let result;
          try {
            result = await runAction(call.name, {
              ...call.arguments,
              ...(call.name === 'fly_to_location' ? { waitForArrival: true } : {}),
            }, { signal: controller.signal, isCurrent: current });
          } catch { result = { ok: false, error: 'Map action failed' }; }
          check();
          let resultText;
          try { resultText = JSON.stringify(result ?? { ok: false, error: 'No result' }); }
          catch { resultText = JSON.stringify({ ok: false, error: 'Unreadable result' }); }
          if (resultText.length > 16000) resultText = JSON.stringify({ ok: false, error: 'Result too large; narrow the query' });
          turn.push({ role: 'tool', content: resultText, toolCallId: call.id, name: call.name });
          onMessage({ role: 'tool', content: call.name, ok: result?.ok === true });
        }
      }
      throw fail('LLM_TOOL_LIMIT');
    } catch (error) {
      finishPartial();
      if (!current()) throw fail('LLM_CANCELLED');
      onState('error');
      throw error?.code ? error : fail('LLM_ERROR');
    } finally {
      if (active === controller) { active = null; interrupt = () => {}; onState('idle'); }
    }
  };

  return {
    send, cancel,
    clear: () => { cancel(); turns = []; },
    destroy: () => { cancel(); turns = []; destroyed = true; },
  };
}
