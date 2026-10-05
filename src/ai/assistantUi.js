import { getLocale, subscribeLocale, t, translateDocument } from '../i18n.js';
import { createLlmConversation } from './conversation.js';
import { createActionGuard } from './actionGuard.js';
import { createViewStatisticsRunner, getViewStatistics } from './viewStatistics.js';
import { initIntelligenceUi } from './intelligenceUi.js';
import { normalizeChineseText } from './chinese.js';
import { formatAssistantText } from './messageText.js';
import { createViewportVision } from './vision.js';
import { initVisionUi } from './visionUi.js';
import { normalizeBuildingResult } from './buildingPolygons.js';
import { fuseBuildingPolygons } from './buildingFusion.js';
export { fuseBuildingPolygons } from './buildingFusion.js';
import { initTerrainUi } from './terrainUi.js';
import { planTerrainRoute, restorePlannedRouteGrades } from './terrainRoute.js';

const TABS = Object.freeze(['conversation', 'intelligence', 'watch', 'settings']);
const SEARCH_ERROR_CODES = new Set([
  'SEARCH_INVALID_REQUEST', 'SEARCH_INVALID_CONFIG', 'SEARCH_NOT_CONFIGURED', 'SEARCH_TIMEOUT',
  'SEARCH_RATE_LIMITED', 'SEARCH_AUTH_ERROR', 'SEARCH_UPSTREAM_ERROR', 'SEARCH_INVALID_RESPONSE',
  'SEARCH_CANCELLED', 'SEARCH_CONNECTION_ERROR', 'SEARCH_UNAVAILABLE',
]);
const SEARCH_DEFAULTS = Object.freeze({ firecrawl: 'https://api.firecrawl.dev/v2', 'agent-pro': 'http://127.0.0.1:6637/api/search' });
const BUILDING_PROMPT_MAX_VERTICES = 32;

function compressBuildingRing(points, limit = BUILDING_PROMPT_MAX_VERTICES) {
  if (!Array.isArray(points) || points.length <= limit) return points?.map((point) => [...point]) || [];
  const valid = points.filter((point) => Array.isArray(point) && point.length === 2
    && point.every((value) => Number.isFinite(value)));
  if (valid.length <= limit) return valid.map((point) => [...point]);
  const extreme = [
    valid.reduce((best, point, index) => point[1] < valid[best][1] ? index : best, 0),
    valid.reduce((best, point, index) => point[0] > valid[best][0] ? index : best, 0),
    valid.reduce((best, point, index) => point[1] > valid[best][1] ? index : best, 0),
    valid.reduce((best, point, index) => point[0] < valid[best][0] ? index : best, 0),
  ];
  const selected = new Set(extreme);
  for (let index = 0; index < limit; index += 1) selected.add(Math.floor(index * valid.length / limit));
  for (let index = 0; selected.size < limit && index < valid.length; index += 1) selected.add(index);
  return [...selected].sort((a, b) => a - b).slice(0, limit).map((index) => [...valid[index]]);
}

/** Keep the full YOLO masks for drawing while sending compact shape guidance to the VLM. */
export function compressBuildingCandidates(candidates, limit = BUILDING_PROMPT_MAX_VERTICES) {
  if (!Array.isArray(candidates)) return [];
  return candidates.map((item) => ({ ...item, points: compressBuildingRing(item?.points, limit) }));
}

/**
 * Normalize the local building-segmentation contract into the polygon shape
 * consumed by the Cesium building layer. The route is deliberately kept
 * separate from the LPM-inspired refinement result so callers can report
 * whether the second stage was used or skipped.
 */
export function normalizeBuildingSegmentationResult(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'BUILDINGS_SEG_INVALID_RESPONSE' };
  const normalized = normalizeBuildingResult({ ...payload, task: 'buildings' });
  if (!normalized.ok) return { ok: false, error: 'BUILDINGS_SEG_INVALID_RESPONSE' };
  return {
    ...normalized,
    task: 'buildings-seg',
    segmentationModel: normalized.model,
  };
}

