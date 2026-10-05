import test from 'node:test';
import assert from 'node:assert/strict';
import { initVoiceRouter } from './voiceRouter.js';
import { createLlmSpeechController } from './llmSpeech.js';
import { getLocale, setLocale, t } from '../i18n.js';
import { readFile } from 'node:fs/promises';

function target() {
  const handlers = new Map();
  return {
    dataset: {}, classList: { remove() {} }, hidden: false, textContent: '',
    addEventListener(name, fn) { handlers.set(name, [...(handlers.get(name) || []), fn]); },
    removeEventListener(name, fn) { handlers.set(name, (handlers.get(name) || []).filter((f) => f !== fn)); },
    emit(name, event = {}) { for (const fn of handlers.get(name) || []) fn({ preventDefault() {}, ...event }); },
    setAttribute(name, value) { this[name] = value; },
    querySelector() { return null; },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ mode = 'browser', configured = true, ready, statusCoupled = false, initiallyEmpty = false, speechFactory, storage = null, canPushToTalk = (event) => event.code === 'Space' && !event.editing } = {}) {
  let config = initiallyEmpty ? null : { provider: 'custom', model: 'configured-model', configured, speech: { provider: mode }, voice: { configured } };
  let subscriber;
  const calls = [];
  const ui = Object.fromEntries(['root', 'button', 'tierButton', 'costValue', 'helpDetail', 'detail', 'status', 'errorDetail', 'buttonLabel', 'settingsButton'].map((name) => [name, target()]));
  const documentRef = target();
  const playbackButtons = [target(), target()];
  const playbackIcons = [target(), target()];
  playbackButtons.forEach((button, index) => { button.querySelector = () => playbackIcons[index]; });
  documentRef.getElementById = (id) => ({ 'ai-playback-toggle': playbackButtons[0], 'voice-playback-toggle': playbackButtons[1] })[id] ?? null;
  const windowRef = target();
  const realtime = {
    active: false, status: 'idle', start: async (options) => { calls.push(['realtime.start', options]); realtime.active = true; realtime.status = 'listening'; },
    isActive: () => statusCoupled ? !['idle', 'error'].includes(realtime.status) : realtime.active,
    stop(options) { calls.push(['realtime.stop', options]); this.active = false; this.status = 'idle'; },
    setStatus(...args) { realtime.status = args[0]; calls.push(['status', ...args]); },
    setVoiceSpeaker() {}, syncCostUi() {}, toggleVoiceTier() { calls.push(['tier']); },
    pauseRadioForVoice() {}, setRadioVoiceDucking() {},
    releasePushToTalkKey() { calls.push(['realtime.release']); },
    setMicrophoneEnabled() {},
    setPlaybackEnabled: (enabled) => calls.push(['realtime.playback', enabled]),
  };
  const assistant = {
    getConfig: () => config, ready: ready || (async () => config),
    sendText: async (text) => { calls.push(['text', text]); return 'answer'; },
    setVoiceDraft: (text) => calls.push(['draft', text]),
    cancel: () => { calls.push(['cancel']); subscriber?.({ type: 'cancel' }); },
    open: (tab) => calls.push(['open', tab]),
    subscribe: (fn) => { subscriber = fn; return () => { subscriber = null; }; },
  };
  let callbacks;
  const speech = {
    active: false,
    start: async (options) => { calls.push(['speech.start', options]); speech.active = true; callbacks.onState('listening'); },
    finish() { calls.push(['speech.finish']); callbacks.onState('thinking'); },
    stop() { calls.push(['speech.stop']); speech.active = false; callbacks.cancelText(); callbacks.onState('idle'); },
    destroy() { this.stop(); calls.push(['speech.destroy']); },
    isActive: () => speech.active,
    setAwaitingConfirmation: (waiting) => calls.push(['confirmation', waiting]),
    receiveReply: (event) => calls.push(['reply', event]),
    setPlaybackEnabled: (enabled) => calls.push(['speech.playback', enabled]),
  };
  const router = initVoiceRouter({
    assistant, realtime, ui, documentRef, windowRef, storage,
    createSpeech: (options) => { callbacks = options; return speechFactory ? speechFactory(options) : speech; },
    canPushToTalk,
    isPushToTalk: (event) => event.code === 'Space',
  });
  return { router, calls, ui, documentRef, windowRef, speech, realtime, playbackButtons, playbackIcons, callbacks: () => callbacks,
    changeConfig: (next) => { config = next; subscriber?.({ type: 'config', config }); },
    notify: (event) => subscriber?.(event) };
}

