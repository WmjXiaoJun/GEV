import test from 'node:test';
import assert from 'node:assert/strict';
import { publicSpeechConfig, resolveSpeechConfig } from './speechConfig.mjs';
import { MAX_SPEECH_AUDIO_BYTES, SPEECH_TIMEOUT_MS, requestSpeechTranscription, validateSpeechInput } from './speech.mjs';

const customEnv = { GEV_STT_PROVIDER: 'custom', GEV_STT_BASE_URL: 'https://speech.example/v1', GEV_STT_API_KEY: 'speech-only-secret' };
const input = { audio: Buffer.from('small-audio').toString('base64'), mimeType: 'audio/webm;codecs=opus', locale: 'zh-CN' };

test('browser speech is the default and does not inherit any AI credentials', () => {
  assert.deepEqual(publicSpeechConfig({ OPENAI_API_KEY: 'private', GEV_STT_API_KEY: 'unused' }), {
    provider: 'browser', model: 'whisper-1', baseUrl: '', configured: true, keyConfigured: false,
    custom: { model: 'whisper-1', baseUrl: '', keyConfigured: true, configured: false },
  });
});

test('public custom speech settings survive every active mode without inheriting current credentials', () => {
  const env = { ...customEnv, GEV_STT_MODEL: 'faster-whisper-large-v3',
    GEV_LLM_PROVIDER: 'custom', GEV_LLM_BASE_URL: 'https://chat.example/v1',
    GEV_LLM_API_KEY: 'chat-only-secret', OPENAI_API_KEY: 'realtime-only-secret',
  };
  for (const provider of ['browser', 'current', 'custom', 'realtime']) {
    const publicConfig = publicSpeechConfig({ ...env, GEV_STT_PROVIDER: provider });
    assert.deepEqual(publicConfig.custom, {
      model: 'faster-whisper-large-v3', baseUrl: 'https://speech.example/v1',
      keyConfigured: true, configured: true,
    });
    assert.equal(JSON.stringify(publicConfig).includes('secret'), false);
    assert.equal(Object.hasOwn(publicConfig.custom, 'apiKey'), false);
  }
  const current = publicSpeechConfig({ ...env, GEV_STT_PROVIDER: 'current', GEV_STT_API_KEY: '' });
  assert.equal(current.keyConfigured, true);
  assert.equal(current.custom.keyConfigured, false);
  assert.equal(current.custom.configured, false);
});

test('custom speech metadata reports absent and anonymous loopback configuration accurately', () => {
  assert.deepEqual(publicSpeechConfig({}).custom, {
    model: 'whisper-1', baseUrl: '', keyConfigured: false, configured: false,
  });
  assert.deepEqual(publicSpeechConfig({ GEV_STT_BASE_URL: 'http://localhost:9000/v1' }).custom, {
    model: 'whisper-1', baseUrl: 'http://localhost:9000/v1', keyConfigured: false, configured: true,
  });
});

test('invalid inactive custom speech settings are sanitized without disabling browser or realtime', () => {
  for (const provider of ['browser', 'realtime']) {
    for (const invalidSetting of [
      { GEV_STT_BASE_URL: 'http://remote.example/v1' },
      { GEV_STT_BASE_URL: 'https://speech.example/v1?key=private' },
      { GEV_STT_API_KEY: 'bad\nkey' },
    ]) {
      const publicConfig = publicSpeechConfig({ ...customEnv, GEV_STT_PROVIDER: provider,
        OPENAI_API_KEY: 'realtime-secret', ...invalidSetting,
      });
      assert.equal(publicConfig.provider, provider);
      assert.equal(publicConfig.configured, true);
      assert.deepEqual(publicConfig.custom, { model: '', baseUrl: '', keyConfigured: false, configured: false });
      assert.equal(JSON.stringify(publicConfig).includes('private'), false);
      assert.equal(JSON.stringify(publicConfig).includes('secret'), false);
    }
  }
  assert.throws(() => publicSpeechConfig({ ...customEnv, GEV_STT_BASE_URL: 'http://remote.example/v1' }), { code: 'STT_INVALID_CONFIG' });
});

