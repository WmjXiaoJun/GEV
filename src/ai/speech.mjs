import { validateLlmBaseUrl } from './providers.js';
import { isSpeechLoopback } from './speechConfig.mjs';
import { normalizeChineseText } from './chinese.js';

export const MAX_SPEECH_AUDIO_BYTES = 4 * 1024 * 1024;
export const MAX_SPEECH_BODY_BYTES = Math.ceil(MAX_SPEECH_AUDIO_BYTES / 3) * 4 + 1024;
export const SPEECH_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 65536;
const mimeTypes = new Map([
  ['audio/webm', ['audio/webm', 'webm']], ['audio/webm;codecs=opus', ['audio/webm', 'webm']],
  ['audio/ogg', ['audio/ogg', 'ogg']], ['audio/ogg;codecs=opus', ['audio/ogg', 'ogg']],
  ['audio/mp4', ['audio/mp4', 'mp4']], ['audio/mp4;codecs=mp4a.40.2', ['audio/mp4', 'mp4']],
  ['audio/mpeg', ['audio/mpeg', 'mp3']], ['audio/mp3', ['audio/mpeg', 'mp3']],
  ['audio/wav', ['audio/wav', 'wav']], ['audio/x-wav', ['audio/wav', 'wav']],
  ['audio/flac', ['audio/flac', 'flac']],
]);
const fail = (code) => Object.assign(new Error('Speech recognition request failed.'), { code });
const httpFailureCodes = new Map([
  [401, 'STT_AUTH_ERROR'], [403, 'STT_AUTH_ERROR'],
  [404, 'STT_ENDPOINT_UNAVAILABLE'], [405, 'STT_ENDPOINT_UNAVAILABLE'],
  [429, 'STT_RATE_LIMITED'], [502, 'STT_SERVICE_UNAVAILABLE'], [503, 'STT_SERVICE_UNAVAILABLE'],
  [504, 'STT_TIMEOUT'],
]);
const responseFailureCodes = new Set([
  'STT_INVALID_RESPONSE', 'STT_NO_SPEECH', 'STT_UPSTREAM_ERROR', ...httpFailureCodes.values(),
  'VOICEPRINT_INVALID_REQUEST', 'VOICEPRINT_ID', 'VOICEPRINT_THRESHOLD', 'VOICEPRINT_AUDIO_TOO_LARGE',
  'VOICEPRINT_UNAVAILABLE', 'VOICEPRINT_NOT_ENROLLED', 'VOICEPRINT_REJECTED', 'VOICEPRINT_TIMEOUT',
  'VOICEPRINT_RATE_LIMITED', 'VOICEPRINT_CONNECTION_ERROR', 'VOICEPRINT_UPSTREAM_ERROR',
  'VOICEPRINT_INVALID_RESPONSE', 'VOICEPRINT_CANCELLED',
]);

export function validateSpeechInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((name) => !['audio', 'mimeType', 'locale'].includes(name))
    || typeof input.audio !== 'string' || !input.audio || typeof input.mimeType !== 'string') throw fail('STT_INVALID_REQUEST');
  if (input.audio.length > Math.ceil(MAX_SPEECH_AUDIO_BYTES / 3) * 4) throw fail('STT_AUDIO_TOO_LARGE');
  const type = mimeTypes.get(input.mimeType.toLowerCase().replace(/;\s*codecs=/, ';codecs='));
  if (!type || input.audio.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(input.audio)
    || (input.locale !== undefined && !['en', 'en-US', 'zh', 'zh-CN'].includes(input.locale))) throw fail('STT_INVALID_REQUEST');
  const audio = Buffer.from(input.audio, 'base64');
  if (!audio.length || audio.toString('base64') !== input.audio) throw fail('STT_INVALID_REQUEST');
  if (audio.length > MAX_SPEECH_AUDIO_BYTES) throw fail('STT_AUDIO_TOO_LARGE');
  return { audio, mimeType: type[0], filename: `recording.${type[1]}`, language: input.locale?.startsWith('zh') ? 'zh' : input.locale ? 'en' : null };
}

function checkedSpeechConfig(config) {
  if (config?.provider === 'current' && config.supported === false) throw fail('STT_UNSUPPORTED_PROVIDER');
  if (!['current', 'custom'].includes(config?.provider) || !config.configured) throw fail('STT_NOT_CONFIGURED');
  let endpoint;
  try { endpoint = validateLlmBaseUrl(config.baseUrl); } catch { throw fail('STT_INVALID_CONFIG'); }
  if (!endpoint || typeof config.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,255}$/.test(config.model)
    || typeof config.apiKey !== 'string' || /[\u0000-\u001f\u007f]/.test(config.apiKey)
    || (!config.apiKey && !isSpeechLoopback(endpoint))) throw fail('STT_INVALID_CONFIG');
  return { ...config, baseUrl: endpoint };
}

async function transcriptJson(response) {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw fail('STT_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw fail('STT_INVALID_RESPONSE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('STT_INVALID_RESPONSE'); }
  if (typeof parsed?.text !== 'string' || parsed.text.length > 8000) throw fail('STT_INVALID_RESPONSE');
  if (!parsed.text.trim()) throw fail('STT_NO_SPEECH');
  return { text: parsed.text.trim() };
}

export async function requestSpeechTranscription({ config, input, fetchImpl = fetch, signal }) {
  const resolved = checkedSpeechConfig(config);
  const audio = validateSpeechInput(input);
  const body = new FormData();
  body.set('file', new Blob([audio.audio], { type: audio.mimeType }), audio.filename);
  body.set('model', resolved.model);
  body.set('response_format', 'json');
  if (audio.language) body.set('language', audio.language);
  const deadline = AbortSignal.timeout(SPEECH_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    combinedSignal.throwIfAborted();
    const response = await fetchImpl(`${resolved.baseUrl}/audio/transcriptions`, {
      method: 'POST', body, headers: resolved.apiKey ? { Authorization: `Bearer ${resolved.apiKey}` } : {},
      signal: combinedSignal, redirect: 'error',
    });
    if (!response.ok) {
      try { await response.body?.cancel(); }
      finally { throw fail(httpFailureCodes.get(response.status) || 'STT_UPSTREAM_ERROR'); }
    }
    const result = await transcriptJson(response);
    return { text: normalizeChineseText(result.text, audio.language === 'zh' ? 'zh-CN' : 'en') };
  } catch (error) {
    if (signal?.aborted) throw fail('STT_CANCELLED');
    if (deadline.aborted) throw fail('STT_TIMEOUT');
    if (responseFailureCodes.has(error?.code)) throw fail(error.code);
    throw fail('STT_CONNECTION_ERROR');
  }
}
