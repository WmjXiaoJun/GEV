import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLlmSpeechController } from './llmSpeech.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function harness(overrides = {}) {
  const events = { states: [], errors: [], texts: [], speech: [], transcripts: [], fetches: [], cancels: 0 };
  const recognizers = [];
  const recorders = [];
  const timers = new Map();
  const tracks = [{ stops: 0, stop() { this.stops += 1; } }];
  const stream = { getTracks: () => tracks };
  class Recognition {
    constructor() { recognizers.push(this); this.stops = 0; this.aborts = 0; }
    start() { this.onstart?.(); }
    stop() { this.stops += 1; this.onend?.(); }
    abort() { this.aborts += 1; this.onend?.(); }
    result(text, final = true) {
      this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: final })] });
    }
  }
  class Recorder {
    static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    constructor(input, options) {
      this.input = input;
      this.mimeType = options?.mimeType || 'audio/webm';
      this.state = 'inactive';
      recorders.push(this);
    }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
    chunk(text = 'recorded audio') { this.ondataavailable?.({ data: new Blob([text], { type: this.mimeType }) }); }
  }
  class Utterance { constructor(text) { this.text = text; } }
  let timerId = 0;
  const deps = {
    getConfig: () => ({ configured: true, speech: { provider: 'browser', configured: true } }),
    getLocale: () => 'zh-CN',
    sendText: async (text) => { events.texts.push(text); return 'Done'; },
    cancelText: () => { events.cancels += 1; },
    onState: (state, detail) => events.states.push([state, detail]),
    onError: (code) => events.errors.push(code),
    onTranscript: (text) => events.transcripts.push(text),
    Recognition,
    MediaRecorder: Recorder,
    mediaDevices: { getUserMedia: async () => stream },
    speechSynthesis: { cancel() {}, speak(utterance) { events.speech.push(utterance); utterance.onend?.(); } },
    Utterance,
    fetchImpl: async (url, options) => {
      events.fetches.push({ url, options });
      return { ok: true, json: async () => ({ text: 'Fly to London' }) };
    },
    setTimer: (fn, ms) => { const id = ++timerId; timers.set(id, { fn: () => { timers.delete(id); fn(); }, ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    ...overrides,
  };
  const controller = createLlmSpeechController(deps);
  return { controller, events, recognizers, recorders, tracks, stream, timers, deps };
}

test('browser speech sends final text through the configured LLM and speaks its answer once', async () => {
  const h = harness();
  await h.controller.start();
  assert.equal(h.recognizers[0].lang, 'zh-CN');
  h.recognizers[0].result('Fly to London');
  const ended = h.recognizers[0].onend;
  ended();
  ended();
  await tick();
  assert.deepEqual(h.events.texts, ['Fly to London']);
  assert.equal(h.events.speech[0].text, 'Done');
  assert.equal(h.events.fetches.length, 0);
  assert.equal(h.controller.isActive(), false);
  assert.equal(h.timers.size, 0);
});

test('finish never submits interim recognition text', async () => {
  const h = harness({ getLocale: () => 'en' });
  await h.controller.start({ pushToTalk: true });
  assert.equal(h.recognizers[0].lang, 'en-US');
  h.recognizers[0].result('partial', false);
  h.controller.finish();
  await tick();
  assert.deepEqual(h.events.texts, []);
  assert.deepEqual(h.events.errors, ['VOICE_NO_SPEECH']);
});

test('browser without recognition reports an actionable unsupported error', async () => {
  const h = harness({ Recognition: null });
  await h.controller.start();
  assert.deepEqual(h.events.errors, ['VOICE_BROWSER_UNSUPPORTED']);
  assert.equal(h.controller.isActive(), false);
});

test('browser recognition waits for microphone access and releases the preflight stream', async () => {
  const permission = deferred();
  const h = harness({ mediaDevices: { getUserMedia: () => permission.promise } });
  const started = h.controller.start();
  await tick();
  assert.equal(h.recognizers.length, 0);
  permission.resolve(h.stream);
  await started;
  assert.equal(h.recognizers.length, 1);
  assert.equal(h.tracks[0].stops, 1);
  assert.ok(h.events.states.some(([phase]) => phase === 'connecting'));
  h.controller.stop();
});

test('browser recognition distinguishes blocked service from denied microphone permission', async () => {
  const h = harness();
  await h.controller.start();
  h.recognizers[0].onerror({ error: 'service-not-allowed' });
  assert.deepEqual(h.events.errors, ['VOICE_RECOGNITION_UNAVAILABLE']);
  assert.equal(h.controller.isActive(), false);
});

test('a browser recognizer that never starts reports service unavailable after a bounded deadline', async () => {
  class SilentRecognition { start() {} abort() {} }
  const h = harness({ Recognition: SilentRecognition });
  await h.controller.start();
  const timer = [...h.timers.values()].find(({ ms }) => ms === 8_000);
  assert.ok(timer, 'recognition startup has its own eight-second deadline');
  timer.fn();
  assert.deepEqual(h.events.errors, ['VOICE_RECOGNITION_UNAVAILABLE']);
  assert.equal(h.timers.size, 0);
});

test('browser microphone failures are checked before starting recognition', async () => {
  for (const [mediaDevices, code] of [
    [null, 'VOICE_CAPTURE_UNSUPPORTED'],
    [{ getUserMedia: async () => { throw { name: 'NotAllowedError' }; } }, 'VOICE_PERMISSION'],
    [{ getUserMedia: async () => { throw { name: 'NotReadableError' }; } }, 'VOICE_MICROPHONE_BUSY'],
  ]) {
    const h = harness({ mediaDevices });
    await h.controller.start();
    assert.equal(h.recognizers.length, 0);
    assert.deepEqual(h.events.errors, [code]);
  }
});

test('cancelled browser permission cannot start recognition after late approval', async () => {
  const permission = deferred();
  const h = harness({ mediaDevices: { getUserMedia: () => permission.promise } });
  const started = h.controller.start();
  await tick();
  h.controller.stop();
  permission.resolve(h.stream);
  await started;
  assert.equal(h.recognizers.length, 0);
  assert.equal(h.tracks[0].stops, 1);
});

test('browser permission and network errors cleanly release the session', async () => {
  for (const [error, code] of [['not-allowed', 'VOICE_PERMISSION'], ['network', 'VOICE_NETWORK'], ['no-speech', 'VOICE_NO_SPEECH']]) {
    const h = harness();
    await h.controller.start();
    h.recognizers[0].onerror({ error });
    assert.deepEqual(h.events.errors, [code]);
    assert.equal(h.controller.isActive(), false);
    assert.equal(h.timers.size, 0);
  }
});

test('stop blocks late recognition callbacks and cancels a pending model answer', async () => {
  const result = deferred();
  const h = harness({ sendText: () => result.promise });
  await h.controller.start();
  h.recognizers[0].result('Go');
  h.recognizers[0].onend();
  await tick();
  assert.equal(h.controller.isActive(), true);
  h.controller.stop();
  result.resolve('late response');
  await tick();
  assert.equal(h.events.cancels, 1);
  assert.equal(h.events.speech.length, 0);
  assert.equal(h.timers.size, 0);
});

test('configured transcription records audio, stops all tracks, and submits recognized text', async () => {
  const h = harness({ getConfig: () => ({ configured: true, speech: { provider: 'current', configured: true } }) });
  await h.controller.start();
  assert.equal(h.recorders[0].state, 'recording');
  h.recorders[0].chunk();
  h.controller.finish();
  h.controller.finish();
  await tick();
  assert.equal(h.events.fetches.length, 1);
  assert.equal(h.events.fetches[0].url, '/api/ai/transcribe');
  const body = JSON.parse(h.events.fetches[0].options.body);
  assert.equal(body.mimeType, 'audio/webm;codecs=opus');
  assert.equal(body.locale, 'zh-CN');
  assert.equal(Buffer.from(body.audio, 'base64').toString(), 'recorded audio');
  assert.deepEqual(h.events.texts, ['Fly to London']);
  assert.equal(h.tracks[0].stops, 1);
  assert.equal(h.controller.isActive(), false);
});

test('release before microphone permission resolves cannot start a delayed recording', async () => {
  const permission = deferred();
  const h = harness({
    getConfig: () => ({ configured: true, speech: { provider: 'custom', configured: true } }),
    mediaDevices: { getUserMedia: () => permission.promise },
  });
  const started = h.controller.start({ pushToTalk: true });
  await tick();
  h.controller.finish();
  permission.resolve(h.stream);
  await started;
  assert.equal(h.recorders.length, 0);
  assert.equal(h.tracks[0].stops, 1);
  assert.equal(h.events.fetches.length, 0);
  assert.equal(h.controller.isActive(), false);
});

test('cancel during transcription aborts the request and ignores late text', async () => {
  const response = deferred();
  const h = harness({
    getConfig: () => ({ configured: true, speech: { provider: 'custom', configured: true } }),
    fetchImpl: async (url, options) => { h.events.fetches.push({ url, options }); return response.promise; },
  });
  await h.controller.start();
  h.recorders[0].chunk();
  h.controller.finish();
  await tick();
  h.controller.stop();
  assert.equal(h.events.fetches[0].options.signal.aborted, true);
  response.resolve({ ok: true, json: async () => ({ text: 'must not run' }) });
  await tick();
  assert.deepEqual(h.events.texts, []);
});

test('oversized recording fails before any upload', async () => {
  const h = harness({ getConfig: () => ({ configured: true, speech: { provider: 'current', configured: true } }) });
  await h.controller.start();
  h.recorders[0].chunk(new Uint8Array(4 * 1024 * 1024 + 1));
  await tick();
  assert.deepEqual(h.events.errors, ['VOICE_AUDIO_TOO_LARGE']);
  assert.equal(h.events.fetches.length, 0);
  assert.equal(h.tracks[0].stops, 1);
});

test('recording finishes before the sixty-second server limit, leaving encoding headroom', async () => {
  const h = harness({ getConfig: () => ({ configured: true, speech: { provider: 'current', configured: true } }) });
  await h.controller.start();
  h.recorders[0].chunk();
  const deadline = [...h.timers.values()].find(({ ms }) => ms === 59_000);
  assert.ok(deadline);
  deadline.fn();
  await tick();
  assert.deepEqual(h.events.texts, ['Fly to London']);
});

test('destroy blocks new starts and cleans active capture', async () => {
  const h = harness();
  await h.controller.start();
  h.controller.destroy();
  await h.controller.start();
  assert.equal(h.recognizers.length, 1);
  assert.equal(h.recognizers[0].aborts, 1);
  assert.equal(h.controller.isActive(), false);
});

test('unconfigured LLM and transcription providers fail without requesting microphone access', async () => {
  for (const [config, code] of [
    [{ configured: false }, 'VOICE_LLM_NOT_CONFIGURED'],
    [{ configured: true, speech: { provider: 'current', configured: false } }, 'STT_NOT_CONFIGURED'],
    [{ configured: true, speech: { provider: 'realtime', configured: true } }, 'STT_UNSUPPORTED_PROVIDER'],
  ]) {
    const h = harness({ getConfig: () => config });
    await h.controller.start();
    assert.deepEqual(h.events.errors, [code]);
    assert.equal(h.recognizers.length + h.recorders.length, 0);
  }
});

test('microphone capture reports unsupported, permission denied, and missing input errors', async () => {
  for (const [mediaDevices, code] of [
    [null, 'VOICE_CAPTURE_UNSUPPORTED'],
    [{ getUserMedia: async () => { throw { name: 'NotAllowedError' }; } }, 'VOICE_PERMISSION'],
    [{ getUserMedia: async () => { throw { name: 'NotFoundError' }; } }, 'VOICE_NO_MICROPHONE'],
  ]) {
    const h = harness({
      getConfig: () => ({ configured: true, speech: { provider: 'current', configured: true } }),
      mediaDevices,
    });
    await h.controller.start();
    assert.deepEqual(h.events.errors, [code]);
    assert.equal(h.controller.isActive(), false);
  }
});

test('configuration fetch errors are sanitized without reflecting arbitrary server strings', async () => {
  const h = harness({ getConfig: async () => { throw new Error('private upstream detail'); } });
  await h.controller.start();
  assert.deepEqual(h.events.errors, ['VOICE_NETWORK']);
});

test('stop during pending configuration prevents late recognition startup', async () => {
  const config = deferred();
  const h = harness({ getConfig: () => config.promise });
  const started = h.controller.start();
  h.controller.stop();
  config.resolve({ configured: true });
  await started;
  assert.equal(h.recognizers.length, 0);
  assert.equal(h.timers.size, 0);
});

test('second start cannot create concurrent recognition, while a cancelled session cannot affect a new one', async () => {
  const h = harness();
  await h.controller.start();
  const lateResult = h.recognizers[0].onresult;
  const lateStart = h.recognizers[0].onstart;
  const lateError = h.recognizers[0].onerror;
  await h.controller.start();
  assert.equal(h.recognizers.length, 1);
  h.controller.stop();
  await h.controller.start();
  lateResult({ results: [] });
  lateStart();
  lateError({ error: 'network' });
  assert.equal(h.events.errors.length, 0);
  assert.equal(h.controller.isActive(), true);
  h.controller.stop();
});

test('explicit finish allows a late final result before end, and has a bounded end-event fallback', async () => {
  const h = harness();
  await h.controller.start();
  h.recognizers[0].stop = () => {};
  h.controller.finish();
  h.recognizers[0].result('final after release');
  [...h.timers.values()].find(({ ms }) => ms === 3_000).fn();
  await tick();
  assert.deepEqual(h.events.texts, ['final after release']);
});

test('recognition start and stop failures become capture errors', async () => {
  class BadRecognition { start() { throw new Error('unsupported'); } abort() {} }
  const bad = harness({ Recognition: BadRecognition });
  await bad.controller.start();
  assert.deepEqual(bad.events.errors, ['VOICE_CAPTURE_ERROR']);
  const h = harness();
  await h.controller.start();
  h.recognizers[0].stop = () => { throw new Error('already stopped'); };
  h.controller.finish();
  assert.deepEqual(h.events.errors, ['VOICE_CAPTURE_ERROR']);
});

test('empty and overlong transcriptions never reach the model', async () => {
  for (const [text, code] of [['', 'VOICE_NO_SPEECH'], ['a'.repeat(8_001), 'VOICE_TRANSCRIPT_TOO_LONG']]) {
    const h = harness();
    await h.controller.start();
    h.recognizers[0].result(text);
    h.recognizers[0].onend();
    await tick();
    assert.deepEqual(h.events.errors, [code]);
    assert.deepEqual(h.events.texts, []);
  }
});

test('text answers remain usable when playback is unavailable or explicitly disabled', async () => {
  for (const options of [{ speechSynthesis: null }, { Utterance: null }, { speakResponses: false }, { sendText: async () => '' }]) {
    const h = harness(options);
    await h.controller.start();
    h.recognizers[0].result('Go');
    h.recognizers[0].onend();
    await tick();
    assert.equal(h.events.speech.length, 0);
    assert.equal(h.controller.isActive(), false);
    assert.deepEqual(h.events.errors, []);
  }
});

test('model errors keep their safe code, and unknown errors use a generic model error', async () => {
  for (const [error, code] of [[{ code: 'LLM_RATE_LIMITED' }, 'LLM_RATE_LIMITED'], [new Error('sensitive'), 'VOICE_MODEL_ERROR']]) {
    const h = harness({ sendText: async () => { throw error; } });
    await h.controller.start();
    h.recognizers[0].result('Go');
    h.recognizers[0].onend();
    await tick();
    assert.deepEqual(h.events.errors, [code]);
    assert.equal(h.timers.size, 0);
  }
});

test('model timeout cancels the pending map conversation and suppresses its late answer', async () => {
  const answer = deferred();
  const h = harness({ sendText: () => answer.promise });
  await h.controller.start();
  h.recognizers[0].result('Go');
  h.recognizers[0].onend();
  [...h.timers.values()].find(({ ms }) => ms === 180_000).fn();
  answer.resolve('Too late');
  await tick();
  assert.equal(h.events.cancels, 1);
  assert.deepEqual(h.events.errors, ['VOICE_TIMEOUT']);
  assert.equal(h.events.speech.length, 0);
});

test('user confirmation pauses the model deadline and resumes it only after a decision', async () => {
  const answer = deferred();
  const h = harness({ sendText: () => answer.promise });
  await h.controller.start();
  h.recognizers[0].result('Change the style');
  h.recognizers[0].onend();
  h.controller.setAwaitingConfirmation(true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.events.states.at(-1)[0], 'confirming');
  h.controller.setAwaitingConfirmation(false);
  assert.ok([...h.timers.values()].some(({ ms }) => ms === 180_000));
  answer.resolve('Done');
  await tick();
  assert.equal(h.controller.isActive(), false);
});

test('speech synthesis failures and a missing end event cannot leave the microphone active', async () => {
  for (const behavior of ['throw', 'error', 'hang']) {
    const h = harness({ speechSynthesis: {
      cancel() {},
      speak(utterance) {
        if (behavior === 'throw') throw new Error('failed');
        if (behavior === 'error') utterance.onerror();
      },
    } });
    await h.controller.start();
    h.recognizers[0].result('Go');
    h.recognizers[0].onend();
    await tick();
    if (behavior === 'hang') [...h.timers.values()].find(({ ms }) => ms === 60_000).fn();
    assert.equal(h.controller.isActive(), false);
    assert.deepEqual(h.events.errors, behavior === 'hang' ? [] : ['VOICE_PLAYBACK_ERROR']);
  }
});

test('an empty recording does not upload, and zero-sized data chunks are ignored', async () => {
  const h = harness({ getConfig: () => ({ configured: true, speech: { provider: 'current', configured: true } }) });
  await h.controller.start();
  h.recorders[0].chunk('');
  h.controller.finish();
  await tick();
  assert.deepEqual(h.events.errors, ['VOICE_NO_SPEECH']);
  assert.equal(h.events.fetches.length, 0);
});

test('transcription errors preserve approved backend codes and reject invalid results', async () => {
  for (const [response, code] of [
    [{ ok: false, json: async () => ({ code: 'STT_NOT_CONFIGURED' }) }, 'STT_NOT_CONFIGURED'],
    [{ ok: false, json: async () => ({ error: { code: 'STT_UNSUPPORTED_PROVIDER' } }) }, 'STT_UNSUPPORTED_PROVIDER'],
    [{ ok: false, json: async () => ({ error: 'private details' }) }, 'STT_UPSTREAM_ERROR'],
    [{ ok: true, json: async () => ({ text: null }) }, 'VOICE_NO_SPEECH'],
    [{ ok: true, json: async () => { throw new Error('invalid JSON'); } }, 'VOICE_NETWORK'],
  ]) {
    const h = harness({
      getConfig: () => ({ configured: true, speech: { provider: 'custom', configured: true } }),
      fetchImpl: async () => response,
    });
    await h.controller.start();
    h.recorders[0].chunk();
    h.controller.finish();
    await tick();
    assert.deepEqual(h.events.errors, [code]);
    assert.equal(h.controller.isActive(), false);
  }
});

test('transcription timeout aborts its upload', async () => {
  const response = deferred();
  const h = harness({
    getConfig: () => ({ configured: true, speech: { provider: 'custom', configured: true } }),
    fetchImpl: async (url, options) => { h.events.fetches.push({ url, options }); return response.promise; },
  });
  await h.controller.start();
  h.recorders[0].chunk();
  h.controller.finish();
  await tick();
  [...h.timers.values()].find(({ ms }) => ms === 50_000).fn();
  assert.equal(h.events.fetches[0].options.signal.aborted, true);
  assert.deepEqual(h.events.errors, ['VOICE_TIMEOUT']);
  response.reject(new Error('aborted'));
  await tick();
  assert.equal(h.events.errors.length, 1);
});

test('voiceprint gating errors retain their actionable code and never submit text to the model', async () => {
  for (const code of ['VOICEPRINT_NOT_ENROLLED', 'VOICEPRINT_REJECTED', 'VOICEPRINT_UNAVAILABLE', 'VOICEPRINT_BUSY', 'VOICEPRINT_STORAGE_ERROR']) {
    const h = harness({
      getConfig: () => ({ configured: true, speech: { provider: 'custom', configured: true } }),
      fetchImpl: async () => ({ ok: false, json: async () => ({ error: { code } }) }),
    });
    await h.controller.start();
    h.recorders[0].chunk();
    h.controller.finish();
    await tick();
    assert.deepEqual(h.events.errors, [code]);
    assert.deepEqual(h.events.texts, []);
    assert.equal(h.controller.isActive(), false);
  }
});

test('permission timeout closes a stream that eventually arrives', async () => {
  const permission = deferred();
  const h = harness({
    getConfig: () => ({ configured: true, speech: { provider: 'current', configured: true } }),
    mediaDevices: { getUserMedia: () => permission.promise },
  });
  const started = h.controller.start();
  await tick();
  [...h.timers.values()].find(({ ms }) => ms === 30_000).fn();
  permission.resolve(h.stream);
  await started;
  assert.equal(h.tracks[0].stops, 1);
  assert.deepEqual(h.events.errors, ['VOICE_TIMEOUT']);
});

test('recorder startup and capture event errors close the physical microphone', async () => {
  class BrokenRecorder { constructor() { throw new Error('failed'); } }
  const broken = harness({
    getConfig: () => ({ configured: true, speech: { provider: 'current', configured: true } }),
    MediaRecorder: BrokenRecorder,
  });
  await broken.controller.start();
  assert.equal(broken.tracks[0].stops, 1);
  assert.deepEqual(broken.events.errors, ['VOICE_CAPTURE_ERROR']);
  const h = harness({ getConfig: () => ({ configured: true, speech: { provider: 'custom', configured: true } }) });
  await h.controller.start();
  h.recorders[0].onerror({ name: 'UnknownError' });
  assert.equal(h.tracks[0].stops, 1);
  assert.deepEqual(h.events.errors, ['VOICE_CAPTURE_ERROR']);
});

const localSpeechConfig = () => ({ configured: true, speech: {
  provider: 'custom', configured: true, baseUrl: 'http://127.0.0.1:8765/v1', model: 'local-whisper-base',
} });
const previewTimer = (h) => [...h.timers.values()].find(({ ms }) => ms === 6_500);

test('browser interim drafts and final speech are Simplified Chinese without early submission', async () => {
  const drafts = [];
  const h = harness({ onTranscript: (text, detail) => drafts.push([text, detail]) });
  await h.controller.start();
  h.recognizers[0].result('\u8acb\u554f\u4f60\u80fd\u5e79\u4ec0\u9ebc\u5de5\u4f5c', false);
  assert.deepEqual(drafts.at(-1), ['\u8bf7\u95ee\u4f60\u80fd\u5e72\u4ec0\u4e48\u5de5\u4f5c', { final: false }]);
  assert.deepEqual(h.events.texts, []);
  h.recognizers[0].result('\u958b\u555f\u5730\u5716');
  h.recognizers[0].onend();
  await tick();
  assert.deepEqual(h.events.texts, ['\u5f00\u542f\u5730\u56fe']);
  assert.deepEqual(drafts.at(-1), ['\u5f00\u542f\u5730\u56fe', { final: true }]);
});

test('local recording previews cumulative audio sequentially and submits only the complete final transcript', async () => {
  const drafts = [];
  const pending = deferred();
  const h = harness({ getConfig: localSpeechConfig, onTranscript: (text, detail) => drafts.push([text, detail]),
    fetchImpl: async (url, options) => {
      h.events.fetches.push({ url, options });
      return h.events.fetches.length === 1 ? pending.promise : { ok: true, json: async () => ({ text: '\u958b\u555f\u5730\u5716' }) };
    },
  });
  await h.controller.start();
  h.recorders[0].chunk('webm-header+first-audio');
  assert.ok(previewTimer(h), 'a bounded preview timer exists');
  previewTimer(h).fn();
  await tick();
  assert.equal(h.events.fetches.length, 1);
  assert.equal(previewTimer(h), undefined, 'no timer queues concurrent requests');
  assert.deepEqual(h.events.texts, []);
  h.recorders[0].chunk('+last-audio');
  h.controller.finish();
  await tick();
  assert.equal(h.tracks[0].stops, 1, 'microphone releases while the final request is queued');
  assert.equal(h.events.fetches.length, 1, 'final waits for the existing ASR request');
  pending.resolve({ ok: true, json: async () => ({ text: '\u958b\u555f' }) });
  await tick();
  await tick();
  assert.equal(h.events.fetches.length, 2);
  const full = JSON.parse(h.events.fetches[1].options.body);
  assert.equal(Buffer.from(full.audio, 'base64').toString(), 'webm-header+first-audio+last-audio');
  assert.deepEqual(h.events.texts, ['\u5f00\u542f\u5730\u56fe']);
  assert.deepEqual(drafts.at(-1), ['\u5f00\u542f\u5730\u56fe', { final: true }]);
  assert.equal(h.timers.size, 0);
});

test('local draft updates are simplified, deduplicated, bounded and never call the model', async () => {
  const drafts = [];
  const h = harness({ getConfig: localSpeechConfig, onTranscript: (text, detail) => drafts.push([text, detail]),
    fetchImpl: async (url, options) => {
      h.events.fetches.push({ url, options });
      return { ok: true, json: async () => ({ text: '\u5730\u5716' }) };
    },
  });
  await h.controller.start();
  for (let index = 0; index < 8; index += 1) {
    h.recorders[0].chunk(`audio-${index}`);
    assert.ok(previewTimer(h));
    previewTimer(h).fn();
    await tick();
  }
  assert.equal(previewTimer(h), undefined, 'preview budget leaves room for final recognition');
  assert.deepEqual(drafts, [['\u5730\u56fe', { final: false }]]);
  assert.deepEqual(h.events.texts, []);
  h.controller.stop();
  assert.equal(h.timers.size, 0);
});

test('remote or unsupported media formats never automatically upload partial recordings', async () => {
  for (const baseUrl of ['https://speech.example/v1', 'http://127.0.0.1.evil.example/v1', 'invalid-url']) {
    const h = harness({ getConfig: () => ({ ...localSpeechConfig(), speech: { ...localSpeechConfig().speech, baseUrl } }) });
    await h.controller.start();
    h.recorders[0].chunk();
    assert.equal(previewTimer(h), undefined);
    h.controller.stop();
  }
  class Mp4Recorder {
    constructor() { this.mimeType = 'audio/mp4'; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  }
  const mp4 = harness({ getConfig: localSpeechConfig, MediaRecorder: Mp4Recorder });
  await mp4.controller.start();
  assert.equal(previewTimer(mp4), undefined, 'MP4 may require a finalized container index');
  mp4.controller.stop();
});

test('cancelled partial transcription cannot update drafts or submit late text', async () => {
  const response = deferred();
  const drafts = [];
  const h = harness({ getConfig: localSpeechConfig, onTranscript: (text, detail) => drafts.push([text, detail]),
    fetchImpl: async (url, options) => { h.events.fetches.push({ url, options }); return response.promise; },
  });
  await h.controller.start();
  h.recorders[0].chunk();
  assert.ok(previewTimer(h));
  previewTimer(h).fn();
  await tick();
  h.controller.stop();
  assert.equal(h.events.fetches[0].options.signal.aborted, true);
  assert.equal(h.timers.size, 0, 'cancellation clears the preview deadline immediately');
  response.resolve({ ok: true, json: async () => ({ text: 'late' }) });
  await tick();
  assert.deepEqual(drafts, []);
  assert.deepEqual(h.events.texts, []);
  assert.equal(h.timers.size, 0);
});

test('actual assistant reply chunks are spoken sentence by sentence before model completion, without repeats', async () => {
  const answer = deferred();
  const h = harness({ sendText: () => answer.promise });
  await h.controller.start();
  h.recognizers[0].result('Go');
  h.recognizers[0].onend();
  assert.equal(typeof h.controller.receiveReply, 'function');
  h.controller.receiveReply({ id: 'reply1', content: '\u6b63\u5728\u6574\u7406', streaming: true });
  assert.equal(h.events.speech.length, 0);
  h.controller.receiveReply({ id: 'reply1', content: '\u6b63\u5728\u6574\u7406\u3002', streaming: true });
  assert.equal(h.events.speech[0].text, '\u6b63\u5728\u6574\u7406\u3002');
  assert.equal(h.controller.isActive(), true);
  h.controller.receiveReply({ id: 'reply1', content: '\u6b63\u5728\u6574\u7406\u3002\u5730\u5716\u5df2\u958b\u555f\u3002', streaming: true });
  h.controller.receiveReply({ id: 'reply1', content: '\u6b63\u5728\u6574\u7406\u3002\u5730\u5716\u5df2\u958b\u555f\u3002', streaming: false });
  answer.resolve('\u6b63\u5728\u6574\u7406\u3002\u5730\u56fe\u5df2\u5f00\u542f\u3002');
  await tick();
  assert.deepEqual(h.events.speech.map((item) => item.text), ['\u6b63\u5728\u6574\u7406\u3002', '\u5730\u56fe\u5df2\u5f00\u542f\u3002']);
  assert.equal(h.controller.isActive(), false);
  assert.equal(h.timers.size, 0);
});

test('streaming speech queues playback and cancellation discards queued or late replies', async () => {
  const answer = deferred();
  const h = harness({ sendText: () => answer.promise, speechSynthesis: {
    cancel() {}, speak(utterance) { h.events.speech.push(utterance); },
  } });
  await h.controller.start();
  h.recognizers[0].result('Go');
  h.recognizers[0].onend();
  assert.equal(typeof h.controller.receiveReply, 'function');
  h.controller.receiveReply({ id: 'reply1', content: 'First sentence. Second sentence.', streaming: true });
  assert.equal(h.events.speech.length, 1);
  assert.equal(h.events.speech[0].text, 'First sentence.');
  h.controller.receiveReply({ id: 'reply1', content: 'First sentence. Second sentence.', streaming: false });
  h.events.speech[0].onend();
  assert.equal(h.events.speech[1].text, 'Second sentence.');
  const lateEnd = h.events.speech[1].onend;
  h.controller.stop();
  lateEnd();
  h.controller.receiveReply({ id: 'reply1', content: 'First sentence. Second sentence. Late sentence.', streaming: false });
  answer.resolve('late answer');
  await tick();
  assert.equal(h.events.speech.length, 2);
  assert.equal(h.timers.size, 0);
});

test('streamed terminal ASCII periods wait for decimal continuation or final completion before playback', async () => {
  const answer = deferred();
  const h = harness({ sendText: () => answer.promise });
  await h.controller.start();
  h.recognizers[0].result('Go');
  h.recognizers[0].onend();
  h.controller.receiveReply({ id: 'reply1', content: 'Altitude is 10.', streaming: true });
  assert.equal(h.events.speech.length, 0, 'a streamed trailing period may begin a decimal');
  h.controller.receiveReply({ id: 'reply1', content: 'Altitude is 10.5 km.', streaming: true });
  assert.equal(h.events.speech.length, 0, 'the final ASCII period is still unconfirmed');
  h.controller.receiveReply({ id: 'reply1', content: 'Altitude is 10.5 km. Map ready.', streaming: true });
  assert.deepEqual(h.events.speech.map((item) => item.text), ['Altitude is 10.5 km.']);
  h.controller.receiveReply({ id: 'reply1', content: 'Altitude is 10.5 km. Map ready.', streaming: false });
  answer.resolve('Altitude is 10.5 km. Map ready.');
  await tick();
  assert.deepEqual(h.events.speech.map((item) => item.text), ['Altitude is 10.5 km.', 'Map ready.']);
  assert.equal(h.controller.isActive(), false);
});

test('streaming playback retains decimals and resumes the model deadline after confirmation during speech', async () => {
  const answer = deferred();
  const h = harness({ sendText: () => answer.promise, speechSynthesis: {
    cancel() {}, speak(utterance) { h.events.speech.push(utterance); },
  } });
  await h.controller.start();
  h.recognizers[0].result('Go');
  h.recognizers[0].onend();
  h.controller.setAwaitingConfirmation(true);
  h.controller.receiveReply({ id: 'reply1', content: 'Altitude is 10.5 km. Confirm?', streaming: true });
  assert.equal(h.events.speech[0].text, 'Altitude is 10.5 km.');
  assert.equal([...h.timers.values()].some(({ ms }) => ms === 180_000), false);
  h.controller.setAwaitingConfirmation(false);
  assert.equal([...h.timers.values()].some(({ ms }) => ms === 180_000), true);
  h.controller.stop();
  answer.resolve('Done');
  await tick();
});

async function pendingPlaybackHarness(overrides = {}) {
  const answer = deferred();
  let playbackCancels = 0;
  const h = harness({ sendText: () => answer.promise, speechSynthesis: {
    cancel() { playbackCancels += 1; }, speak(utterance) { h.events.speech.push(utterance); },
  }, ...overrides });
  await h.controller.start();
  h.recognizers[0].result('Go');
  h.recognizers[0].onend();
  return { ...h, answer, playbackCancels: () => playbackCancels };
}

test('playback mute immediately cancels speech and its queue without cancelling the map conversation', async () => {
  const h = await pendingPlaybackHarness();
  h.controller.receiveReply({ id: 'reply1', content: 'First! Queued!', streaming: true });
  const staleEnd = h.events.speech[0].onend;
  const staleError = h.events.speech[0].onerror;
  const staleTimeout = [...h.timers.values()].find(({ ms }) => ms === 60_000).fn;
  h.controller.setAwaitingConfirmation(true);
  h.controller.setPlaybackEnabled(false);
  assert.equal(h.playbackCancels(), 1);
  assert.equal(h.events.cancels, 0);
  assert.equal(h.events.states.at(-1)[0], 'confirming');
  assert.equal(h.controller.isActive(), true);
  assert.equal(h.timers.size, 0, 'playback timer is cleared while confirmation owns the model timeout');
  staleEnd();
  staleError();
  staleTimeout();
  assert.equal(h.controller.isActive(), true, 'callbacks captured before mute cannot close the model conversation');
  assert.equal(h.events.speech.length, 1);
  h.controller.setAwaitingConfirmation(false);
  h.answer.resolve('Done');
  await tick();
  assert.equal(h.controller.isActive(), false);
  assert.equal(h.events.cancels, 0);
  assert.equal(h.timers.size, 0);
});

test('unmuting resumes only new reply text and never replays buffered or muted content', async () => {
  const h = await pendingPlaybackHarness();
  h.controller.receiveReply({ id: 'reply1', content: 'First! Queued! Draft', streaming: true });
  const staleEnd = h.events.speech[0].onend;
  h.controller.setPlaybackEnabled(false);
  h.controller.receiveReply({ id: 'reply1', content: 'First! Queued! Draft continued!', streaming: true });
  h.controller.receiveReply({ id: 'reply2', content: 'Entirely muted.', streaming: false });
  h.controller.setPlaybackEnabled(true);
  assert.equal(h.events.speech.length, 1);
  h.controller.receiveReply({ id: 'reply1', content: 'First! Queued! Draft continued! New!', streaming: true });
  assert.deepEqual(h.events.speech.map(({ text }) => text), ['First!', 'New!']);
  staleEnd();
  assert.equal(h.events.states.at(-1)[0], 'speaking', 'old callbacks cannot advance the new utterance');
  h.controller.receiveReply({ id: 'reply1', content: 'First! Queued! Draft continued! New!', streaming: false });
  h.answer.resolve('First! Queued! Draft continued! New!');
  await tick();
  h.events.speech[1].onend();
  assert.equal(h.controller.isActive(), false);
  assert.equal(h.events.speech.length, 2);
});

test('muting skips an already received incomplete sentence even when unmuted before its next chunk', async () => {
  const h = await pendingPlaybackHarness();
  h.controller.receiveReply({ id: 'reply1', content: 'Old partial', streaming: true });
  h.controller.setPlaybackEnabled(false);
  h.controller.setPlaybackEnabled(true);
  h.controller.receiveReply({ id: 'reply1', content: 'Old partial New!', streaming: false });
  assert.deepEqual(h.events.speech.map(({ text }) => text), ['New!']);
  h.controller.stop();
  h.answer.resolve('Old partial New!');
  await tick();
});

test('playback preference persists across voice turns and does not stop microphone capture', async () => {
  const h = harness();
  h.controller.setPlaybackEnabled(false);
  for (let index = 0; index < 2; index += 1) {
    await h.controller.start();
    h.controller.setPlaybackEnabled(false);
    assert.equal(h.recognizers[index].aborts, 0);
    assert.equal(h.events.states.at(-1)[0], 'listening');
    h.recognizers[index].result('Go');
    h.recognizers[index].onend();
    await tick();
    assert.equal(h.events.speech.length, 0);
    assert.equal(h.events.cancels, 0);
  }
  h.controller.setPlaybackEnabled(true);
  await h.controller.start();
  h.recognizers[2].result('Go');
  h.recognizers[2].onend();
  await tick();
  assert.deepEqual(h.events.speech.map(({ text }) => text), ['Done']);
  assert.equal(h.timers.size, 0);
});

test('playback can be enabled after initially disabled and muted after model completion', async () => {
  const h = await pendingPlaybackHarness({ speakResponses: false });
  h.controller.setPlaybackEnabled(true);
  h.answer.resolve('Completed answer');
  await tick();
  assert.equal(h.events.speech[0].text, 'Completed answer');
  h.controller.setPlaybackEnabled(false);
  assert.equal(h.playbackCancels(), 1);
  assert.equal(h.controller.isActive(), false);
  assert.equal(h.events.cancels, 0);
  assert.equal(h.timers.size, 0);
  h.controller.destroy();
  h.controller.setPlaybackEnabled(true);
  await h.controller.start();
  assert.equal(h.controller.isActive(), false);
});

test('streaming markdown is spoken without asterisks and does not disturb raw reply offsets', async () => {
  const answer = deferred();
  const h = harness({ sendText: () => answer.promise });
  await h.controller.start();
  h.recognizers[0].result('Go');
  h.recognizers[0].onend();
  for (const content of ['**First!**', '**First!** **Second!**', '**First!** **Second!** Tail']) {
    h.controller.receiveReply({ id: 'reply1', content, streaming: true });
  }
  h.controller.receiveReply({ id: 'reply1', content: '**First!** **Second!** Tail', streaming: false });
  answer.resolve('**First!** **Second!** Tail');
  await tick();
  assert.deepEqual(h.events.speech.map(({ text }) => text), ['First!', 'Second!', 'Tail']);
  assert.equal(h.timers.size, 0);
});

test('silent partial recognition retries while an unavailable preview falls back to the complete recording', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const code of ['STT_NO_SPEECH', 'STT_UPSTREAM_ERROR', 'STT_RATE_LIMITED']) {
    const h = harness({ getConfig: localSpeechConfig,
      fetchImpl: async (url, options) => {
        h.events.fetches.push({ url, options });
        return h.events.fetches.length === 1
          ? { ok: false, json: async () => ({ code }) }
          : { ok: true, json: async () => ({ text: 'Final transcript' }) };
      },
    });
    await h.controller.start();
    h.recorders[0].chunk();
    previewTimer(h).fn();
    await tick();
    assert.equal(Boolean(previewTimer(h)), code === 'STT_NO_SPEECH');
    assert.equal(h.controller.isActive(), true);
    assert.deepEqual(h.events.errors, []);
    h.controller.finish();
    await tick();
    assert.deepEqual(h.events.texts, ['Final transcript']);
  }
});

test('preview upload timeout aborts the request and leaves final transcription available', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const response = deferred();
  const h = harness({ getConfig: localSpeechConfig,
    fetchImpl: async (url, options) => {
      h.events.fetches.push({ url, options });
      return h.events.fetches.length === 1 ? response.promise : { ok: true, json: async () => ({ text: 'Final' }) };
    },
  });
  await h.controller.start();
  h.recorders[0].chunk();
  previewTimer(h).fn();
  await tick();
  [...h.timers.values()].find(({ ms }) => ms === 50_000).fn();
  await tick();
  assert.equal(h.events.fetches[0].options.signal.aborted, true);
  assert.equal(previewTimer(h), undefined);
  h.controller.finish();
  await tick();
  assert.deepEqual(h.events.texts, ['Final']);
  response.resolve({ ok: true, json: async () => ({ text: 'Late partial' }) });
  await tick();
  assert.deepEqual(h.events.texts, ['Final']);
});