test('legacy realtime mode remains explicit and cannot use the transcription endpoint', async () => {
  assert.equal(publicSpeechConfig({ GEV_STT_PROVIDER: 'realtime' }).configured, false);
  const config = resolveSpeechConfig({ GEV_STT_PROVIDER: 'realtime', OPENAI_API_KEY: 'realtime-secret' });
  assert.equal(config.configured, true);
  assert.equal(config.apiKey, '');
  assert.equal(publicSpeechConfig({ GEV_STT_PROVIDER: 'realtime', OPENAI_API_KEY: 'key' }).keyConfigured, true);
  await assert.rejects(requestSpeechTranscription({ config, input }), { code: 'STT_NOT_CONFIGURED' });
});

test('current speech explicitly reuses compatible endpoint credentials but not the chat model', () => {
  const config = resolveSpeechConfig({ GEV_STT_PROVIDER: 'current', GEV_LLM_PROVIDER: 'custom',
    GEV_LLM_BASE_URL: 'https://proxy.example/v1', GEV_LLM_MODEL: 'gpt-5.6-sol', GEV_LLM_API_KEY: 'chat-key', GEV_STT_API_KEY: 'wrong-key',
  });
  assert.equal(config.apiKey, 'chat-key');
  assert.equal(config.baseUrl, 'https://proxy.example/v1');
  assert.equal(config.model, 'whisper-1');
  assert.equal(config.configured, true);
  assert.equal(resolveSpeechConfig({ GEV_STT_PROVIDER: 'current', OPENAI_API_KEY: 'key' }).configured, true);
  for (const provider of ['deepseek', 'qwen', 'moonshot', 'anthropic', 'gemini', 'ollama']) {
    assert.equal(resolveSpeechConfig({ GEV_STT_PROVIDER: 'current', GEV_LLM_PROVIDER: provider }).configured, false);
  }
});

test('custom speech keys are isolated and only loopback permits anonymous ASR', () => {
  const config = resolveSpeechConfig({ ...customEnv, OPENAI_API_KEY: 'wrong', GEV_LLM_API_KEY: 'wrong', GEV_STT_MODEL: 'faster-whisper-large-v3' });
  assert.equal(config.apiKey, 'speech-only-secret');
  assert.equal(config.model, 'faster-whisper-large-v3');
  assert.equal(JSON.stringify(publicSpeechConfig(customEnv)).includes('speech-only-secret'), false);
  assert.equal(resolveSpeechConfig({ ...customEnv, GEV_STT_API_KEY: '', OPENAI_API_KEY: 'wrong' }).configured, false);
  assert.equal(resolveSpeechConfig({ GEV_STT_PROVIDER: 'custom', GEV_STT_BASE_URL: 'http://localhost:9000/v1' }).configured, true);
  for (const env of [
    { GEV_STT_PROVIDER: 'bad' }, { ...customEnv, GEV_STT_BASE_URL: 'http://remote.example/v1' },
    { ...customEnv, GEV_STT_BASE_URL: 'https://user:pass@remote.example/v1' },
    { ...customEnv, GEV_STT_BASE_URL: 'https://remote.example/v1?key=private' },
    { ...customEnv, GEV_STT_MODEL: 'bad\nmodel' }, { ...customEnv, GEV_STT_API_KEY: 'bad\nkey' },
  ]) assert.throws(() => resolveSpeechConfig(env), { code: 'STT_INVALID_CONFIG' });
});