test('playback switches silence both engines without cancelling conversation or voice input', async () => {
  const writes = [];
  const f = fixture({ storage: { getItem: () => null, setItem: (...args) => writes.push(args) } });
  try {
    await f.router.start();
    const before = f.calls.length;
    f.playbackButtons[0].emit('click');
    assert.deepEqual(f.calls.slice(before), [['speech.playback', false], ['realtime.playback', false]]);
    assert.equal(f.router.isActive(), true);
    for (const [index, button] of f.playbackButtons.entries()) {
      assert.equal(button['aria-checked'], 'false');
      assert.equal(button['aria-label'], t('ai.speech.playback'));
      assert.equal(button.title, t('ai.speech.enablePlayback'));
      assert.equal(f.playbackIcons[index].textContent, 'volume_off');
    }
    assert.deepEqual(writes, [['gev-voice-playback-enabled', 'false']]);
    f.playbackButtons[1].emit('click');
    assert.equal(f.playbackButtons[0]['aria-checked'], 'true');
    assert.equal(f.playbackIcons[0].textContent, 'volume_up');
    assert.equal(f.playbackButtons[0].title, t('ai.speech.disablePlayback'));
  } finally { f.router.destroy(); }
});

test('saved mute survives initialization, mode changes and locale updates', () => {
  const previous = getLocale();
  const f = fixture({ storage: { getItem: () => 'false' } });
  try {
    assert.deepEqual(f.calls.filter(([name]) => name.endsWith('.playback')), [['speech.playback', false], ['realtime.playback', false]]);
    f.changeConfig({ configured: true, voice: { configured: true }, speech: { provider: 'realtime' } });
    setLocale('zh-CN', { persist: false });
    assert.equal(f.playbackButtons[1].title, '开启语音播报');
    assert.equal(f.playbackButtons[1]['aria-checked'], 'false');
    setLocale('en', { persist: false });
    assert.equal(f.playbackButtons[1].title, 'Enable spoken responses');
    assert.equal(f.playbackButtons[1]['aria-checked'], 'false');
  } finally { f.router.destroy(); setLocale(previous, { persist: false }); }
});

