const provider = (id, label, defaultModel, baseUrl, envPrefix, keyOptional = false) => Object.freeze({
  id, label, defaultModel, baseUrl,
  keyEnv: `${envPrefix}_API_KEY`, modelEnv: `${envPrefix}_MODEL`, baseUrlEnv: `${envPrefix}_BASE_URL`,
  keyOptional,
});

// Public metadata is also consumed by setup UI; never attach environment values here.
export const LLM_PROVIDERS = Object.freeze([
  provider('openai', 'OpenAI', 'gpt-4.1-mini', 'https://api.openai.com/v1', 'OPENAI'),
  provider('deepseek', 'DeepSeek', 'deepseek-chat', 'https://api.deepseek.com/v1', 'DEEPSEEK'),
  provider('qwen', 'Qwen', 'qwen-plus', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'QWEN'),
  provider('moonshot', 'Moonshot / Kimi', 'moonshot-v1-8k', 'https://api.moonshot.cn/v1', 'MOONSHOT'),
  provider('anthropic', 'Anthropic / Claude', 'claude-sonnet-4-20250514', 'https://api.anthropic.com/v1', 'ANTHROPIC'),
  provider('gemini', 'Google Gemini', 'gemini-2.5-flash', 'https://generativelanguage.googleapis.com/v1beta', 'GEMINI'),
  provider('ollama', 'Ollama', 'llama3.1:8b', 'http://localhost:11434/v1', 'OLLAMA', true),
  provider('custom', 'OpenAI-compatible', '', '', 'GEV_LLM'),
]);

function invalidConfig(message) {
  return Object.assign(new Error(message), { code: 'LLM_INVALID_CONFIG' });
}

function setting(value, label, maxLength = 2048) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalidConfig(`Invalid LLM ${label}.`);
  }
  return value.trim();
}

/**
 * Reject destinations that are private, link-local, metadata, or otherwise
 * local-only. Provider credentials are attached after this check, so HTTPS
 * alone must not turn the dev server into a credential relay.
 */
export function isSafeRemoteBaseUrlHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || host === 'metadata' || host === 'metadata.google.internal'
    || host === 'instance-data.ec2.internal') return false;
  const octets = host.split('.');
  if (octets.length === 4 && octets.every((part) => /^\d+$/.test(part) && Number(part) <= 255)) {
    const [a, b] = octets.map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  if (host.includes(':')) {
    // Loopback, unspecified, IPv4-mapped private, ULA, and link-local IPv6.
    const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mapped) {
      const high = parseInt(mapped[1], 16); const low = parseInt(mapped[2], 16);
      return isSafeRemoteBaseUrlHost([high >> 8, high & 255, low >> 8, low & 255].join('.'));
    }
    return !(host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd')
      || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')
      || host.startsWith('::ffff:10.') || host.startsWith('::ffff:192.168.')
      || /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(host));
  }
  return true;
}

export function validateLlmBaseUrl(value) {
  const raw = setting(value, 'base URL');
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); } catch { throw invalidConfig('Invalid LLM base URL.'); }
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (!/^https?:\/\//i.test(raw) || raw.includes('\\') || /[?#]/.test(raw)
    || parsed.username || parsed.password
    || (!isLoopback && !isSafeRemoteBaseUrlHost(parsed.hostname))
    || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback))) {
    throw invalidConfig('LLM base URL must use HTTPS, or HTTP on localhost, without credentials, query or fragment.');
  }
  return parsed.href.replace(/\/+$/, '');
}

export function resolveLlmConfig(env = {}) {
  const providerId = setting(env.GEV_LLM_PROVIDER, 'provider', 64) || 'openai';
  const selected = LLM_PROVIDERS.find(({ id }) => id === providerId);
  if (!selected) throw invalidConfig('Unsupported LLM provider.');
  const model = setting(env.GEV_LLM_MODEL ?? env[selected.modelEnv] ?? selected.defaultModel, 'model', 256);
  const baseUrl = validateLlmBaseUrl(env.GEV_LLM_BASE_URL ?? env[selected.baseUrlEnv] ?? selected.baseUrl);
  const apiKey = setting(env[selected.keyEnv] || (selected.id === 'qwen' ? env.DASHSCOPE_API_KEY : ''), 'API key');
  return {
    provider: selected.id, model, baseUrl, apiKey,
    configured: Boolean(model && baseUrl && (apiKey || selected.keyOptional)),
  };
}

export function publicLlmConfig(env = {}) {
  const { apiKey: _apiKey, ...publicConfig } = resolveLlmConfig(env);
  return publicConfig;
}