test('audio validation requires bounded canonical base64 and an explicit audio MIME type', () => {
  const parsed = validateSpeechInput(input);
  assert.equal(parsed.audio.toString(), 'small-audio');
  assert.equal(parsed.mimeType, 'audio/webm');
  assert.equal(parsed.language, 'zh');
  for (const data of [null, {}, { ...input, audio: '' }, { ...input, audio: '%%%' },
    { ...input, audio: 'aGk' }, { ...input, audio: 'aGk=\n' }, { ...input, audio: 'aGl=' },
    { ...input, mimeType: 'text/html' }, { ...input, mimeType: 'audio/webm;evil=yes' },
    { ...input, locale: 'invalid-language' }, { ...input, apiKey: 'injected' },
  ]) assert.throws(() => validateSpeechInput(data), { code: 'STT_INVALID_REQUEST' });
  assert.throws(() => validateSpeechInput({ ...input, audio: Buffer.alloc(MAX_SPEECH_AUDIO_BYTES + 1).toString('base64') }), { code: 'STT_AUDIO_TOO_LARGE' });
});

test('speech adapter sends bounded multipart transcription with separate ASR model', async () => {
  const result = await requestSpeechTranscription({ config: resolveSpeechConfig(customEnv), input,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://speech.example/v1/audio/transcriptions');
      assert.equal(options.headers.Authorization, 'Bearer speech-only-secret');
      assert.equal(options.headers['Content-Type'], undefined);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.body.get('model'), 'whisper-1');
      assert.equal(options.body.get('language'), 'zh');
      assert.equal(options.body.get('response_format'), 'json');
      assert.equal(options.body.get('file').name, 'recording.webm');
      assert.equal(await options.body.get('file').text(), 'small-audio');
      return new Response(JSON.stringify({ text: ' hello ', internal: 'hidden' }));
    },
  });
  assert.deepEqual(result, { text: 'hello' });
});

test('loopback transcription works without authorization and no locale is invented', async () => {
  const result = await requestSpeechTranscription({ config: resolveSpeechConfig({ GEV_STT_PROVIDER: 'custom', GEV_STT_BASE_URL: 'http://127.0.0.1:9000/v1' }),
    input: { audio: input.audio, mimeType: 'audio/wav' }, fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.body.get('language'), null);
      assert.equal(options.body.get('file').name, 'recording.wav');
      return new Response('{"text":"recognized"}');
    },
  });
  assert.equal(result.text, 'recognized');
});

test('browser mode and unsupported current providers never call transcription APIs', async () => {
  let called = false;
  for (const [env, code] of [[{}, 'STT_NOT_CONFIGURED'], [{ GEV_STT_PROVIDER: 'current', GEV_LLM_PROVIDER: 'deepseek' }, 'STT_UNSUPPORTED_PROVIDER']]) {
    await assert.rejects(requestSpeechTranscription({ config: resolveSpeechConfig(env), input, fetchImpl: async () => { called = true; } }), { code });
  }
  assert.equal(called, false);
});

test('upstream speech failures, redirects and malformed responses never reveal provider details', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('speech-only-secret private backend URL'); },
    async () => new Response('speech-only-secret', { status: 401 }),
    async () => new Response('private audio content'),
    async () => new Response('{"text":null}'),
    async () => new Response('{"text":""}'),
    async () => new Response(JSON.stringify({ text: 'x'.repeat(8001) })),
    async () => new Response('x'.repeat(65537)),
  ]) {
    await assert.rejects(requestSpeechTranscription({ config: resolveSpeechConfig(customEnv), input, fetchImpl }), (error) => {
      assert.ok(error.code.startsWith('STT_'));
      assert.equal(error.message.includes('speech-only-secret'), false);
      assert.equal(error.message.includes('private'), false);
      return true;
    });
  }
});

