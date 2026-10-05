import { resolveLlmConfig, validateLlmBaseUrl } from './providers.js';
import { resolveVoiceprintConfig } from './voiceprintConfig.mjs';

export const SPEECH_PROVIDERS = Object.freeze(['browser', 'current', 'custom', 'realtime']);
export const SPEECH_SETUP_FIELDS = Object.freeze([
  'GEV_STT_PROVIDER', 'GEV_STT_MODEL', 'GEV_STT_BASE_URL', 'GEV_STT_API_KEY',
  'VOICEPRINT_ENABLED', 'VOICEPRINT_MODE', 'VOICEPRINT_PROFILE', 'VOICEPRINT_THRESHOLD',
]);
const invalid = () => Object.assign(new Error('Invalid speech configuration.'), { code: 'STT_INVALID_CONFIG' });
const setting = (value, maxLength = 512) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) throw invalid();
  return value.trim();
};

function baseUrl(value) {
  try { return validateLlmBaseUrl(value); } catch { throw invalid(); }
}

export function isSpeechLoopback(url) {
  if (!url) return false;
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname); }
  catch { return false; }
}

export function resolveSpeechConfig(env = {}) {
  const provider = setting(env.GEV_STT_PROVIDER) || 'browser';
  if (!SPEECH_PROVIDERS.includes(provider)) throw invalid();
  const model = setting(env.GEV_STT_MODEL ?? 'whisper-1', 256);
  if (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,255}$/.test(model)) throw invalid();
  if (provider === 'browser') return { provider, model, baseUrl: '', apiKey: '', configured: true };
  if (provider === 'realtime') {
    return { provider, model, baseUrl: '', apiKey: '', configured: Boolean(setting(env.OPENAI_API_KEY)) };
  }
  if (provider === 'current') {
    let llm;
    try { llm = resolveLlmConfig(env); } catch { throw invalid(); }
    const supported = ['openai', 'custom'].includes(llm.provider);
    return { provider, model, baseUrl: supported ? llm.baseUrl : '', apiKey: supported ? llm.apiKey : '',
      configured: Boolean(supported && model && llm.baseUrl && (llm.apiKey || isSpeechLoopback(llm.baseUrl))), supported,
    };
  }
  const endpoint = baseUrl(setting(env.GEV_STT_BASE_URL, 2048));
  const apiKey = setting(env.GEV_STT_API_KEY);
  return { provider, model, baseUrl: endpoint, apiKey, configured: Boolean(model && endpoint && (apiKey || isSpeechLoopback(endpoint))) };
}

function publicCustomSpeechConfig(env) {
  try {
    const { model, baseUrl: endpoint, apiKey, configured } = resolveSpeechConfig({ ...env, GEV_STT_PROVIDER: 'custom' });
    return { model, baseUrl: endpoint, keyConfigured: Boolean(apiKey), configured };
  } catch {
    // An invalid inactive endpoint must not disable browser or Realtime speech.
    return { model: '', baseUrl: '', keyConfigured: false, configured: false };
  }
}

export function publicSpeechConfig(env = {}) {
  const { provider, model, baseUrl: endpoint, apiKey, configured } = resolveSpeechConfig(env);
  const voiceprint = resolveVoiceprintConfig(env);
  const result = { provider, model, baseUrl: endpoint, configured,
    keyConfigured: provider === 'realtime' ? Boolean(setting(env.OPENAI_API_KEY)) : Boolean(apiKey),
    custom: publicCustomSpeechConfig(env),
  };
  if (Object.keys(env).some((key) => key.startsWith('VOICEPRINT_'))) {
    result.voiceprint = voiceprint;
  }
  return result;
}