test('preview polling skips empty or unchanged media and preserves its rolling minute budget across turns', async () => {
  let clock = 0;
  const h = harness({ getConfig: localSpeechConfig, now: () => clock });
  await h.controller.start();
  previewTimer(h).fn();
  await tick();
  assert.equal(h.events.fetches.length, 0);
  for (let index = 0; index < 8; index += 1) {
    h.recorders[0].chunk(String(index));
    previewTimer(h).fn();
    await tick();
    if (index === 0) {
      previewTimer(h).fn();
      await tick();
      assert.equal(h.events.fetches.length, 1);
    }
  }
  h.controller.stop();
  await h.controller.start();
  h.recorders[1].chunk();
  previewTimer(h).fn();
  await tick();
  assert.equal(h.events.fetches.length, 8);
  clock = 60_001;
  previewTimer(h).fn();
  await tick();
  assert.equal(h.events.fetches.length, 9);
  h.controller.stop();
});

test('reply playback ignores incomplete or idle updates and never exceeds its per-turn speech budget', async () => {
  const answer = deferred();
  const h = harness({ sendText: () => answer.promise });
  h.controller.receiveReply({ id: 'idle', content: 'Must not speak.', streaming: false });
  await h.controller.start();
  h.recognizers[0].result('Go');
  h.recognizers[0].onend();
  h.controller.receiveReply({ id: 'bad', content: 'Failed response.', streaming: false, incomplete: true });
  assert.equal(h.events.speech.length, 0);
  h.controller.receiveReply({ id: 'long', content: 'a'.repeat(4_100) + '.', streaming: true });
  h.controller.receiveReply({ id: 'long', content: 'a'.repeat(4_100) + '. Extra.', streaming: false });
  answer.resolve('a'.repeat(4_100) + '. Extra.');
  await tick();
  assert.equal(h.events.speech.reduce((total, utterance) => total + utterance.text.length, 0), 4_000);
  assert.equal(h.controller.isActive(), false);
});
