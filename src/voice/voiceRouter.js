import { getLocale, subscribeLocale, t } from '../i18n.js';

const CAPTURING = new Set(['requesting', 'connecting', 'listening']);
const PLAYBACK_STORAGE_KEY = 'gev-voice-playback-enabled';
const STATUS = Object.freeze({
  requesting: 'connecting', connecting: 'connecting', listening: 'listening', transcribing: 'executing',
  thinking: 'executing', confirming: 'executing', speaking: 'listening', idle: 'idle', error: 'error',
});

/** One dock owns either the selected-model speech bridge or explicit Realtime. */
export function initVoiceRouter({
  assistant, realtime, ui, createSpeech, canPushToTalk, isPushToTalk,
  documentRef = globalThis.document, windowRef = globalThis.window,
  storage,
}) {
  let playbackEnabled = true;
  let playbackStorage = storage;
  try {
    if (playbackStorage === undefined) playbackStorage = windowRef?.localStorage;
    playbackEnabled = playbackStorage?.getItem(PLAYBACK_STORAGE_KEY) !== 'false';
  } catch { console.warn('[Voice] Playback preference unavailable; using session-only settings.'); }
  const playbackButtons = ['ai-playback-toggle', 'voice-playback-toggle']
    .map((id) => documentRef?.getElementById?.(id)).filter(Boolean);
  let config = assistant.getConfig();
  let mode = config?.speech?.provider || 'browser';
  let state = 'idle';
  let errorCode = null;
  let pending = false;
  let held = false;
  let ptt = false;
  let epoch = 0;
  let destroyed = false;
  let stopping = false;
  const realtimeActive = () => mode === 'realtime' && realtime.isActive();
  const cleanups = [];
  const on = (host, event, fn) => {
    host?.addEventListener(event, fn);
    cleanups.push(() => host?.removeEventListener(event, fn));
  };

  function errorText(code) {
    const key = `ai.speech.error.${code}`;
    const translated = t(key);
    return translated === key ? t('ai.speech.error.fallback') : translated;
  }

  function renderPlayback() {
    for (const button of playbackButtons) {
      button.setAttribute('aria-checked', String(playbackEnabled));
      button.setAttribute('aria-label', t('ai.speech.playback'));
      button.title = t(playbackEnabled ? 'ai.speech.disablePlayback' : 'ai.speech.enablePlayback');
      const icon = button.querySelector('.material-symbols-outlined');
      if (icon) icon.textContent = playbackEnabled ? 'volume_up' : 'volume_off';
    }
  }

  function setPlaybackEnabled(enabled, persist = true) {
    if (destroyed || typeof enabled !== 'boolean') return;
    playbackEnabled = enabled;
    speech.setPlaybackEnabled?.(enabled);
    realtime.setPlaybackEnabled?.(enabled);
    if (persist) {
      try { playbackStorage?.setItem(PLAYBACK_STORAGE_KEY, String(enabled)); }
      catch { console.warn('[Voice] Playback preference could not be saved; this session is still updated.'); }
    }
    renderPlayback();
  }

  function render() {
    if (destroyed) return;
    renderPlayback();
    const legacy = mode === 'realtime';
    ui.root.dataset.engine = legacy ? 'realtime' : 'llm';
    for (const element of [ui.tierButton, ui.costValue]) {
      if (element) element.hidden = !legacy;
    }
    const hint = ui.root.querySelector('.gev-voice-error-hint');
    if (hint) hint.textContent = t(legacy ? 'voice.errorHint' : 'ai.speech.errorHint');
    if (ui.settingsButton) {
      ui.settingsButton.setAttribute('aria-label', t('ai.speech.settings'));
      ui.settingsButton.title = t('ai.speech.settings');
    }
    if (legacy) {
      realtime.syncCostUi();
      ui.button.setAttribute('aria-label', t('voice.controlAria'));
      ui.button.setAttribute('aria-pressed', String(realtimeActive()));
      ui.root.dataset.status = errorCode ? 'error' : (STATUS[state] || 'idle');
      if (errorCode) realtime.setStatus('error', errorText(errorCode));
      return;
    }
    const detail = errorCode ? errorText(errorCode) : t(`ai.speech.state.${state}`);
    // Displaying a bridge state must not activate the legacy transport lifecycle.
    ui.root.dataset.status = STATUS[state] || 'idle';
    if (state === 'error') ui.root.classList.remove('error-dismissed');
    if (ui.status) ui.status.textContent = t(`voice.status${({ requesting: 'Connecting', connecting: 'Connecting', listening: 'Listening', transcribing: 'Executing', thinking: 'Executing', confirming: 'Executing', speaking: 'Listening', error: 'Error' })[state] || 'Off'}`);
    ui.detail.textContent = state === 'error' ? t('voice.voiceUnavailable') : detail;
    if (ui.errorDetail) ui.errorDetail.textContent = state === 'error' ? detail : '';
    if (ui.buttonLabel) ui.buttonLabel.textContent = t('voice.micShort');
    realtime.setVoiceSpeaker(state === 'listening' ? 'user' : state === 'speaking' ? 'ai' : 'idle');
    ui.button.setAttribute('aria-pressed', String(pending || speech.isActive()));
    ui.button.setAttribute('aria-label', t('ai.speech.hint'));
    if (ui.helpDetail) ui.helpDetail.textContent = t('ai.speech.hint');
    ui.detail.title = config?.model ? `${detail} / ${config.model}` : detail;
  }

  const speech = createSpeech({
    getConfig: () => assistant.ready(),
    getLocale,
    sendText: (text) => assistant.sendText(text),
    cancelText: () => assistant.cancel(),
    onTranscript(text, { final = false } = {}) {
      if (!destroyed && mode !== 'realtime') assistant.setVoiceDraft?.(final ? '' : text);
    },
    onState(next) {
      if (destroyed || mode === 'realtime') return;
      state = next;
      if (next !== 'error') errorCode = null;
      if (next === 'idle' || next === 'error') {
        assistant.setVoiceDraft?.('');
        pending = false;
        realtime.setRadioVoiceDucking(false);
      }
      render();
    },
    onError(code) {
      if (destroyed) return;
      assistant.setVoiceDraft?.('');
      errorCode = typeof code === 'string' ? code : code?.code;
      state = 'error';
      realtime.setRadioVoiceDucking(false);
      render();
    },
  });

  function stop(options = {}) {
    if (stopping || destroyed) return;
    if (options.removeUi) { destroy(); return; }
    stopping = true;
    epoch += 1;
    pending = false;
    held = false;
    ptt = false;
    speech.stop();
    realtime.stop();
    delete ui.root.dataset.pushToTalk;
    state = 'idle';
    errorCode = null;
    stopping = false;
    render();
  }

  async function start({ pushToTalk = false } = {}) {
    if (destroyed || pending || speech.isActive() || realtimeActive()) return;
    const generation = ++epoch;
    ptt = pushToTalk;
    pending = true;
    state = 'requesting';
    errorCode = null;
    render();
    try {
      const next = await assistant.ready();
      if (destroyed || generation !== epoch || (pushToTalk && !held)) return;
      config = next;
      mode = config?.speech?.provider || 'browser';
      if (config?.speech?.voiceprint?.enabled && (mode === 'browser' || mode === 'realtime')) {
        errorCode = 'VOICEPRINT_UNSUPPORTED_PROVIDER';
        state = 'error';
        assistant.open('settings');
        return;
      }
      if (!(mode === 'realtime' ? config?.voice?.configured : config?.configured)) {
        errorCode = mode === 'realtime' ? 'VOICE_REALTIME_NOT_CONFIGURED' : 'VOICE_LLM_NOT_CONFIGURED';
        state = 'error';
        assistant.open('settings');
        return;
      }
      realtime.pauseRadioForVoice();
      if (mode === 'realtime') {
        realtime.pushToTalkKeyHeld = pushToTalk && held;
        realtime.spaceKeyHeld = held;
        await realtime.start({ pushToTalk });
      } else {
        await speech.start({ pushToTalk });
      }
    } catch {
      if (generation === epoch && !destroyed) {
        errorCode = 'VOICE_NETWORK';
        state = 'error';
      }
    } finally {
      if (generation === epoch && !destroyed) { pending = false; render(); }
    }
  }

  function finish() {
    if (destroyed) return;
    if (pending && !speech.isActive() && !realtimeActive()) { stop(); return; }
    if (mode === 'realtime') realtime.releasePushToTalkKey();
    else speech.finish();
    delete ui.root.dataset.pushToTalk;
  }

  function click() {
    if (held || destroyed) return;
    if (mode === 'realtime' && realtime.isActive()) { stop(); return; }
    if (pending || speech.isActive()) {
      if (CAPTURING.has(state)) finish();
      else stop();
    } else { void start(); }
  }

  on(ui.button, 'click', click);
  for (const button of playbackButtons) on(button, 'click', () => setPlaybackEnabled(!playbackEnabled));
  on(windowRef, 'storage', (event) => {
    if (event.storageArea !== playbackStorage || event.key !== PLAYBACK_STORAGE_KEY) return;
    if (event.newValue === 'true' || event.newValue === 'false') setPlaybackEnabled(event.newValue === 'true', false);
  });
  on(ui.settingsButton, 'click', () => { stop(); assistant.open('settings'); });
  on(ui.tierButton, 'click', () => { if (mode === 'realtime') realtime.toggleVoiceTier(); });
  on(documentRef, 'keydown', (event) => {
    if (!canPushToTalk(event)) return;
    if (event.repeat) { if (held) event.preventDefault(); return; }
    event.preventDefault();
    held = true;
    if ((pending || speech.isActive() || realtimeActive()) && !ptt) return;
    if (mode === 'realtime' && realtime.isActive()) {
      realtime.pushToTalkKeyHeld = true;
      realtime.setMicrophoneEnabled(true);
    } else if (!speech.isActive() && !pending) { void start({ pushToTalk: true }); }
    ui.root.dataset.pushToTalk = 'held';
  });
  on(documentRef, 'keyup', (event) => {
    if (!isPushToTalk(event) || !held) return;
    event.preventDefault();
    held = false;
    if (ptt) finish();
  });
  on(windowRef, 'blur', () => {
    // A microphone permission prompt can temporarily take focus from a visible page.
    if (state === 'requesting' && speech.isActive() && !ptt && mode !== 'realtime' && documentRef.visibilityState !== 'hidden') return;
    stop();
  });
  on(documentRef, 'visibilitychange', () => { if (documentRef.visibilityState === 'hidden') stop(); });
  on(windowRef, 'pagehide', () => destroy());
  cleanups.push(assistant.subscribe((event) => {
    if (destroyed) return;
    if (event.type === 'destroy') { destroy(); return; }
    if (event.type === 'cancel') { stop(); return; }
    if (event.type === 'voiceDraftEdit') { stop(); return; }
    if (event.type === 'confirmation') { speech.setAwaitingConfirmation?.(event.waiting); return; }
    if (event.type === 'reply') { speech.receiveReply?.(event); return; }
    if (event.type === 'config') {
      if (config) stop();
      config = event.config;
      mode = config?.speech?.provider || 'browser';
      render();
    }
  }));
  cleanups.push(subscribeLocale(render));

  function destroy() {
    if (destroyed) return;
    stop();
    destroyed = true;
    cleanups.forEach((cleanup) => cleanup());
    speech.destroy();
    realtime.stop({ removeUi: true });
  }

  setPlaybackEnabled(playbackEnabled, false);
  render();
  return Object.freeze({
    start, finish, stop, destroy,
    isActive: () => !destroyed && (pending || speech.isActive() || realtimeActive()),
  });
}