test('unavailable playback storage still allows toggling and destroy removes switch listeners', () => {
  const f = fixture({ storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
  assert.equal(f.playbackButtons[0]['aria-checked'], 'true');
  f.playbackButtons[0].emit('click');
  assert.equal(f.playbackButtons[0]['aria-checked'], 'false');
  f.router.destroy();
  const before = f.calls.length;
  f.playbackButtons[1].emit('click');
  assert.equal(f.calls.length, before);
});

test('playback preference changes in another tab update both controls without writing again', () => {
  const writes = [];
  const storage = { getItem: () => 'junk', setItem: (...args) => writes.push(args) };
  const f = fixture({ storage });
  try {
    assert.equal(f.playbackButtons[0]['aria-checked'], 'true');
    f.windowRef.emit('storage', { key: 'gev-voice-playback-enabled', newValue: 'false', storageArea: storage });
    assert.equal(f.playbackButtons[0]['aria-checked'], 'false');
    assert.deepEqual(writes, []);
    f.windowRef.emit('storage', { key: 'other', newValue: 'true', storageArea: storage });
    f.windowRef.emit('storage', { key: 'gev-voice-playback-enabled', newValue: 'invalid', storageArea: storage });
    assert.equal(f.playbackButtons[0]['aria-checked'], 'false');
  } finally { f.router.destroy(); }
});

test('Space on a focused playback switch does not start voice capture', () => {
  let f;
  f = fixture({
    canPushToTalk: (event) => event.code === 'Space' && event.target !== f.playbackButtons[0],
  });
  try {
    f.documentRef.emit('keydown', { code: 'Space', target: f.playbackButtons[0] });
    assert.equal(f.calls.some(([name]) => name === 'speech.start'), false);
    // The browser's native button activation remains responsible for the
    // switch; the router's click listener toggles it exactly once.
    f.playbackButtons[0].emit('click');
    assert.equal(f.playbackButtons[0]['aria-checked'], 'false');
    assert.equal(f.router.isActive(), false);
  } finally { f.router.destroy(); }
});

test('playback controls are persistent header and global toolbar switches', async () => {
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  for (const id of ['ai-playback-toggle', 'voice-playback-toggle']) {
    assert.match(html, new RegExp(`<button[^>]*id="${id}"[^>]*role="switch"[^>]*aria-checked="true"`));
  }
});

test('configured third-party model uses speech bridge, never OpenAI realtime', async () => {
  const f = fixture();
  try {
    f.ui.button.emit('click'); await settle();
    assert.equal(f.calls.filter(([name]) => name === 'speech.start').length, 1);
    assert.equal(f.calls.some(([name]) => name === 'realtime.start'), false);
    assert.equal(await f.callbacks().sendText('hello'), 'answer');
    assert.deepEqual(f.calls.find(([name]) => name === 'text'), ['text', 'hello']);
    assert.equal(f.ui.tierButton.hidden, true);
    f.ui.button.emit('click');
    assert.equal(f.calls.filter(([name]) => name === 'speech.finish').length, 1);
    f.ui.button.emit('click');
    assert.equal(f.router.isActive(), false);
  } finally { f.router.destroy(); }
});

test('enabled voiceprint blocks browser speech before microphone capture', async () => {
  const f = fixture();
  f.changeConfig({ configured: true, speech: { provider: 'browser', voiceprint: { enabled: true, mode: 'observe', profile: 'owner' } }, voice: { configured: true } });
  try {
    await f.router.start();
    assert.equal(f.calls.some(([name]) => name === 'speech.start'), false);
    assert.equal(f.calls.some(([name, tab]) => name === 'open' && tab === 'settings'), true);
    assert.equal(f.ui.root.dataset.status, 'error');
  } finally { f.router.destroy(); }
});

test('enabled voiceprint blocks realtime speech before legacy transport', async () => {
  const f = fixture({ mode: 'realtime' });
  f.changeConfig({ configured: true, speech: { provider: 'realtime', voiceprint: { enabled: true, mode: 'enforce', profile: 'owner' } }, voice: { configured: true } });
  try {
    await f.router.start();
    assert.equal(f.calls.some(([name]) => name === 'realtime.start'), false);
    assert.equal(f.calls.some(([name, tab]) => name === 'open' && tab === 'settings'), true);
    assert.equal(f.ui.root.dataset.status, 'error');
  } finally { f.router.destroy(); }
});

test('map confirmation events pause and resume the active voice model deadline', () => {
  const f = fixture();
  try {
    f.notify({ type: 'confirmation', waiting: true });
    f.notify({ type: 'confirmation', waiting: false });
    assert.deepEqual(f.calls.filter(([name]) => name === 'confirmation'), [['confirmation', true], ['confirmation', false]]);
    f.callbacks().onState('confirming');
    assert.equal(f.ui.root.dataset.status, 'executing');
    assert.notEqual(f.ui.status.textContent, 'Off');
  } finally { f.router.destroy(); }
});

test('transcription previews reach the separate assistant draft and final or cancelled turns clear it', () => {
  const f = fixture();
  try {
    assert.equal(typeof f.callbacks().onTranscript, 'function');
    f.callbacks().onTranscript('draft text', { final: false });
    assert.deepEqual(f.calls.at(-1), ['draft', 'draft text']);
    f.callbacks().onTranscript('final text', { final: true });
    assert.deepEqual(f.calls.at(-1), ['draft', '']);
    f.callbacks().onTranscript('next draft', { final: false });
    f.callbacks().onState('idle');
    assert.deepEqual(f.calls.filter(([name]) => name === 'draft').at(-1), ['draft', '']);
    assert.equal(f.calls.some(([name]) => name === 'text'), false);
  } finally { f.router.destroy(); }
});

test('assistant incremental reply events reach voice sentence playback', () => {
  const f = fixture();
  try {
    const event = { type: 'reply', id: 'one', content: 'One sentence.', streaming: true };
    f.notify(event);
    assert.deepEqual(f.calls.at(-1), ['reply', event]);
  } finally { f.router.destroy(); }
});

test('explicit realtime mode preserves legacy controller and key preflight', async () => {
  const f = fixture({ mode: 'realtime' });
  try {
    f.ui.button.emit('click'); await settle();
    assert.equal(f.calls.some(([name]) => name === 'realtime.start'), true);
    assert.equal(f.calls.some(([name]) => name === 'speech.start'), false);
    f.ui.tierButton.emit('click');
    assert.equal(f.calls.some(([name]) => name === 'tier'), true);
    f.ui.button.emit('click');
    assert.equal(f.realtime.active, false);
  } finally { f.router.destroy(); }
  const missing = fixture({ mode: 'realtime', configured: false });
  try {
    await missing.router.start();
    assert.equal(missing.calls.some(([name]) => name === 'realtime.start'), false);
    assert.equal(missing.calls.some(([name, tab]) => name === 'open' && tab === 'settings'), true);
  } finally { missing.router.destroy(); }
});

test('PTT ignores typing, finishes on release and ignores synthetic click while held', async () => {
  const f = fixture();
  try {
    f.documentRef.emit('keydown', { code: 'Space', editing: true }); await settle();
    assert.equal(f.calls.some(([name]) => name === 'speech.start'), false);
    f.documentRef.emit('keydown', { code: 'Space' }); await settle();
    f.ui.button.emit('click');
    f.documentRef.emit('keydown', { code: 'Space', repeat: true });
    assert.equal(f.calls.filter(([name]) => name === 'speech.start').length, 1);
    f.documentRef.emit('keyup', { code: 'Space', editing: true });
    assert.equal(f.calls.filter(([name]) => name === 'speech.finish').length, 1);
  } finally { f.router.destroy(); }
});

test('release or cancellation while config loads cannot leave microphone recording', async () => {
  let resolve;
  const f = fixture({ ready: () => new Promise((done) => { resolve = done; }) });
  try {
    f.documentRef.emit('keydown', { code: 'Space' });
    f.documentRef.emit('keyup', { code: 'Space' });
    resolve({ configured: true, speech: { provider: 'browser' } }); await settle();
    assert.equal(f.calls.some(([name]) => name === 'speech.start'), false);
    f.ui.button.emit('click'); f.router.stop();
    resolve({ configured: true, speech: { provider: 'browser' } }); await settle();
    assert.equal(f.calls.some(([name]) => name === 'speech.start'), false);
  } finally { f.router.destroy(); }
});

test('shared legacy status cannot wedge selected-model PTT released before config resolves', async () => {
  let resolve;
  const f = fixture({ statusCoupled: true, ready: () => new Promise((done) => { resolve = done; }) });
  try {
    f.documentRef.emit('keydown', { code: 'Space' });
    f.documentRef.emit('keyup', { code: 'Space' });
    resolve({ configured: true, speech: { provider: 'browser' } }); await settle();
    assert.equal(f.router.isActive(), false);
    f.ui.button.emit('click');
    resolve({ configured: true, speech: { provider: 'browser' } }); await settle();
    assert.equal(f.calls.filter(([name]) => name === 'speech.start').length, 1);
  } finally { f.router.destroy(); }
});

test('initial config hydration preserves a pending explicit microphone gesture', async () => {
  let resolve;
  const f = fixture({ initiallyEmpty: true, ready: () => new Promise((done) => { resolve = done; }) });
  try {
    f.ui.button.emit('click');
    const hydrated = { configured: true, speech: { provider: 'browser' } };
    f.changeConfig(hydrated);
    resolve(hydrated); await settle();
    assert.equal(f.calls.filter(([name]) => name === 'speech.start').length, 1);
  } finally { f.router.destroy(); }
});

test('router localizes speech and setup failures without starting the legacy path', async () => {
  const f = fixture();
  try {
    f.callbacks().onError('VOICE_PERMISSION');
    assert.equal(f.ui.root.dataset.status, 'error');
    f.callbacks().onError('UNEXPECTED_PROVIDER_SECRET');
    assert.equal(f.ui.detail.title.includes('UNEXPECTED_PROVIDER_SECRET'), false);
  } finally { f.router.destroy(); }
  const broken = fixture({ ready: async () => { throw new TypeError('offline'); } });
  try {
    await broken.router.start();
    assert.equal(broken.ui.root.dataset.status, 'error');
    assert.equal(broken.router.isActive(), false);
  } finally { broken.router.destroy(); }
});

test('voice errors offer a settings entry that stops capture and opens model settings', () => {
  const f = fixture();
  try {
    f.callbacks().onError('VOICE_RECOGNITION_UNAVAILABLE');
    f.ui.settingsButton.emit('click');
    assert.ok(f.calls.some(([name, tab]) => name === 'open' && tab === 'settings'));
    assert.equal(f.router.isActive(), false);
  } finally { f.router.destroy(); }
});

test('requesting microphone access survives permission-dialog blur for click capture only', async () => {
  const f = fixture();
  try {
    await f.router.start();
    f.callbacks().onState('requesting');
    f.windowRef.emit('blur');
    assert.equal(f.router.isActive(), true);
    f.documentRef.visibilityState = 'hidden';
    f.documentRef.emit('visibilitychange');
    assert.equal(f.router.isActive(), false);
  } finally { f.router.destroy(); }
  const held = fixture();
  try {
    held.documentRef.emit('keydown', { code: 'Space' }); await settle();
    held.callbacks().onState('requesting');
    held.windowRef.emit('blur');
    assert.equal(held.router.isActive(), false);
  } finally { held.router.destroy(); }
});

test('connecting recognition is cancellable with the microphone control', async () => {
  const f = fixture();
  try {
    await f.router.start();
    f.callbacks().onState('connecting');
    assert.equal(f.ui.root.dataset.status, 'connecting');
    f.ui.button.emit('click');
    assert.ok(f.calls.some(([name]) => name === 'speech.finish'));
  } finally { f.router.destroy(); }
});

test('blur during configuration loading prevents delayed microphone startup', async () => {
  let resolve;
  const f = fixture({ ready: () => new Promise((done) => { resolve = done; }) });
  try {
    f.ui.button.emit('click');
    f.windowRef.emit('blur');
    resolve({ configured: true, speech: { provider: 'browser' } });
    await settle();
    assert.equal(f.router.isActive(), false);
    assert.equal(f.calls.some(([name]) => name === 'speech.start'), false);
  } finally { f.router.destroy(); }
});

test('real speech permission timeout releases router pending state and allows immediate retry', async () => {
  const timers = new Map();
  let nextTimer = 0;
  let permissions = 0;
  const f = fixture({ speechFactory: (options) => createLlmSpeechController({
    ...options,
    Recognition: class { start() {} abort() {} },
    mediaDevices: { getUserMedia: () => { permissions += 1; return new Promise(() => {}); } },
    setTimer: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => timers.delete(id),
  }) });
  try {
    f.ui.button.emit('click'); await settle();
    const deadline = [...timers.values()].find(({ ms }) => ms === 30_000);
    assert.ok(deadline);
    deadline.fn();
    assert.equal(f.router.isActive(), false);
    assert.equal(f.ui.button['aria-pressed'], 'false');
    f.ui.button.emit('click'); await settle();
    assert.equal(permissions, 2);
    f.ui.button.emit('click');
    assert.equal(f.router.isActive(), false);
  } finally { f.router.destroy(); }
});

test('legacy push-to-talk can release and re-enable its live microphone', async () => {
  const f = fixture({ mode: 'realtime', statusCoupled: true });
  try {
    f.documentRef.emit('keydown', { code: 'Space' }); await settle();
    f.documentRef.emit('keyup', { code: 'Space' });
    assert.equal(f.calls.filter(([name]) => name === 'realtime.release').length, 1);
    f.documentRef.emit('keydown', { code: 'Space' });
    assert.equal(f.realtime.pushToTalkKeyHeld, true);
    f.documentRef.emit('keyup', { code: 'Space' });
    assert.equal(f.calls.filter(([name]) => name === 'realtime.start').length, 1);
  } finally { f.router.destroy(); }
});

test('assistant cancel, config changes, blur and disposal stop capture without recursion', async () => {
  const f = fixture();
  await f.router.start();
  f.notify({ type: 'cancel' });
  assert.equal(f.router.isActive(), false);
  await f.router.start();
  f.changeConfig({ configured: true, speech: { provider: 'realtime' }, voice: { configured: true } });
  assert.equal(f.router.isActive(), false);
  assert.equal(f.ui.tierButton.hidden, false);
  await f.router.start();
  f.windowRef.emit('blur');
  assert.equal(f.router.isActive(), false);
  f.router.destroy();
  const count = f.calls.length;
  f.ui.button.emit('click'); f.documentRef.emit('keydown', { code: 'Space' }); await settle();
  assert.equal(f.calls.length, count);
});