function normalizeSearchToolResult(payload, responseOk, query, provider) {
  const safeProvider = ['agent-pro', 'firecrawl'].includes(payload?.provider) ? payload.provider : provider;
  const base = { provider: safeProvider, query: String(query || '').slice(0, 500) };
  if (!responseOk || !payload || typeof payload !== 'object' || payload.error
    || payload.ok === false || payload.available === false || !Array.isArray(payload.results)) {
    const code = payload?.code || payload?.error;
    return { ...base, ok: false, available: false, error: SEARCH_ERROR_CODES.has(code) ? code : 'SEARCH_INVALID_RESPONSE' };
  }
  const initial = { ...base, ok: true, available: true, results: [], count: 0,
    searchedAt: typeof payload.searchedAt === 'string' ? payload.searchedAt.slice(0, 80) : '', truncated: Boolean(payload.truncated) };
  return payload.results.slice(0, 10).reduce((result, entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') return result;
    let url;
    try { url = new URL(entry.url); } catch { return result; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return result;
    const clean = Object.fromEntries(Object.entries({ title: 300, url: 2048, description: 1200, markdown: 3200, publishedAt: 80, category: 80 })
      .filter(([key]) => typeof entry[key] === 'string').map(([key, limit]) => [key, entry[key].slice(0, limit)]));
    const next = { ...result, results: [...result.results, clean], count: result.count + 1 };
    return JSON.stringify(next).length <= 15900 ? next : { ...result, truncated: true };
  }, initial);
}

const ERROR_KEYS = Object.freeze({
  LLM_NOT_CONFIGURED: 'ai.error.notConfigured',
  LLM_INVALID_CONFIG: 'ai.error.invalidConfig',
  LLM_INVALID_REQUEST: 'ai.error.invalidRequest',
  LLM_TIMEOUT: 'ai.error.timeout',
  LLM_RATE_LIMITED: 'ai.error.rateLimited',
  LLM_UPSTREAM_ERROR: 'ai.error.upstream',
  LLM_INVALID_RESPONSE: 'ai.error.invalidResponse',
  LLM_BUSY: 'ai.error.busy',
  LLM_EMPTY_MESSAGE: 'ai.error.emptyMessage',
  LLM_TOOL_LIMIT: 'ai.error.toolLimit',
  LLM_CANCELLED: 'ai.error.cancelled',
  LLM_TOOL_ERROR: 'ai.error.tool',
  LLM_NETWORK: 'ai.error.network',
  LLM_LOCAL_ONLY: 'ai.error.localOnly',
  LLM_CONNECTION_ERROR: 'ai.error.connection',
  LLM_INVALID_INPUT: 'ai.error.invalidRequest',
  LLM_REQUEST_TOO_LARGE: 'ai.error.requestTooLarge',
  ...Object.fromEntries([
    'UNAVAILABLE', 'NOT_ENROLLED', 'REJECTED', 'AUDIO', 'INVALID_REQUEST', 'ID', 'THRESHOLD',
    'TIMEOUT', 'RATE_LIMITED', 'CONNECTION_ERROR', 'UPSTREAM_ERROR', 'INVALID_RESPONSE',
    'CANCELLED', 'FAILED', 'STORAGE_ERROR', 'BUSY', 'UNSUPPORTED_PROVIDER',
  ].map((code) => [`VOICEPRINT_${code}`, `ai.speech.error.VOICEPRINT_${code}`])),
});

function speechSettingsPayload(providerId, speech) {
  if (!speech) return {};
  const mode = speech.provider || 'browser';
  if (!['browser', 'current', 'custom', 'realtime'].includes(mode)
    || (mode === 'current' && !['openai', 'custom'].includes(providerId))) {
    throw Object.assign(new Error('Unsupported transcription configuration'), { code: 'VOICE_INVALID_CONFIG' });
  }
  const server = mode === 'current' || mode === 'custom';
  const key = String(speech.apiKey || '').trim();
  const voiceprint = speech.voiceprint;
  const voiceprintPayload = voiceprint && (voiceprint.enabled !== undefined || voiceprint.mode)
    ? {
      VOICEPRINT_ENABLED: voiceprint.enabled ? '1' : '0',
      VOICEPRINT_MODE: voiceprint.mode === 'enforce' ? 'enforce' : 'observe',
      ...(voiceprint.profile ? { VOICEPRINT_PROFILE: String(voiceprint.profile).trim() } : {}),
      VOICEPRINT_THRESHOLD: String(Math.min(0.8, Math.max(0.05, Number(voiceprint.threshold ?? 0.25) || 0.25))),
    } : {};
  return {
    GEV_STT_PROVIDER: mode,
    ...(server ? { GEV_STT_MODEL: String(speech.model || 'whisper-1').trim() } : {}),
    ...(mode === 'custom' ? { GEV_STT_BASE_URL: String(speech.baseUrl || '').trim() } : {}),
    ...(mode === 'custom' && key ? { GEV_STT_API_KEY: key } : {}),
    ...voiceprintPayload,
  };
}

/** Keep web-search credentials separate from the selected chat provider. */
export function buildSearchSettingsPayload(search) {
  if (!search || typeof search !== 'object') return {};
  const provider = String(search.provider || 'firecrawl').trim().toLowerCase();
  const baseUrl = String(search.baseUrl || '').trim();
  const key = String(search.apiKey || '').trim();
  if (provider === 'agent-pro') {
    if (!baseUrl && !key) return {};
    return {
      AGENT_PRO_SEARCH_ENABLED: '1',
      ...(baseUrl ? { AGENT_PRO_SEARCH_URL: baseUrl } : {}),
      ...(key ? { AGENT_PRO_LOCAL_HEADER: key } : {}),
    };
  }
  if (provider !== 'firecrawl' || (!baseUrl && !key)) return {};
  return {
    AGENT_PRO_SEARCH_ENABLED: '0',
    FIRECRAWL_BASE_URL: baseUrl || 'https://api.firecrawl.dev/v2',
    ...(key ? { FIRECRAWL_API_KEY: key } : {}),
  };
}

function searchSettingsAreDirty(config, search) {
  if (!search || typeof search !== 'object') return false;
  const saved = config?.search;
  const hasDraft = Boolean(String(search.baseUrl || '').trim() || String(search.apiKey || '').trim());
  if (!saved && !hasDraft) return false;
  if (!saved) return hasDraft;
  return String(search.provider || 'firecrawl').trim() !== String(saved.provider || 'firecrawl').trim()
    || String(search.baseUrl || '').trim() !== String(saved.baseUrl || '').trim()
    || Boolean(String(search.apiKey || '').trim());
}

function savedCustomSpeech(config) {
  const speech = config?.speech;
  return speech?.custom || (speech?.provider === 'custom' ? speech : {
    model: 'whisper-1', baseUrl: '', keyConfigured: false, configured: false,
  });
}

function speechSettingsAreDirty(config, speech) {
  if (!speech) return false;
  const saved = config?.speech || { provider: 'browser', model: 'whisper-1', baseUrl: '' };
  const mode = speech.provider || 'browser';
  const source = mode === 'custom' ? savedCustomSpeech(config) : saved;
  const savedVoiceprint = saved.voiceprint || { enabled: false, mode: 'observe', profile: '', threshold: 0.25 };
  const voiceprint = speech.voiceprint || { enabled: false, mode: 'observe', profile: '', threshold: 0.25 };
  return mode !== saved.provider
    || (['current', 'custom'].includes(mode) && String(speech.model || '').trim() !== source.model)
    || (mode === 'custom' && (String(speech.baseUrl || '').trim() !== source.baseUrl || Boolean(String(speech.apiKey || '').trim())))
    || Boolean(voiceprint.enabled) !== Boolean(savedVoiceprint.enabled)
    || (voiceprint.mode || 'observe') !== (savedVoiceprint.mode || 'observe')
    || String(voiceprint.profile || '').trim() !== String(savedVoiceprint.profile || '').trim()
    || Number(voiceprint.threshold ?? 0.25) !== Number(savedVoiceprint.threshold ?? 0.25);
}

/** Only credentials for the selected server-reported provider can be saved. */
export function buildAiSettingsPayload(config, draft) {
  const provider = config?.providers?.find((entry) => entry.id === draft.provider);
  if (!provider) throw new Error('Unknown provider');
  const key = String(draft.apiKey || '').trim();
  return {
    GEV_LLM_PROVIDER: provider.id,
    GEV_LLM_MODEL: String(draft.model || '').trim(),
    GEV_LLM_BASE_URL: String(draft.baseUrl || '').trim(),
    ...(key && provider.keyEnv ? { [provider.keyEnv]: key } : {}),
    ...speechSettingsPayload(provider.id, draft.speech),
    ...buildSearchSettingsPayload(draft.search),
  };
}

export function aiSettingsAreDirty(config, draft) {
  return Boolean(config && (
    draft.provider !== config.provider
    || String(draft.model || '').trim() !== config.model
    || String(draft.baseUrl || '').trim() !== config.baseUrl
    || String(draft.apiKey || '').trim()
    || speechSettingsAreDirty(config, draft.speech)
    || searchSettingsAreDirty(config, draft.search)
  ));
}

export function initAiAssistant({
  runAction, workspace, fetchImpl = globalThis.fetch?.bind(globalThis),
  documentRef = globalThis.document,
} = {}) {
  const byId = (name) => documentRef.getElementById(name);
  const dialog = byId('ai-assistant');
  const toggle = byId('ai-assistant-toggle');
  if (!dialog || !toggle) return null;
  const elements = Object.fromEntries([
    'provider', 'model', 'base-url', 'api-key', 'key-status', 'voice-status',
    'active-model', 'messages', 'empty', 'message', 'send', 'stop', 'clear',
    'save', 'test', 'settings-form', 'message-form', 'conversation-status',
    'settings-status', 'tab-conversation', 'tab-intelligence', 'tab-watch', 'tab-settings',
    'conversation-panel', 'intelligence-panel', 'watch-panel', 'settings-panel', 'assistant-close',
    'speech-provider', 'speech-model', 'speech-base-url', 'speech-api-key',
    'speech-server-fields', 'speech-custom-fields', 'speech-key-status', 'speech-hint',
    'voiceprint-status', 'voiceprint-mode', 'voiceprint-profile', 'voiceprint-threshold',
    'voiceprint-enabled',
    'voiceprint-threshold-value', 'voiceprint-audio', 'voiceprint-enroll', 'voiceprint-verify',
    'voiceprint-delete', 'voiceprint-hint', 'voiceprint-record', 'voiceprint-record-status',
    'diagnostics', 'diagnostics-refresh', 'voice-draft-edit',
    'search-provider', 'search-base-url', 'search-api-key', 'search-api-key-label',
    'search-key-status', 'search-status', 'search-refresh',
  ].map((name) => [name, byId(`ai-${name}`)]));
  let config = null;
  let phase = 'idle';
  let settingsBusy = false;
  let configLoading = false;
  let destroyed = false;
  let controllers = [];
  let messages = [];
  let messageSequence = 0;
  let messageRows = new Map();
  let voiceDraft = '';
  let diagnostics = null;
  let diagnosticsBusy = false;
  let sendSequence = 0;
  let selectedTab = 'conversation';
  let notices = { conversation: null, settings: null };
  let subscribers = [];
  let cancelling = false;
  let speechMode = 'browser';
  let searchMode = 'firecrawl';
  let searchDrafts = { firecrawl: { baseUrl: '' }, 'agent-pro': { baseUrl: SEARCH_DEFAULTS['agent-pro'] } };
  let searchActivity = null;
  let speechDrafts = { current: { model: 'whisper-1' }, custom: { model: 'whisper-1', baseUrl: '' } };
  let voiceprint = { available: false, enabled: false, mode: 'observe', profile: '', threshold: 0.25, profiles: [] };
  let voiceprintBusy = false;
  let voiceprintRecording = null;
  let voiceprintSampleFile = null;
  let intelligenceUi = null;
  let visionUi = null;
  let terrainUi = null;
  let latestTerrainResult = null;
  let visionBusy = false;
  let buildingController = null;
  let buildingSequence = 0;
  let actionState = { pending: null, executing: false };
  const cleanups = [];
  const isRunning = () => visionBusy || ['thinking', 'streaming', 'executing'].includes(phase) || Boolean(actionState.pending) || actionState.executing;
  const readDraft = () => ({
    provider: elements.provider.value,
    model: elements.model.value,
    baseUrl: elements['base-url'].value,
    apiKey: elements['api-key'].value,
    speech: {
      provider: elements['speech-provider'].value || 'browser',
      model: elements['speech-model'].value,
      baseUrl: elements['speech-base-url'].value,
      apiKey: elements['speech-api-key'].value,
      voiceprint: typeof elements['voiceprint-enabled']?.checked === 'boolean' && voiceprint.available ? {
        enabled: Boolean(elements['voiceprint-enabled'].checked),
        mode: elements['voiceprint-mode']?.value || 'observe',
        profile: String(elements['voiceprint-profile']?.value || '').trim(),
        threshold: Number(elements['voiceprint-threshold']?.value || 0.25),
      } : undefined,
    },
    search: {
      provider: elements['search-provider']?.value || 'firecrawl',
      baseUrl: elements['search-base-url']?.value || '',
      apiKey: elements['search-api-key']?.value || '',
    },
  });
  const selectedProvider = () => config?.providers?.find((entry) => entry.id === elements.provider.value);
  const on = (target, event, callback) => {
    target.addEventListener(event, callback);
    cleanups.push(() => target.removeEventListener(event, callback));
  };

  function notify(event) {
    for (const listener of subscribers) {
      try { listener(event); } catch { console.warn('[AI] Assistant lifecycle listener failed'); }
    }
  }

  function cancel() {
    if (destroyed || cancelling) return;
    cancelling = true;
    sendSequence += 1;
    try {
      vision.cancel();
      buildingSequence += 1;
      buildingController?.abort();
      buildingController = null;
      if (visionBusy) visionUi?.render({ status: 'error', error: 'VISION_CANCELLED' });
      visionBusy = false;
      guard.cancel(); conversation.cancel(); notify({ type: 'cancel' });
    }
    finally { cancelling = false; }
  }

  function setNotice(scope, key, params = {}, error = false) {
    notices = { ...notices, [scope]: { key, params, error } };
    renderStatus();
  }

  function showError(scope, error, fallback = 'ai.error.unavailable') {
    const speechKey = `ai.speech.error.${error?.code}`;
    const key = error?.status === 409
      ? 'ai.error.external'
      : (ERROR_KEYS[error?.code] || (t(speechKey) !== speechKey ? speechKey : fallback));
    setNotice(scope, key, {}, true);
  }

  function renderStatus() {
    const defaultConversation = actionState.pending ? 'intel.confirmTitle'
      : actionState.executing ? 'intel.executing'
      : visionBusy ? 'vision.running'
      : isRunning() ? `ai.${phase}` : (config?.configured ? 'ai.ready' : 'ai.notConfigured');
    for (const scope of ['conversation', 'settings']) {
      const notice = notices[scope];
      const element = elements[`${scope}-status`];
      element.textContent = notice ? t(notice.key, notice.params) : (scope === 'conversation' ? t(defaultConversation) : '');
      element.dataset.error = String(Boolean(notice?.error));
    }
  }

  function renderControls() {
    const busy = isRunning();
    const dirty = aiSettingsAreDirty(config, readDraft());
    const provider = selectedProvider();
    elements.send.hidden = busy;
    elements.stop.hidden = !busy;
    elements.send.disabled = !config?.configured || settingsBusy || !elements.message.value.trim();
    elements.message.disabled = busy || settingsBusy;
    elements.clear.disabled = busy || messages.length === 0;
    elements.save.disabled = !config || settingsBusy || busy || !dirty;
    elements.test.disabled = !config?.configured || settingsBusy || busy || dirty;
    elements.test.title = t(dirty ? 'ai.saveFirst' : 'ai.test');
    for (const name of ['provider', 'model', 'base-url', 'api-key']) {
      elements[name].disabled = !config || settingsBusy || busy;
    }
    if (elements['search-provider']) elements['search-provider'].disabled = !config || settingsBusy || busy;
    if (elements['search-base-url']) elements['search-base-url'].disabled = !config || settingsBusy || busy;
    if (elements['search-api-key']) elements['search-api-key'].disabled = !config || settingsBusy || busy;
    if (elements['search-refresh']) elements['search-refresh'].disabled = settingsBusy || busy;
    elements['api-key'].placeholder = t(provider?.keyConfigured
      ? 'ai.keyPreserve' : (provider?.keyOptional ? 'ai.keyOptional' : 'ai.keyEmpty'));
    elements['key-status'].textContent = provider
      ? t(provider.keyConfigured ? 'ai.keyConfigured' : (provider.keyOptional ? 'ai.noKeyRequired' : 'ai.keyMissing')) : '';
    renderSpeechControls();
    renderVoiceprintControls();
    renderDiagnostics();
    renderSearchStatus();
    elements['active-model'].textContent = config
      ? `${providerLabel(config.providers.find((entry) => entry.id === config.provider))} / ${config.model}`
      : t('ai.notConfigured');
    elements['messages'].setAttribute('aria-busy', String(busy));
    visionUi?.setBusy(busy || settingsBusy);
    renderStatus();
  }

  function renderDiagnostics() {
    const host = elements.diagnostics;
    if (!host) return;
    host.textContent = '';
    if (diagnosticsBusy) {
      host.textContent = t('ai.diagnostics.loading');
      return;
    }
    if (!diagnostics) {
      host.textContent = t('ai.diagnostics.unavailable');
      return;
    }
    const speech = diagnostics.speech || {};
    const llm = diagnostics.llm || {};
    const browser = diagnostics.browser || {};
    host.textContent = [
      `${t('ai.diagnostics.llm')}: ${llm.status === 'ok' ? t('ai.diagnostics.ok') : t('ai.diagnostics.failed')}`,
      `${t('ai.diagnostics.speech')}: ${speech.status === 'ok' ? t('ai.diagnostics.ok') : t('ai.diagnostics.failed')}${speech.model ? ` (${speech.model})` : ''}`,
      `${t('vision.title')}: ${diagnostics.vision?.status === 'ok' ? t('ai.diagnostics.ok') : t('ai.diagnostics.failed')}${diagnostics.vision?.model ? ` (${diagnostics.vision.model})` : ''}`,
      `${t('ai.diagnostics.microphone')}: ${browser.microphone ? t('ai.diagnostics.available') : t('ai.diagnostics.unavailable')}`,
    ].join(' | ');
  }

  function renderSearchStatus() {
    const status = elements['search-status'];
    if (!status) return;
    const saved = config?.search || {};
    const mode = elements['search-provider']?.value || 'firecrawl';
    const search = mode === (saved.provider || 'firecrawl') ? saved : saved[mode === 'agent-pro' ? 'agentPro' : 'firecrawl'] || {};
    const configured = Boolean(search.configured ?? search.keyConfigured);
    const params = { provider: t(mode === 'agent-pro' ? 'ai.search.agentPro' : 'ai.search.firecrawl') };
    const latest = searchActivity?.provider === mode ? searchActivity : diagnostics?.search;
    const state = mode === (saved.provider || 'firecrawl') ? latest?.status : undefined;
    const statusKey = state === 'ok' ? 'ai.search.statusReady' : state === 'running' ? 'ai.search.statusSearching'
      : configured && (!state || state === 'configured') ? 'ai.search.statusConfigured' : 'ai.search.statusUnavailable';
    status.textContent = t(statusKey, params);
    if (elements['search-api-key-label']) {
      const key = mode === 'agent-pro' ? 'ai.search.agentProCredential' : 'ai.search.apiKey';
      elements['search-api-key-label'].textContent = t(key);
      elements['search-api-key-label'].setAttribute('data-i18n', key);
    }
    if (elements['search-api-key']) elements['search-api-key'].placeholder = t(search.keyConfigured ? 'ai.keyPreserve' : search.keyOptional ? 'ai.keyOptional' : 'ai.keyEmpty');
    if (elements['search-key-status']) {
      elements['search-key-status'].textContent = t(search.keyConfigured ? 'ai.search.keyConfigured' : search.keyOptional ? 'ai.noKeyRequired' : 'ai.search.keyMissing');
    }
  }

  async function refreshDiagnostics() {
    if (destroyed || diagnosticsBusy) return;
    diagnosticsBusy = true;
    renderDiagnostics();
    try {
      const data = await requestJson('/api/ai/diagnostics');
      const browser = documentRef.defaultView || globalThis;
      diagnostics = { ...data, browser: {
        microphone: Boolean(browser.navigator?.mediaDevices?.getUserMedia),
        recognition: Boolean(browser.SpeechRecognition || browser.webkitSpeechRecognition),
      } };
      if (searchActivity?.status !== 'running') searchActivity = null;
      renderSearchStatus();
    } catch {
      const browser = documentRef.defaultView || globalThis;
      if (searchActivity?.status !== 'running') searchActivity = null;
      diagnostics = { search: { status: 'failed' }, llm: { status: config?.configured ? 'ok' : 'failed' }, speech: { status: 'failed' }, browser: {
        microphone: Boolean(browser.navigator?.mediaDevices?.getUserMedia),
        recognition: Boolean(browser.SpeechRecognition || browser.webkitSpeechRecognition),
      } };
    } finally {
      diagnosticsBusy = false;
      if (!destroyed) { renderDiagnostics(); renderSearchStatus(); }
    }
  }

  async function refreshSearchStatus() {
    if (destroyed || diagnosticsBusy) return;
    await refreshDiagnostics();
  }

  function renderVoiceprintControls() {
    const profileId = String(elements['voiceprint-profile'].value || '').trim();
    const profile = voiceprint.profiles.find((entry) => entry?.id === profileId);
    const hasAudio = Boolean(elements['voiceprint-audio'].files?.[0] || voiceprintSampleFile);
    const locked = !config || settingsBusy || isRunning() || voiceprintBusy || Boolean(voiceprintRecording);
    if (elements['voiceprint-enabled']) elements['voiceprint-enabled'].disabled = locked || !voiceprint.available;
    if (elements['voiceprint-mode']) {
      elements['voiceprint-mode'].disabled = locked || !voiceprint.available || !voiceprint.enabled;
    }
    elements['voiceprint-profile'].disabled = locked;
    elements['voiceprint-threshold'].disabled = locked;
    elements['voiceprint-audio'].disabled = locked;
    elements['voiceprint-enroll'].disabled = locked || !voiceprint.available || !profileId || !hasAudio;
    elements['voiceprint-verify'].disabled = locked || !voiceprint.available || !hasAudio;
    elements['voiceprint-delete'].disabled = locked || !profile;
    elements['voiceprint-threshold-value'].value = Number(elements['voiceprint-threshold'].value || 0.25).toFixed(2);
    elements['voiceprint-threshold-value'].textContent = Number(elements['voiceprint-threshold'].value || 0.25).toFixed(2);
    elements['voiceprint-status'].textContent = !voiceprint.available
      ? t('ai.voiceprint.unavailable')
      : voiceprint.enabled
        ? t('ai.voiceprint.ready', { count: voiceprint.profiles.length })
        : t('ai.voiceprint.disabled');
    elements['voiceprint-hint'].textContent = t(voiceprint.available ? 'ai.voiceprint.hint' : 'ai.voiceprint.installHint');
    if (elements['voiceprint-record']) {
      const recording = voiceprintRecording?.phase === 'recording';
      elements['voiceprint-record'].disabled = destroyed || !voiceprint.available || (!recording && locked);
      elements['voiceprint-record'].setAttribute('aria-pressed', String(recording));
      const icon = elements['voiceprint-record'].querySelector?.('.material-symbols-outlined');
      if (icon) icon.textContent = recording ? 'stop_circle' : 'mic';
      const label = elements['voiceprint-record'].querySelector?.('[data-i18n]');
      if (label) label.textContent = t(recording ? 'ai.voiceprint.stopRecord' : 'ai.voiceprint.record');
    }
  }

  function stopVoiceprintRecording({ discard = false } = {}) {
    const session = voiceprintRecording;
    voiceprintRecording = null;
    if (session?.timer != null) clearTimeout(session.timer);
    const recorder = session?.recorder;
    if (recorder) {
      recorder.ondataavailable = recorder.onerror = recorder.onstop = null;
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* Recorder may already be stopped. */ }
    }
    for (const track of session?.stream?.getTracks?.() || []) track.stop();
    if (session) session.stream = null;
    if (discard) {
      voiceprintSampleFile = null;
      elements['voiceprint-audio'].value = '';
      elements['voiceprint-record-status'].textContent = '';
    }
    renderVoiceprintControls();
  }

  function finishVoiceprintRecording(session) {
    if (voiceprintRecording !== session || session.phase !== 'recording') return;
    session.phase = 'stopping';
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (voiceprintRecording !== session) return;
      stopVoiceprintRecording({ discard: true });
      setNotice('settings', 'ai.voiceprint.error.recording', {}, true);
    }, 2_000);
    try { session.recorder.stop(); } catch { session.recorder.onstop?.(); }
    for (const track of session.stream?.getTracks?.() || []) track.stop();
    session.stream = null;
    renderVoiceprintControls();
  }

  async function toggleVoiceprintRecording() {
    if (voiceprintRecording) {
      finishVoiceprintRecording(voiceprintRecording);
      return;
    }
    if (destroyed || !voiceprint.available || voiceprintBusy || !config || settingsBusy || isRunning()) return;
    const mediaDevices = documentRef.defaultView?.navigator?.mediaDevices || globalThis.navigator?.mediaDevices;
    const Recorder = documentRef.defaultView?.MediaRecorder || globalThis.MediaRecorder;
    if (!mediaDevices?.getUserMedia || !Recorder) {
      setNotice('settings', 'ai.voiceprint.error.recordUnsupported', {}, true);
      return;
    }
    stopVoiceprintRecording({ discard: true });
    const session = { phase: 'requesting', recorder: null, stream: null, chunks: [], timer: null };
    voiceprintRecording = session;
    session.timer = setTimeout(() => {
      if (voiceprintRecording !== session) return;
      stopVoiceprintRecording({ discard: true });
      setNotice('settings', 'ai.voiceprint.error.recording', {}, true);
    }, 30_000);
    renderVoiceprintControls();
    try {
      const stream = await mediaDevices.getUserMedia({ audio: true });
      if (destroyed || voiceprintRecording !== session) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      session.stream = stream;
      const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
        .find((type) => Recorder.isTypeSupported?.(type));
      const recorder = new Recorder(stream, options ? { mimeType: options } : undefined);
      session.recorder = recorder;
      recorder.ondataavailable = ({ data }) => {
        if (voiceprintRecording === session && data?.size) session.chunks = [...session.chunks, data];
      };
      recorder.onstop = () => {
        if (destroyed || voiceprintRecording !== session) return;
        if (session.chunks.length) {
          const mimeType = recorder.mimeType || 'audio/webm';
          const extension = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
          voiceprintSampleFile = new File(session.chunks, `voiceprint-${Date.now()}.${extension}`, { type: mimeType });
        }
        stopVoiceprintRecording();
        elements['voiceprint-record-status'].textContent = t(voiceprintSampleFile ? 'ai.voiceprint.recorded' : 'ai.voiceprint.recordEmpty');
      };
      recorder.onerror = () => {
        if (voiceprintRecording !== session) return;
        stopVoiceprintRecording({ discard: true });
        setNotice('settings', 'ai.voiceprint.error.recording', {}, true);
      };
      recorder.start(250);
      session.phase = 'recording';
      if (elements['voiceprint-record-status']) elements['voiceprint-record-status'].textContent = t('ai.voiceprint.recording');
      clearTimeout(session.timer);
      session.timer = setTimeout(() => finishVoiceprintRecording(session), 15_000);
      renderVoiceprintControls();
    } catch (error) {
      if (voiceprintRecording !== session) return;
      stopVoiceprintRecording({ discard: true });
      const code = error?.name === 'NotAllowedError' ? 'ai.speech.error.VOICE_PERMISSION' : 'ai.voiceprint.error.recording';
      setNotice('settings', code, {}, true);
    }
  }

  function renderSpeechControls() {
    const mode = elements['speech-provider'].value || 'browser';
    const server = mode === 'current' || mode === 'custom';
    const locked = !config || settingsBusy || isRunning();
    elements['speech-provider'].disabled = locked;
    elements['speech-server-fields'].hidden = !server;
    elements['speech-custom-fields'].hidden = mode !== 'custom';
    elements['speech-model'].disabled = locked || !server;
    elements['speech-base-url'].disabled = locked || mode !== 'custom';
    elements['speech-api-key'].disabled = locked || mode !== 'custom';
    for (const option of elements['speech-provider'].options) {
      if (option.value === 'current') option.disabled = !['openai', 'custom'].includes(elements.provider.value);
    }
    const custom = savedCustomSpeech(config);
    elements['speech-key-status'].textContent = t(custom.keyConfigured ? 'ai.keyConfigured' : 'ai.keyMissing');
    elements['speech-api-key'].placeholder = t(custom.keyConfigured ? 'ai.keyPreserve' : 'ai.keyEmpty');
    if (!config) {
      elements['voice-status'].textContent = '';
      elements['speech-hint'].textContent = '';
      return;
    }
    const browser = documentRef.defaultView || globalThis;
    const supported = typeof (browser.SpeechRecognition || browser.webkitSpeechRecognition) === 'function';
    let statusKey = 'ai.speech.serverReady';
    let hintKey = 'ai.speech.serverHint';
    let hintParams = {};
    if (mode === 'browser') {
      statusKey = supported ? 'ai.speech.browserReady' : 'ai.speech.browserUnavailable';
      hintKey = supported ? 'ai.speech.browserReadyHint' : 'ai.speech.browserHint';
    } else if (mode === 'realtime') {
      statusKey = config.voice?.configured ? 'ai.voiceReady' : 'ai.voiceMissing';
      hintKey = 'ai.speech.realtimeHint';
    } else if (mode === 'current' && !['openai', 'custom'].includes(elements.provider.value)) {
      statusKey = 'ai.speech.currentUnavailable';
    } else if (mode !== config.speech?.provider || !config.speech?.configured) {
      statusKey = 'ai.speech.serverNotConfigured';
    }
    const selectedSpeechModel = String(elements['speech-model'].value || config.speech?.model || '').trim();
    if (server && /^local-whisper-/.test(selectedSpeechModel)) {
      hintKey = 'ai.speech.localModelHint';
      hintParams = { model: selectedSpeechModel };
    }
    elements['voice-status'].textContent = t(statusKey);
    elements['speech-hint'].textContent = t(hintKey, hintParams);
  }

  function providerLabel(provider) {
    return provider?.id === 'custom' ? t('ai.custom') : (provider?.label || provider?.id || '');
  }

  function nearBottom() {
    const host = elements.messages;
    return !Number.isFinite(host.clientHeight) || host.scrollHeight - host.scrollTop - host.clientHeight < 80;
  }

  function renderMessage(message) {
    let parts = messageRows.get(message.id);
    if (!parts) {
      const row = documentRef.createElement('article');
      row.className = 'ai-message';
      const role = documentRef.createElement('div');
      role.className = 'ai-message-role';
      const content = documentRef.createElement('p');
      content.className = 'ai-message-content';
      const status = documentRef.createElement('span');
      status.className = 'ai-message-state';
      row.append(role, content, status);
      if (message.draft) {
        const edit = documentRef.createElement('button');
        edit.type = 'button';
        edit.id = 'ai-voice-draft-edit';
        edit.className = 'ai-draft-edit';
        edit.textContent = t('ai.speechDraftEdit');
        row.append(edit);
        on(edit, 'click', () => {
          if (destroyed || !voiceDraft) return;
          const draft = voiceDraft;
          // Editing a live draft must stop capture first, otherwise its final
          // recognition callback can submit a duplicate turn after the edit.
          notify({ type: 'voiceDraftEdit' });
          if (destroyed) return;
          elements.message.value = draft;
          voiceDraft = '';
          renderMessages();
          renderControls();
          elements.message.focus?.();
        });
      }
      parts = { row, role, content, status };
      messageRows = new Map([...messageRows, [message.id, parts]]);
      elements.messages.append(row);
    }
    const { row, role, content, status } = parts;
    row.dataset.role = message.role;
    row.dataset.streaming = String(Boolean(message.streaming));
    role.textContent = t(message.draft ? 'ai.speechDraft' : `ai.${message.role}`);
    const actionKey = `ai.action.${message.content}`;
    const actionLabel = t(actionKey);
    content.textContent = message.role === 'tool'
      ? t('ai.actionResult', {
        action: actionLabel === actionKey ? t('ai.tool') : actionLabel,
        state: t(message.ok ? 'ai.actionDone' : 'ai.actionFailed'),
      }) : normalizeChineseText(message.role === 'assistant' ? formatAssistantText(message.content, getLocale()) : message.content, getLocale());
    status.textContent = message.incomplete ? t('ai.incomplete') : message.streaming ? t('ai.streaming') : '';
    status.hidden = !status.textContent;
  }

  function renderMessages() {
    const host = elements.messages;
    const follow = nearBottom();
    host.replaceChildren();
    messageRows = new Map();
    if (messages.length === 0 && !voiceDraft) {
      const empty = documentRef.createElement('p');
      empty.className = 'ai-empty';
      empty.textContent = t('ai.empty');
      host.append(empty);
    }
    for (const message of messages) renderMessage(message);
    if (voiceDraft) renderMessage({ id: 'voice-draft', role: 'user', content: voiceDraft, draft: true });
    if (follow) host.scrollTop = host.scrollHeight;
  }

  function setVoiceDraft(text) {
    if (destroyed) return;
    voiceDraft = normalizeChineseText(text, getLocale()).slice(0, 8000);
    if (voiceDraft) open('conversation', { focus: false });
    renderMessages();
  }

  const vision = createViewportVision({
    capture: workspace?.captureImage, getViewKey: workspace?.getViewKey, fetchImpl,
    onChange(state) {
      if (destroyed) return;
      visionBusy = state.status === 'running';
      visionUi?.render(state);
      // Ground fresh local-vision detections on the current Cesium surface. The
      // map workspace converts screenshot pixels to world anchors and replaces
      // only its prior vision marks, leaving user/LLM annotations untouched.
      if (state.status === 'done' && !state.stale && typeof workspace?.drawVisionDetections === 'function') {
        void workspace.drawVisionDetections(state.result, state.result?.image).catch(() => {});
      }
      renderControls();
    },
  });
  const runBuildingRecognition = async (args = {}, options = {}) => {
    if (options.signal?.aborted) return { ok: false, error: 'BUILDINGS_CANCELLED', message: 'Building recognition was cancelled.' };
    const requestId = ++buildingSequence;
    const controller = new AbortController();
    buildingController = controller;
    const abortFromParent = () => controller.abort();
    options.signal?.addEventListener('abort', abortFromParent, { once: true });
    const isCurrent = () => requestId === buildingSequence && !controller.signal.aborted
      && options.isCurrent?.() !== false && !destroyed;
    // The local building model is trained for footprint recall, but the
    // screenshot also contains labels, UI chrome and shadows.  A slightly
    // stricter default removes the weakest false positives while callers can
    // still provide an explicit confidence threshold for dense scenes.
    const buildingConfidence = Number.isFinite(args.confidence)
      ? Math.max(0.05, Math.min(0.95, args.confidence)) : 0.20;
    const postJson = async (path, body) => {
      const response = await fetchImpl(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      return { response, payload };
    };
    try {
      const frame = await workspace?.captureImage?.({ signal: controller.signal });
      if (!isCurrent()) return { ok: false, error: 'BUILDINGS_CANCELLED', message: 'Building recognition was cancelled.' };
      if (!frame?.image || !frame.viewKey) return { ok: false, error: 'BUILDINGS_CAPTURE_UNAVAILABLE', message: 'The current view could not be captured.' };

      // YOLO-seg is the recall stage. It is building-specific and produces
      // variable-length instance polygons rather than detection rectangles.
      const segmentationRequest = await postJson('/api/vision/buildings-seg', {
        image: frame.image, confidence: buildingConfidence,
      });
      if (!isCurrent()) return { ok: false, error: 'BUILDINGS_CANCELLED', message: 'Building recognition was cancelled.' };
      if (!segmentationRequest.response.ok || !segmentationRequest.payload) {
        return runDirectBuildingRecognition(args, options);
      }
      const segmentation = normalizeBuildingSegmentationResult(segmentationRequest.payload);
      if (!segmentation.ok) return runDirectBuildingRecognition(args, options);
      if (!isCurrent() || workspace?.getViewKey?.() !== frame.viewKey) {
        return { ok: false, error: 'BUILDINGS_VIEW_CHANGED', message: '视角发生变化，结果已丢弃' };
      }

      // The image model scans the whole image for missing roofs as well as
      // refining existing masks. It also runs when YOLO found no buildings.
      let refined = null;
      let refinementError;
      {
        try {
          const refinementRequest = await postJson('/api/vision/buildings', {
            image: frame.image,
            confidence: buildingConfidence,
            candidates: compressBuildingCandidates(segmentation.polygons).map((item) => ({
              points: item.points.map((point) => [...point]), confidence: item.confidence,
            })),
          });
          if (refinementRequest.response.ok && refinementRequest.payload) {
            const normalized = normalizeBuildingResult(refinementRequest.payload);
            if (normalized.ok) refined = normalized;
            else refinementError = normalized.error || 'BUILDINGS_INVALID_RESPONSE';
          } else refinementError = refinementRequest.payload?.code || 'BUILDINGS_CONNECTION_ERROR';
        } catch (error) {
          if (error?.name === 'AbortError' || controller.signal.aborted) {
            return { ok: false, error: 'BUILDINGS_CANCELLED', message: 'Building recognition was cancelled.' };
          }
          refinementError = error?.code || 'BUILDINGS_CONNECTION_ERROR';
        }
      }

      if (!isCurrent()) return { ok: false, error: 'BUILDINGS_CANCELLED', message: 'Building recognition was cancelled.' };
      const fused = refined ? fuseBuildingPolygons(segmentation, refined) : segmentation;
      // Preserve YOLO when model polygons are unusable; an empty completed
      // scan means no additions were found, not that the model was offline.
      const fallbackUsed = !refined || (fused.refinedCount + fused.supplementedCount === 0 && refined.polygons.length > 0);
      const result = { ...fused, task: 'buildings', model: fused.model || segmentation.model };
      if (refined && fallbackUsed && !refinementError) refinementError = 'BUILDINGS_REFINEMENT_REJECTED';
      if (!isCurrent() || workspace?.getViewKey?.() !== frame.viewKey) {
        return { ok: false, error: 'BUILDINGS_VIEW_CHANGED', message: '视角发生变化，结果已丢弃' };
      }
      const drawn = await workspace.drawBuildingPolygons?.(result, result.image, {
        signal: controller.signal, isCurrent,
      });
      if (!isCurrent()) return { ok: false, error: 'BUILDINGS_CANCELLED', message: 'Building recognition was cancelled.' };
      const detectedCount = segmentation.polygons.length;
      const refinedCount = fused.refinedCount || 0;
      const drawnCount = drawn?.polygons?.length || 0;
      return {
        ok: true, task: 'buildings', model: result.model, image: result.image,
        segmentationModel: segmentation.segmentationModel || segmentation.model,
        refinementModel: refined?.model || null,
        detectedCount, refinedCount, supplementedCount: fused.supplementedCount || 0, drawnCount,
        rejectedCount: result.rejectedCount || 0,
        fusionRejectedCount: result.rejectedRefinements || 0,
        truncated: Boolean(result.truncated || refined?.truncated),
        fallbackUsed, uncertainty: fallbackUsed ? 'high' : 'medium',
        ...(refinementError ? { refinementError } : {}),
        mapDrawn: drawn?.ok === true && drawnCount > 0,
        message: drawn?.ok !== true ? 'Building outlines could not be drawn on the current surface.'
          : drawnCount === 0 ? 'No valid building outlines were produced for this image.'
            : `Detected ${detectedCount} buildings and drew ${drawnCount}${fallbackUsed ? ' using the YOLO segmentation fallback.' : ' after image-based refinement and missing-building recovery.'}`,
      };
    } catch (error) {
      return { ok: false, error: error?.name === 'AbortError' ? 'BUILDINGS_CANCELLED' : 'BUILDINGS_CONNECTION_ERROR',
        message: error?.name === 'AbortError' ? 'Building recognition was cancelled.' : 'Unable to connect to the building recognition service.' };
    } finally {
      options.signal?.removeEventListener('abort', abortFromParent);
      if (buildingController === controller) buildingController = null;
    }
  };
  const runDirectBuildingRecognition = async (args = {}, options = {}) => {
    if (options.signal?.aborted) return { ok: false, error: 'BUILDINGS_CANCELLED', message: '建筑识别已取消' };
    const requestId = ++buildingSequence;
    const controller = new AbortController();
    buildingController = controller;
    const abortFromParent = () => controller.abort();
    options.signal?.addEventListener('abort', abortFromParent, { once: true });
    const isCurrent = () => requestId === buildingSequence && !controller.signal.aborted
      && options.isCurrent?.() !== false && !destroyed;
    try {
      const frame = await workspace?.captureImage?.({ signal: controller.signal });
      if (!isCurrent()) return { ok: false, error: 'BUILDINGS_CANCELLED', message: '建筑识别已取消' };
      if (!frame?.image || !frame.viewKey) return { ok: false, error: 'BUILDINGS_CAPTURE_UNAVAILABLE', message: '当前视图无法捕获影像' };
      const response = await fetchImpl('/api/vision/buildings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: frame.image, confidence: args.confidence }), signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!isCurrent()) return { ok: false, error: 'BUILDINGS_CANCELLED', message: '建筑识别已取消' };
      if (!response.ok || !payload) {
        const code = payload?.code || 'BUILDINGS_UNAVAILABLE';
        return { ok: false, error: code,
          message: ['BUILDINGS_MODEL_UNAVAILABLE', 'BUILDINGS_NOT_CONFIGURED'].includes(code)
            ? '建筑识别模型不可用，请配置建筑轮廓模型' : '建筑识别服务暂时不可用' };
      }
      const result = normalizeBuildingResult(payload);
      if (!result.ok) return { ...result, message: '建筑识别返回的数据格式无效' };
      if (!isCurrent() || workspace?.getViewKey?.() !== frame.viewKey) {
        return { ok: false, error: 'BUILDINGS_VIEW_CHANGED', message: '识别期间视角发生变化，结果已丢弃' };
      }
      const drawn = await workspace.drawBuildingPolygons?.(result, result.image, {
        signal: controller.signal, isCurrent,
      });
      if (!isCurrent()) return { ok: false, error: 'BUILDINGS_CANCELLED', message: '建筑识别已取消' };
      const drawnCount = drawn?.polygons?.length || 0;
      return { ok: true, task: 'buildings', model: result.model, image: result.image,
        detectedCount: result.polygons.length, drawnCount, rejectedCount: result.rejectedCount,
        truncated: result.truncated, mapDrawn: drawn?.ok === true && drawnCount > 0,
        message: drawn?.ok !== true ? '建筑轮廓未能绘制到当前地表'
          : drawnCount === 0 ? '当前影像未生成有效建筑轮廓，这不代表没有建筑'
            : `已识别 ${result.polygons.length} 个候选建筑，绘制 ${drawnCount} 个` };
    } catch (error) {
      return { ok: false, error: error?.name === 'AbortError' ? 'BUILDINGS_CANCELLED' : 'BUILDINGS_CONNECTION_ERROR',
        message: error?.name === 'AbortError' ? '建筑识别已取消' : '建筑识别服务连接失败' };
    } finally {
      options.signal?.removeEventListener('abort', abortFromParent);
      if (buildingController === controller) buildingController = null;
    }
  };
  // Web search stays same-origin so the search credential never reaches
  // the browser. Search is read-only and therefore bypasses the map action
  // confirmation/undo flow.
  const runWebSearch = async (args, options = {}) => {
    const provider = config?.search?.provider === 'agent-pro' ? 'agent-pro' : 'firecrawl';
    searchActivity = { provider, status: 'running' };
    renderSearchStatus();
    try {
      const response = await fetchImpl('/api/ai/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: args.query, ...(args.limit !== undefined ? { limit: args.limit } : {}) }),
        signal: options.signal,
      });
      const payload = await response.json().catch(() => null);
      const result = normalizeSearchToolResult(payload, response.ok, args.query, provider);
      searchActivity = { provider, status: result.ok ? 'ok' : 'failed' };
      return result;
    } catch (error) {
      searchActivity = { provider, status: 'failed' };
      return { ok: false, available: false, provider, query: args.query,
        error: error?.name === 'AbortError' ? 'SEARCH_CANCELLED' : 'SEARCH_CONNECTION_ERROR' };
    } finally {
      if (!destroyed) renderSearchStatus();
    }
  };
  let latestTerrainRoute = null;
  const runTerrainAnalysis = async (args = {}, options = {}) => {
    if (typeof workspace?.analyzeTerrain !== 'function') {
      return { ok: false, error: 'TERRAIN_UNAVAILABLE', message: '当前视口地形采样不可用' };
    }
    try {
      const result = await workspace.analyzeTerrain({
        rows: args.rows,
        cols: args.cols,
        signal: options.signal,
      });
      if (options.signal?.aborted || options.isCurrent?.() === false) return { ok: false, cancelled: true, error: 'TERRAIN_CANCELLED' };
      if (result?.ok === false) return result;
      latestTerrainResult = result;
      latestTerrainRoute = null;
      terrainUi?.render(result);
      if (!result?.stale) {
        if (typeof workspace.drawTerrainAnalysis === 'function') await workspace.drawTerrainAnalysis(result);
        else if (typeof workspace.drawTerrainOverlay === 'function') await workspace.drawTerrainOverlay(result);
      }
      return { ok: true, ...result, mapDrawn: !result?.stale, stale: Boolean(result?.stale) };
    } catch (error) {
      return { ok: false, error: error?.code || 'TERRAIN_UNAVAILABLE', message: '当前视口地形数据暂时不可用' };
    }
  };
  const runTerrainRoute = async (args = {}, options = {}) => {
    if (options.signal?.aborted) return { ok: false, cancelled: true, error: 'TERRAIN_CANCELLED' };
    try {
      if (!latestTerrainResult || latestTerrainResult.stale) {
        const analysis = await runTerrainAnalysis({}, options);
        if (!analysis?.ok) return analysis;
      }
      const result = planTerrainRoute(latestTerrainResult, args.start, args.end, { maxSlopeDeg: args.maxSlopeDeg });
      if (!result.feasible) return { ok: false, error: 'TERRAIN_ROUTE_INFEASIBLE', ...result };
      latestTerrainRoute = result;
      return { ok: true, ...result, mapDrawn: false, nextAction: 'Use annotate_map with ALL returned points, including elevation and slopeDeg, unchanged after confirmation. Use a short label. The map colors segments by slope and shows every waypoint; these are sampled terrain grades, not road access guarantees.' };
    } catch (error) {
      return { ok: false, error: error?.code || 'TERRAIN_ROUTE_UNAVAILABLE', message: '当前视口无法生成地形路线' };
    }
  };
  const guard = createActionGuard({
    runAction: createViewStatisticsRunner({
      runAction: (name, args, options) => name === 'detect_viewport'
        ? vision.run(args, options)
        : name === 'detect_buildings' ? runBuildingRecognition(args, options)
        : name === 'web_search' ? runWebSearch(args, options)
          : name === 'analyze_terrain' ? runTerrainAnalysis(args, options)
            : name === 'plan_terrain_route' ? runTerrainRoute(args, options)
            : runAction(name, name === 'annotate_map' ? restorePlannedRouteGrades(args, latestTerrainRoute) : args, options), workspace,
    }),
    captureState: workspace?.captureState,
    restoreState: workspace?.restoreState,
    onChange(next) {
      if (destroyed) return;
      const wasWaiting = Boolean(actionState.pending);
      actionState = next;
      intelligenceUi?.renderAction(next);
      if (wasWaiting !== Boolean(next.pending)) notify({ type: 'confirmation', waiting: Boolean(next.pending) });
      if (next.pending && !dialog.open) open('conversation', { focus: false });
      renderControls();
    },
  });
  const conversation = createLlmConversation({
    runAction: guard.runAction,
    getContext: async () => ({ intelligence: await getViewStatistics(workspace), vision: vision.getContext() }),
    fetchImpl,
    getLocale,
    onMessage(message) {
      if (destroyed) return;
      const follow = nearBottom();
      const next = { ...message, id: message.id || `message_${++messageSequence}` };
      const exists = messages.some((entry) => entry.id === next.id);
      if (!messages.length && !voiceDraft) elements.messages.replaceChildren();
      messages = exists ? messages.map((entry) => entry.id === next.id ? next : entry) : [...messages, next];
      renderMessage(next);
      if (follow) elements.messages.scrollTop = elements.messages.scrollHeight;
      if (message.role === 'assistant') notify({ type: 'reply', ...next });
    },
    onState(next) {
      if (destroyed) return;
      phase = next;
      if (next !== 'error') notices = { ...notices, conversation: null };
      renderControls();
    },
  });

  async function requestJson(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    controllers = [...controllers, controller];
    const timeout = setTimeout(() => controller.abort(), 65000);
    try {
      const response = await fetchImpl(path, {
        method, signal: controller.signal,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      if (!response.ok || data?.error) {
        throw Object.assign(new Error('AI request failed'), { status: response.status, code: data?.code });
      }
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') throw Object.assign(new Error('Request timed out'), { code: 'LLM_TIMEOUT' });
      if (error instanceof TypeError) throw Object.assign(new Error('Network unavailable'), { code: 'LLM_NETWORK' });
      throw error;
    } finally {
      clearTimeout(timeout);
      controllers = controllers.filter((entry) => entry !== controller);
    }
  }

  async function requestVoiceprint(path, { method = 'GET', file, profileId, threshold } = {}) {
    const form = method === 'POST' ? new FormData() : null;
    if (form) {
      if (file) form.append('file', file, file.name || 'voice-sample.webm');
      if (profileId) form.append('profile_id', profileId);
      if (threshold !== undefined) form.append('threshold', String(threshold));
    }
    const controller = new AbortController();
    controllers = [...controllers, controller];
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetchImpl(path, { method, signal: controller.signal, ...(form ? { body: form } : {}) });
      const data = await response.json();
      if (!response.ok || data?.error) {
        const nested = data?.error;
        throw Object.assign(new Error('Voiceprint request failed'), {
          status: response.status,
          code: nested?.code || data?.code,
        });
      }
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') throw Object.assign(new Error('Voiceprint request timed out'), { code: 'VOICEPRINT_TIMEOUT' });
      if (error instanceof TypeError) throw Object.assign(new Error('Voiceprint service unavailable'), { code: 'VOICEPRINT_UNAVAILABLE' });
      throw error;
    } finally {
      clearTimeout(timeout);
      controllers = controllers.filter((entry) => entry !== controller);
    }
  }

  async function loadVoiceprintStatus() {
    try {
      const data = await requestVoiceprint('/api/ai/voiceprint/status');
      if (!destroyed && data && typeof data === 'object') {
        voiceprint = {
          available: Boolean(data.available), enabled: Boolean(data.enabled),
          mode: data.mode === 'enforce' ? 'enforce' : 'observe',
          profile: typeof data.profile === 'string' ? data.profile : '',
          threshold: Math.min(0.8, Math.max(0.05, Number(data.threshold ?? config?.speech?.voiceprint?.threshold) || 0.25)),
          profiles: Array.isArray(data.profiles) ? data.profiles : [],
        };
        if (elements['voiceprint-enabled']) elements['voiceprint-enabled'].checked = voiceprint.enabled;
        if (elements['voiceprint-mode']) elements['voiceprint-mode'].value = voiceprint.mode;
        if (elements['voiceprint-profile'] && voiceprint.profile) elements['voiceprint-profile'].value = voiceprint.profile;
        if (elements['voiceprint-threshold']) elements['voiceprint-threshold'].value = String(voiceprint.threshold);
        renderVoiceprintControls();
      }
      return voiceprint;
    } catch {
      voiceprint = { ...voiceprint, available: false, profiles: [] };
      if (!destroyed) renderVoiceprintControls();
      return voiceprint;
    }
  }

  async function voiceprintAction(action) {
    if (destroyed || voiceprintBusy || voiceprintRecording || settingsBusy || isRunning() || !voiceprint.available) return;
    const profileId = String(elements['voiceprint-profile'].value || '').trim();
    const file = elements['voiceprint-audio'].files?.[0] || voiceprintSampleFile;
    if (action !== 'delete' && !file) return;
    if ((action === 'enroll' || action === 'delete') && !profileId) return;
    voiceprintBusy = true;
    renderControls();
    try {
      const path = action === 'enroll' ? '/api/ai/voiceprint/enroll'
        : action === 'verify' ? '/api/ai/voiceprint/verify'
          : `/api/ai/voiceprint/profiles/${encodeURIComponent(profileId)}`;
      const data = await requestVoiceprint(path, {
        method: action === 'delete' ? 'DELETE' : 'POST', file, profileId,
        threshold: Number(elements['voiceprint-threshold'].value || 0.25),
      });
      if (action === 'verify') {
        setNotice('settings', data.verified ? 'ai.voiceprint.verified' : 'ai.voiceprint.rejected', {}, !data.verified);
      } else {
        setNotice('settings', action === 'enroll' ? 'ai.voiceprint.enrolled' : 'ai.voiceprint.deleted');
        await loadVoiceprintStatus();
      }
    } catch (error) {
      showError('settings', error, 'ai.voiceprint.error.generic');
    } finally {
      voiceprintBusy = false;
      if (!destroyed) renderControls();
    }
  }

  async function loadConfig() {
    if (configLoading || destroyed) return;
    configLoading = true;
    setNotice('settings', 'ai.loading');
    try {
      const data = await requestJson('/api/ai/config');
      if (destroyed) return;
      if (!Array.isArray(data?.providers) || !data.providers.some((entry) => entry.id === data.provider)) {
        throw new Error('Invalid public configuration');
      }
      config = data;
      elements.provider.replaceChildren(...config.providers.map((provider) => {
        const option = documentRef.createElement('option');
        option.value = provider.id;
        option.textContent = providerLabel(provider);
        return option;
      }));
      elements.provider.value = config.provider;
      elements.model.value = config.model;
      elements['base-url'].value = config.baseUrl;
      elements['api-key'].value = '';
      const search = config.search || {};
      searchActivity = null;
      if (diagnostics) diagnostics = { ...diagnostics, search: null };
      searchMode = search.provider || 'firecrawl';
      searchDrafts = Object.fromEntries(Object.entries(SEARCH_DEFAULTS).map(([provider, defaultUrl]) => [provider, {
        baseUrl: provider === searchMode ? search.baseUrl || '' : search[provider === 'agent-pro' ? 'agentPro' : 'firecrawl']?.baseUrl || defaultUrl,
      }]));
      if (elements['search-provider']) elements['search-provider'].value = search.provider || 'firecrawl';
      if (elements['search-base-url']) elements['search-base-url'].value = search.baseUrl || search[search.provider || 'firecrawl']?.baseUrl || '';
      if (elements['search-api-key']) elements['search-api-key'].value = '';
      const custom = savedCustomSpeech(config);
      speechDrafts = {
        current: { model: config.speech?.model || 'whisper-1' },
        custom: { model: custom.model || 'whisper-1', baseUrl: custom.baseUrl || '' },
      };
      speechMode = config.speech?.provider || 'browser';
      elements['speech-provider'].value = speechMode;
      elements['speech-model'].value = speechMode === 'current' ? speechDrafts.current.model : speechDrafts.custom.model;
      elements['speech-base-url'].value = speechDrafts.custom.baseUrl;
      elements['speech-api-key'].value = '';
      notices = { ...notices, settings: null };
      notify({ type: 'config', config });
      void loadVoiceprintStatus();
      return config;
    } catch (error) {
      if (!destroyed) showError('settings', error);
    } finally {
      configLoading = false;
      if (!destroyed) renderControls();
    }
  }

  function selectTab(name, focus = true) {
    if (!TABS.includes(name)) return;
    selectedTab = name;
    for (const tab of TABS) {
      const selected = tab === name;
      elements[`tab-${tab}`].setAttribute('aria-selected', String(selected));
      elements[`tab-${tab}`].tabIndex = selected ? 0 : -1;
      elements[`${tab}-panel`].hidden = !selected;
    }
    if (name === 'intelligence' || name === 'watch') void intelligenceUi?.refresh();
    if (name === 'settings') {
      void refreshDiagnostics();
      void refreshSearchStatus();
    }
    if (focus) elements[`tab-${name}`].focus();
  }

  function open(tab = undefined, { focus = true } = {}) {
    if (destroyed) return;
    const previousFocus = documentRef.activeElement;
    selectTab(tab || (config?.configured ? selectedTab : 'settings'), false);
    dialog.setAttribute('aria-modal', 'false');
    if (!dialog.open) dialog.show();
    toggle.setAttribute('aria-expanded', 'true');
    if (!config) void loadConfig();
    if (focus) (selectedTab === 'conversation' ? elements.message : selectedTab === 'settings' ? elements.provider : elements[`tab-${selectedTab}`]).focus();
    else previousFocus?.focus?.({ preventScroll: true });
  }

  async function sendText(text, options) {
    if (destroyed) throw Object.assign(new Error('Assistant destroyed'), { code: 'LLM_CANCELLED' });
    open('conversation', { focus: false });
    notices = { ...notices, conversation: null };
    const requestId = ++sendSequence;
    try {
      if (!config?.configured) throw Object.assign(new Error('Model not configured'), { code: 'LLM_NOT_CONFIGURED' });
      if (settingsBusy || visionBusy || actionState.pending || actionState.executing) throw Object.assign(new Error('Assistant is busy'), { code: 'LLM_BUSY' });
      return await conversation.send(text, options);
    } catch (error) {
      if (!destroyed && requestId === sendSequence) showError('conversation', error);
      throw error;
    } finally { if (!destroyed) renderControls(); }
  }

  async function send(event) {
    event.preventDefault();
    const text = elements.message.value.trim();
    if (!text || isRunning() || settingsBusy || !config?.configured) return;
    elements.message.value = '';
    notices = { ...notices, conversation: null };
    try {
      await sendText(text);
    } catch {
      // sendText renders the localized failure for both typed and spoken input.
    } finally {
      if (!destroyed) {
        renderControls();
        if (dialog.open && selectedTab === 'conversation') elements.message.focus();
      }
    }
  }

  async function save(event) {
    event.preventDefault();
    if (!config || settingsBusy || isRunning() || !elements['settings-form'].reportValidity()) return;
    let payload;
    try { payload = buildAiSettingsPayload(config, readDraft()); }
    catch (error) { showError('settings', error); return; }
    cancel();
    settingsBusy = true;
    setNotice('settings', 'ai.saving');
    renderControls();
    try {
      await requestJson('/api/setup/keys', { method: 'POST', body: payload });
      if (destroyed) return;
      elements['api-key'].value = '';
      elements['speech-api-key'].value = '';
      elements['search-api-key'].value = '';
      try { globalThis.sessionStorage?.setItem('gev:ai:reopen', 'settings'); } catch { /* Storage is optional. */ }
      setNotice('settings', 'ai.saved');
      // Credential readiness is authoritative only after a fresh server read.
      config = null;
      await loadConfig();
      if (config && !destroyed) setNotice('settings', 'ai.savedComplete');
    } catch (error) {
      if (!destroyed) showError('settings', error, 'ai.error.save');
    } finally {
      settingsBusy = false;
      if (!destroyed) renderControls();
    }
  }

  async function testConnection() {
    if (!config?.configured || settingsBusy || isRunning() || aiSettingsAreDirty(config, readDraft())) return;
    settingsBusy = true;
    setNotice('settings', 'ai.testing');
    renderControls();
    try {
      const data = await requestJson('/api/ai/test', { method: 'POST', body: {} });
      if (!data?.ok) throw new Error('Connection test failed');
      if (!destroyed) setNotice('settings', 'ai.testPassed', { provider: providerLabel(selectedProvider()), model: data.model || config.model });
    } catch (error) {
      if (!destroyed) showError('settings', error, 'ai.error.test');
    } finally {
      settingsBusy = false;
      if (!destroyed) renderControls();
    }
  }

  on(toggle, 'click', () => { if (dialog.open) dialog.close(); else open(); });
  on(elements['assistant-close'], 'click', () => dialog.close());
  on(dialog, 'close', () => {
    cancel();
    stopVoiceprintRecording({ discard: true });
    elements['api-key'].value = '';
    elements['speech-api-key'].value = '';
    elements['search-api-key'].value = '';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus();
    renderControls();
  });
  on(dialog, 'keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape' && !event.isComposing) {
      event.preventDefault();
      dialog.close();
    }
  });
  for (const tab of TABS) {
    on(elements[`tab-${tab}`], 'click', () => selectTab(tab));
    on(elements[`tab-${tab}`], 'keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = TABS.indexOf(tab);
      selectTab(event.key === 'Home' ? TABS[0] : event.key === 'End' ? TABS.at(-1)
        : TABS[(index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length]);
    });
  }
  on(elements.provider, 'change', () => {
    const provider = selectedProvider();
    if (!provider) return;
    const active = provider.id === config.provider;
    elements.model.value = active ? config.model : provider.defaultModel;
    elements['base-url'].value = active ? config.baseUrl : provider.baseUrl;
    elements['api-key'].value = '';
    setNotice('settings', aiSettingsAreDirty(config, readDraft()) ? 'ai.dirty' : 'ai.ready');
    renderControls();
  });
  on(elements['speech-provider'], 'change', () => {
    if (speechMode === 'current') {
      speechDrafts = { ...speechDrafts, current: { model: elements['speech-model'].value } };
    } else if (speechMode === 'custom') {
      speechDrafts = { ...speechDrafts, custom: {
        model: elements['speech-model'].value, baseUrl: elements['speech-base-url'].value,
      } };
    }
    speechMode = elements['speech-provider'].value;
    elements['speech-model'].value = speechMode === 'current' ? speechDrafts.current.model : speechDrafts.custom.model;
    elements['speech-base-url'].value = speechDrafts.custom.baseUrl;
    elements['speech-api-key'].value = '';
    setNotice('settings', aiSettingsAreDirty(config, readDraft()) ? 'ai.dirty' : 'ai.ready');
    renderControls();
  });
  on(elements['settings-form'], 'input', () => {
    setNotice('settings', aiSettingsAreDirty(config, readDraft()) ? 'ai.dirty' : 'ai.ready');
    renderControls();
  });
  on(elements['search-refresh'], 'click', () => { void refreshSearchStatus(); });
  on(elements['search-provider'], 'change', () => {
    const provider = elements['search-provider'].value === 'agent-pro' ? 'agent-pro' : 'firecrawl';
    searchDrafts = { ...searchDrafts, [searchMode]: { baseUrl: elements['search-base-url'].value } };
    searchMode = provider;
    elements['search-base-url'].value = searchDrafts[provider]?.baseUrl || SEARCH_DEFAULTS[provider];
    elements['search-api-key'].value = '';
    renderSearchStatus();
    setNotice('settings', aiSettingsAreDirty(config, readDraft()) ? 'ai.dirty' : 'ai.ready');
    renderControls();
  });
  on(elements['settings-form'], 'submit', (event) => { void save(event); });
  on(elements['voiceprint-profile'], 'input', renderVoiceprintControls);
  on(elements['voiceprint-enabled'], 'change', () => {
    voiceprint = { ...voiceprint, enabled: Boolean(elements['voiceprint-enabled'].checked) };
    setNotice('settings', aiSettingsAreDirty(config, readDraft()) ? 'ai.dirty' : 'ai.ready');
    renderControls();
  });
  on(elements['voiceprint-mode'], 'change', () => {
    voiceprint = { ...voiceprint, mode: elements['voiceprint-mode'].value === 'enforce' ? 'enforce' : 'observe' };
    setNotice('settings', aiSettingsAreDirty(config, readDraft()) ? 'ai.dirty' : 'ai.ready');
    renderControls();
  });
  on(elements['voiceprint-threshold'], 'input', renderVoiceprintControls);
  on(elements['voiceprint-audio'], 'change', () => {
    voiceprintSampleFile = null;
    elements['voiceprint-record-status'].textContent = '';
    renderVoiceprintControls();
  });
  on(elements['voiceprint-record'], 'click', () => { void toggleVoiceprintRecording(); });
  on(elements['voiceprint-enroll'], 'click', () => { void voiceprintAction('enroll'); });
  on(elements['voiceprint-verify'], 'click', () => { void voiceprintAction('verify'); });
  on(elements['voiceprint-delete'], 'click', () => { void voiceprintAction('delete'); });
  on(elements['diagnostics-refresh'], 'click', () => { void refreshDiagnostics(); });
  on(elements.test, 'click', () => { void testConnection(); });
  on(elements['message-form'], 'submit', (event) => { void send(event); });
  function normalizeComposer(event) {
    if (!event?.isComposing) {
      const input = elements.message;
      const normalized = normalizeChineseText(input.value, getLocale());
      if (normalized !== input.value) {
        const start = input.selectionStart;
        const end = input.selectionEnd;
        input.value = normalized;
        if (typeof start === 'number') input.setSelectionRange?.(start, end);
      }
    }
    renderControls();
  }
  on(elements.message, 'input', normalizeComposer);
  on(elements.message, 'compositionend', normalizeComposer);
  on(elements.message, 'keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      elements['message-form'].requestSubmit();
    }
  });
  on(elements.stop, 'click', cancel);
  on(elements.clear, 'click', () => {
    cancel();
    conversation.clear();
    vision.clear();
    visionUi?.clear();
    messages = [];
    voiceDraft = '';
    notices = { ...notices, conversation: null };
    renderMessages();
    renderControls();
  });
  const unsubscribe = subscribeLocale(() => {
    translateDocument(dialog);
    for (const option of elements.provider.options) {
      option.textContent = providerLabel(config?.providers.find((entry) => entry.id === option.value));
    }
    renderMessages();
    renderControls();
  });
  function destroy() {
    if (destroyed) return;
    cancel();
    stopVoiceprintRecording({ discard: true });
    notify({ type: 'destroy' });
    destroyed = true;
    intelligenceUi?.destroy();
    visionUi?.destroy();
    terrainUi?.destroy();
    vision.destroy();
    guard.destroy();
    conversation.destroy();
    controllers.forEach((controller) => controller.abort());
    cleanups.forEach((cleanup) => cleanup());
    unsubscribe();
    elements['api-key'].value = '';
    elements['speech-api-key'].value = '';
    elements['search-api-key'].value = '';
    subscribers = [];
    if (dialog.open) dialog.close();
  }
  if (documentRef.defaultView?.addEventListener) on(documentRef.defaultView, 'pagehide', destroy);
  visionUi = initVisionUi({
    documentRef,
    onScan: async (options) => {
      if (destroyed || isRunning() || settingsBusy) return;
      open('conversation', { focus: false });
      await guard.runAction('detect_viewport', options);
    },
    onCancel: cancel,
    onAsk: () => sendText('我看到了什么？请按类别统计当前画面中的目标，并说明置信度和不确定性。'),
  });
  if (workspace) intelligenceUi = initIntelligenceUi({
    documentRef, guard, getSnapshot: workspace.getSnapshot, getViewSnapshot: workspace.getViewSnapshot, sendText, beforeUndo: cancel,
    drawComparison: workspace.drawSnapshotComparison,
    openConversation: () => open('conversation'),
  });
  if (workspace) terrainUi = initTerrainUi({
    documentRef,
    getViewSnapshot: workspace.getViewSnapshot,
    analyzeTerrain: typeof workspace.analyzeTerrain === 'function' ? async (args) => {
      const result = await workspace.analyzeTerrain(args);
      latestTerrainResult = result;
      return result;
    } : undefined,
    onDraw: async (result) => {
      if (typeof workspace.drawTerrainAnalysis === 'function') await workspace.drawTerrainAnalysis(result);
      else if (typeof workspace.drawTerrainOverlay === 'function') await workspace.drawTerrainOverlay(result);
    },
  });
  selectTab('conversation', false);
  renderControls();
  const initialReady = loadConfig();
  try {
    if (globalThis.sessionStorage?.getItem('gev:ai:reopen') === 'settings') {
      globalThis.sessionStorage.removeItem('gev:ai:reopen');
      open('settings');
    }
  } catch { /* Storage is optional. */ }
  return Object.freeze({
    open,
    close: () => dialog.close(),
    getConfig: () => config,
    ready: async () => { await initialReady; return config; },
    sendText,
    setVoiceDraft,
    runMapAction: guard.runAction,
    renderTerrainAnalysis: (result) => terrainUi?.render(result),
    cancel,
    subscribe(listener) {
      if (typeof listener !== 'function' || destroyed) return () => {};
      subscribers = [...subscribers, listener];
      if (config) listener({ type: 'config', config });
      return () => { subscribers = subscribers.filter((entry) => entry !== listener); };
    },
    destroy,
  });
}