test('speech HTTP failures have actionable codes without exposing upstream content', async () => {
  for (const [status, code] of [
    [401, 'STT_AUTH_ERROR'], [403, 'STT_AUTH_ERROR'],
    [404, 'STT_ENDPOINT_UNAVAILABLE'], [405, 'STT_ENDPOINT_UNAVAILABLE'],
    [429, 'STT_RATE_LIMITED'], [502, 'STT_SERVICE_UNAVAILABLE'], [503, 'STT_SERVICE_UNAVAILABLE'],
    [504, 'STT_TIMEOUT'],
    [400, 'STT_UPSTREAM_ERROR'], [500, 'STT_UPSTREAM_ERROR'],
  ]) {
    const response = new Response('speech-only-secret private provider response', { status });
    await assert.rejects(requestSpeechTranscription({ config: resolveSpeechConfig(customEnv), input,
      fetchImpl: async () => response,
    }), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.message, 'Speech recognition request failed.');
      return true;
    });
    assert.equal(response.bodyUsed, true);
  }
});

test('speech network errors have a connection code and never expose endpoint details', async () => {
  await assert.rejects(requestSpeechTranscription({ config: resolveSpeechConfig(customEnv), input,
    fetchImpl: async () => { throw new TypeError('fetch failed: private speech-only-secret endpoint'); },
  }), (error) => {
    assert.equal(error.code, 'STT_CONNECTION_ERROR');
    assert.equal(error.message, 'Speech recognition request failed.');
    return true;
  });
});

test('empty speech is distinct from malformed provider responses', async () => {
  for (const text of ['', ' \n\t ']) {
    await assert.rejects(requestSpeechTranscription({ config: resolveSpeechConfig(customEnv), input,
      fetchImpl: async () => new Response(JSON.stringify({ text })),
    }), { code: 'STT_NO_SPEECH' });
  }
  for (const result of [{}, { text: null }, { text: 42 }, { text: 'x'.repeat(8001) }]) {
    await assert.rejects(requestSpeechTranscription({ config: resolveSpeechConfig(customEnv), input,
      fetchImpl: async () => new Response(JSON.stringify(result)),
    }), { code: 'STT_INVALID_RESPONSE' });
  }
});

test('speech request honors cancellation before any network call', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestSpeechTranscription({ config: resolveSpeechConfig(customEnv), input, signal: controller.signal,
    fetchImpl: async () => assert.fail('cancelled request reached provider'),
  }), { code: 'STT_CANCELLED' });
});

test('transcription has a bounded deadline and rejects forged unsafe endpoint configs', async (t) => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (duration) => {
    assert.equal(duration, SPEECH_TIMEOUT_MS);
    return deadline.signal;
  });
  let started;
  const pending = requestSpeechTranscription({ config: resolveSpeechConfig(customEnv), input,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      started = true;
      signal.addEventListener('abort', () => reject(new Error('private failure')), { once: true });
    }),
  });
  assert.equal(started, true);
  deadline.abort();
  await assert.rejects(pending, { code: 'STT_TIMEOUT' });
  for (const config of [
    { ...resolveSpeechConfig(customEnv), baseUrl: 'http://remote.example/v1' },
    { ...resolveSpeechConfig(customEnv), apiKey: 'bad\nkey' },
  ]) await assert.rejects(requestSpeechTranscription({ config, input }), { code: 'STT_INVALID_CONFIG' });
});

test('audio boundary accepts exactly 4 MiB without expensive regular expression recursion', () => {
  const result = validateSpeechInput({ ...input, audio: Buffer.alloc(MAX_SPEECH_AUDIO_BYTES).toString('base64') });
  assert.equal(result.audio.length, MAX_SPEECH_AUDIO_BYTES);
});

test('Chinese transcription is normalized to simplified characters without rewriting English-mode content', async () => {
  for (const [locale, expected] of [['zh-CN', '\u8bf7\u95ee\u4f60\u80fd\u5e72\u4ec0\u4e48'], ['en', '\u8acb\u554f\u4f60\u80fd\u5e79\u4ec0\u9ebc']]) {
    const result = await requestSpeechTranscription({ config: resolveSpeechConfig(customEnv), input: { ...input, locale },
      fetchImpl: async () => new Response(JSON.stringify({ text: '\u8acb\u554f\u4f60\u80fd\u5e79\u4ec0\u9ebc' })),
    });
    assert.equal(result.text, expected);
  }
});
