import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLM_PROVIDERS, resolveLlmConfig, publicLlmConfig } from './providers.js';

test('registry exposes frozen metadata for all supported providers', () => {
  assert.deepEqual(LLM_PROVIDERS.map(({ id }) => id), [
    'openai', 'deepseek', 'qwen', 'moonshot', 'anthropic', 'gemini', 'ollama', 'custom',
  ]);
  assert.ok(Object.isFrozen(LLM_PROVIDERS));
  for (const provider of LLM_PROVIDERS) {
    assert.ok(Object.isFrozen(provider));
    for (const name of ['label', 'defaultModel', 'baseUrl', 'keyEnv', 'modelEnv', 'baseUrlEnv']) {
      assert.equal(typeof provider[name], 'string');
    }
    assert.equal(typeof provider.keyOptional, 'boolean');
  }
});

test('legacy OpenAI key works without any additional configuration', () => {
  const config = resolveLlmConfig({ OPENAI_API_KEY: ' old-key ' });
  assert.equal(config.provider, 'openai');
  assert.equal(config.apiKey, 'old-key');
  assert.equal(config.configured, true);
  assert.equal(resolveLlmConfig({}).configured, false);
});

test('each provider resolves only its own credentials', () => {
  for (const provider of LLM_PROVIDERS.filter(({ id }) => id !== 'custom')) {
    const config = resolveLlmConfig({
      GEV_LLM_PROVIDER: provider.id, [provider.keyEnv]: 'provider-key',
      GEV_LLM_API_KEY: 'custom-secret', OPENAI_API_KEY: 'openai-secret',
    });
    assert.equal(config.apiKey, provider.id === 'openai' ? 'openai-secret' : 'provider-key');
    assert.equal(config.configured, true);
    if (!provider.keyOptional && provider.id !== 'openai') {
      assert.equal(resolveLlmConfig({ GEV_LLM_PROVIDER: provider.id, OPENAI_API_KEY: 'other' }).configured, false);
    }
  }
  assert.equal(resolveLlmConfig({ GEV_LLM_PROVIDER: 'qwen', DASHSCOPE_API_KEY: 'dash-key' }).apiKey, 'dash-key');
});

test('global model and base URL override provider defaults without exposing secrets', () => {
  const env = {
    GEV_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'private-key',
    DEEPSEEK_MODEL: 'provider-model', DEEPSEEK_BASE_URL: 'https://example.com/provider',
    GEV_LLM_MODEL: 'selected-model', GEV_LLM_BASE_URL: 'https://example.com/v1/',
  };
  assert.deepEqual(publicLlmConfig(env), {
    provider: 'deepseek', model: 'selected-model', baseUrl: 'https://example.com/v1', configured: true,
  });
  assert.ok(!JSON.stringify(publicLlmConfig(env)).includes('private-key'));
});

test('custom requires a model, a base URL and its dedicated API key', () => {
  const complete = {
    GEV_LLM_PROVIDER: 'custom', GEV_LLM_API_KEY: 'secret',
    GEV_LLM_MODEL: 'my-model', GEV_LLM_BASE_URL: 'https://example.com/v1',
  };
  assert.equal(resolveLlmConfig(complete).configured, true);
  for (const key of ['GEV_LLM_API_KEY', 'GEV_LLM_MODEL', 'GEV_LLM_BASE_URL']) {
    assert.equal(resolveLlmConfig({ ...complete, [key]: '' }).configured, false, key);
  }
  assert.equal(resolveLlmConfig({ GEV_LLM_PROVIDER: 'ollama' }).configured, true);
});

test('provider model and base URL variables are honored', () => {
  const resolved = resolveLlmConfig({
    GEV_LLM_PROVIDER: 'ollama', OLLAMA_MODEL: 'qwen3:8b', OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1/',
  });
  assert.equal(resolved.model, 'qwen3:8b');
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:11434/v1');
});

test('only HTTPS remote URLs and HTTP loopback URLs may receive credentials', () => {
  for (const baseUrl of ['https://example.com/v1', 'http://localhost:11434/v1', 'http://127.0.0.1:11434/v1', 'http://[::1]:11434/v1']) {
    assert.equal(resolveLlmConfig({ GEV_LLM_BASE_URL: baseUrl }).baseUrl, baseUrl);
  }
  for (const baseUrl of [
    'http://example.com/v1', 'http://192.168.1.2/v1', 'ftp://localhost/v1',
    'https://user:secret@example.com/v1', 'https://example.com/v1?key=secret',
    'https://example.com/v1#secret', 'not-a-url', 'http://localhost.evil.test/v1',
  ]) {
    assert.throws(() => resolveLlmConfig({ GEV_LLM_BASE_URL: baseUrl }), { code: 'LLM_INVALID_CONFIG' });
  }
});

test('invalid providers and control characters in configuration fail safely', () => {
  assert.throws(() => resolveLlmConfig({ GEV_LLM_PROVIDER: 'unknown' }), { code: 'LLM_INVALID_CONFIG' });
  assert.throws(() => resolveLlmConfig({ OPENAI_API_KEY: 'secret\r\nInjected: yes' }), { code: 'LLM_INVALID_CONFIG' });
  assert.throws(() => resolveLlmConfig({ GEV_LLM_MODEL: 'model\nsecret' }), { code: 'LLM_INVALID_CONFIG' });
});
