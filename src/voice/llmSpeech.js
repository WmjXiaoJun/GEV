import { normalizeChineseText } from '../ai/chinese.js';
import { formatAssistantText } from '../ai/messageText.js';

const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
// Leave encoder padding below the local service's 60-second decoded limit.
const MAX_RECORDING_MS = 59_000;
const PLAYBACK_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 30_000;
const RECOGNITION_START_TIMEOUT_MS = 8_000;
const TRANSCRIBE_TIMEOUT_MS = 50_000;
const MODEL_TIMEOUT_MS = 180_000;
const MAX_TRANSCRIPT_LENGTH = 8_000;
const PREVIEW_INTERVAL_MS = 6_500;
const MAX_PREVIEWS_PER_MINUTE = 8;

function localSpeech(config) {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config?.speech?.baseUrl).hostname); }
  catch { return false; }
}

function captureError(error) {
  const code = error?.error || error?.name;
  if (['not-allowed', 'NotAllowedError', 'SecurityError'].includes(code)) return 'VOICE_PERMISSION';
  if (code === 'service-not-allowed') return 'VOICE_RECOGNITION_UNAVAILABLE';
  if (['audio-capture', 'NotFoundError', 'DevicesNotFoundError'].includes(code)) return 'VOICE_NO_MICROPHONE';
  if (['NotReadableError', 'TrackStartError'].includes(code)) return 'VOICE_MICROPHONE_BUSY';
  if (code === 'network') return 'VOICE_NETWORK';
  if (code === 'no-speech') return 'VOICE_NO_SPEECH';
  return 'VOICE_CAPTURE_ERROR';
}

function safeCode(error, fallback) {
  return /^(?:VOICE|VOICEPRINT|STT|LLM)_[A-Z_]+$/.test(error?.code || '') ? error.code : fallback;
}

async function audioBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function recorderOptions(Recorder) {
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    .find((type) => Recorder.isTypeSupported?.(type));
  return mimeType ? { mimeType } : undefined;
}

/** One gesture-owned speech turn, using the same LLM conversation as text input. */
export function createLlmSpeechController({
  getConfig,
  getLocale = () => 'en',
  sendText,
  cancelText = () => {},
  onState = () => {},
  onError = () => {},
  onTranscript = () => {},
  fetchImpl = globalThis.fetch?.bind(globalThis),
  Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition,
  mediaDevices = globalThis.navigator?.mediaDevices,
  MediaRecorder: Recorder = globalThis.MediaRecorder,
  speechSynthesis = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  speakResponses = true,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  now = Date.now,
} = {}) {
  let current = null;
  let destroyed = false;
  let playbackEnabled = Boolean(speakResponses);
  let previewRequests = [];
  const owns = (session) => current === session && !destroyed;

  function state(session, phase) {
    session.phase = phase;
    onState(phase, { provider: session.provider, pushToTalk: session.pushToTalk });
  }

  function clearDeadline(session) {
    if (session.timer !== null) clearTimer(session.timer);
    session.timer = null;
  }

  function deadline(session, ms, callback) {
    clearDeadline(session);
    session.timer = setTimer(() => {
      session.timer = null;
      if (owns(session)) callback();
    }, ms);
  }

  function releaseTracks(session) {
    const stream = session.stream;
    session.stream = null;
    for (const track of stream?.getTracks() || []) track.stop();
  }

  function releaseCapture(session) {
    if (session.previewTimer !== null) clearTimer(session.previewTimer);
    session.previewTimer = null;
    if (session.recognition) {
      const recognition = session.recognition;
      session.recognition = null;
      recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null;
      try { recognition.abort(); } catch { /* Recognition may already have ended. */ }
    }
    if (session.recorder) {
      const recorder = session.recorder;
      session.recorder = null;
      recorder.ondataavailable = recorder.onerror = recorder.onstop = null;
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* Tracks still close below. */ }
    }
    releaseTracks(session);
  }

  function close(session, errorCode) {
    if (!owns(session)) return;
    current = null;
    clearDeadline(session);
    releaseCapture(session);
    session.abort.abort();
    session.previewAbort?.abort();
    if (session.previewDeadline !== null) clearTimer(session.previewDeadline);
    releasePlayback(session);
    if (session.modelPending) cancelText();
    if (errorCode) {
      onState('error', { code: errorCode, provider: session.provider });
      onError(errorCode);
    } else {
      onState('idle', { provider: session.provider });
    }
  }

  function releasePlayback(session) {
    if (session.playbackTimer !== null) clearTimer(session.playbackTimer);
    session.playbackTimer = null;
    session.playbackQueue = [];
    const utterance = session.utterance;
    session.utterance = null;
    if (utterance) {
      utterance.onend = utterance.onerror = null;
      speechSynthesis?.cancel();
    }
  }

  function playNext(session) {
    if (!owns(session)) return;
    if (session.utterance) return;
    const [text, ...remaining] = session.playbackQueue;
    if (!text) {
      if (!session.modelPending) close(session);
      else state(session, session.awaitingConfirmation ? 'confirming' : 'thinking');
      return;
    }
    session.playbackQueue = remaining;
    try {
      const utterance = new Utterance(text);
      utterance.lang = session.locale;
      session.utterance = utterance;
      utterance.onend = () => {
        if (!owns(session) || session.utterance !== utterance) return;
        clearTimer(session.playbackTimer);
        session.playbackTimer = null;
        session.utterance = null;
        playNext(session);
      };
      utterance.onerror = () => {
        if (session.utterance === utterance) close(session, 'VOICE_PLAYBACK_ERROR');
      };
      state(session, 'speaking');
      session.playbackTimer = setTimer(() => {
        if (session.utterance === utterance) close(session);
      }, PLAYBACK_TIMEOUT_MS);
      speechSynthesis.speak(utterance);
    } catch {
      close(session, 'VOICE_PLAYBACK_ERROR');
    }
  }

  function queueSpeech(session, text) {
    if (!playbackEnabled || !speechSynthesis || !Utterance) return;
    const normalized = formatAssistantText(normalizeChineseText(text, session.locale))
      .trim().slice(0, 4_000 - session.playbackCharacters);
    if (!normalized) return;
    session.playbackCharacters += normalized.length;
    session.playbackQueue = [...session.playbackQueue, normalized];
  }

  function receiveReply(event) {
    const session = current;
    if (!session?.modelPending || event?.incomplete || typeof event?.content !== 'string' || !event.id) return;
    session.streamedReply = true;
    const offset = session.replyOffsets[event.id] || 0;
    const text = normalizeChineseText(event.content, session.locale);
    session.replyLengths = { ...session.replyLengths, [event.id]: text.length };
    const pending = text.slice(offset);
    // A trailing streamed ASCII period can be the first half of a decimal such as "10.5".
    const boundaries = [...pending.matchAll(/[\u3002\uff01\uff1f!?\n]|\.(?=\s)/g)].map((match) => match.index + 1);
    const sentences = boundaries.map((end, index) => pending.slice(index ? boundaries[index - 1] : 0, end));
    const consumed = event.streaming && playbackEnabled ? (boundaries.at(-1) || 0) : pending.length;
    if (event.streaming) sentences.forEach((sentence) => queueSpeech(session, sentence));
    else queueSpeech(session, pending);
    session.replyOffsets = { ...session.replyOffsets, [event.id]: offset + consumed };
    playNext(session);
  }

  function speak(session, answer) {
    if (!owns(session)) return;
    clearDeadline(session);
    if (!session.streamedReply && typeof answer === 'string') queueSpeech(session, answer);
    playNext(session);
  }

  async function submit(session, transcript) {
    if (!owns(session) || session.submitted) return;
    session.submitted = true;
    clearDeadline(session);
    releaseCapture(session);
    const text = normalizeChineseText(typeof transcript === 'string' ? transcript.trim() : '', session.locale);
    if (!text) return close(session, 'VOICE_NO_SPEECH');
    if (text.length > MAX_TRANSCRIPT_LENGTH) return close(session, 'VOICE_TRANSCRIPT_TOO_LONG');
    onTranscript(text, { final: true });
    state(session, 'thinking');
    session.modelPending = true;
    deadline(session, MODEL_TIMEOUT_MS, () => close(session, 'VOICE_TIMEOUT'));
    try {
      const answer = await sendText(text);
      session.modelPending = false;
      if (owns(session)) speak(session, answer);
    } catch (error) {
      session.modelPending = false;
      close(session, safeCode(error, 'VOICE_MODEL_ERROR'));
    }
  }

  function publishDraft(session, transcript) {
    if (!owns(session) || session.finishing || session.submitted || typeof transcript !== 'string') return;
    const text = normalizeChineseText(transcript.trim(), session.locale);
    if (!text || text.length > MAX_TRANSCRIPT_LENGTH || text === session.draft) return;
    session.draft = text;
    onTranscript(text, { final: false });
  }

  async function requestTranscript(session, chunks, signal) {
    const audio = await audioBase64(new Blob(chunks, { type: session.mimeType }));
    if (!owns(session) || signal.aborted) return;
    const response = await fetchImpl('/api/ai/transcribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', signal,
      body: JSON.stringify({ audio, mimeType: session.mimeType, locale: session.locale }),
    });
    if (!owns(session) || signal.aborted) return;
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error('Transcription failed.'), {
      code: safeCode({ code: data?.code || data?.error?.code }, 'STT_UPSTREAM_ERROR'),
    });
    return data?.text;
  }

  function schedulePreview(session) {
    if (!owns(session) || !session.previews || session.finishing || session.previewCount >= MAX_PREVIEWS_PER_MINUTE) return;
    session.previewTimer = setTimer(() => {
      session.previewTimer = null;
      if (!owns(session) || session.finishing) return;
      previewRequests = previewRequests.filter((time) => now() - time < 60_000);
      if (!session.audioBytes || session.previewBytes === session.audioBytes || previewRequests.length >= MAX_PREVIEWS_PER_MINUTE) {
        schedulePreview(session);
        return;
      }
      session.previewCount += 1;
      previewRequests = [...previewRequests, now()];
      session.previewBytes = session.audioBytes;
      session.previewPending = preview(session).finally(() => {
        session.previewPending = null;
        schedulePreview(session);
      });
    }, PREVIEW_INTERVAL_MS);
  }

  async function preview(session) {
    const controller = new AbortController();
    session.previewAbort = controller;
    let abortPreview;
    try {
      // Each snapshot retains the initial container header; later chunks alone are not playable media.
      const signal = AbortSignal.any([session.abort.signal, controller.signal]);
      const timeout = new Promise((_, reject) => {
        abortPreview = () => reject(Object.assign(new Error('Preview cancelled.'), { code: 'STT_CANCELLED' }));
        session.abort.signal.addEventListener('abort', abortPreview, { once: true });
        session.previewDeadline = setTimer(() => {
          controller.abort();
          reject(Object.assign(new Error('Preview timed out.'), { code: 'STT_TIMEOUT' }));
        }, TRANSCRIBE_TIMEOUT_MS);
      });
      const text = await Promise.race([requestTranscript(session, [...session.chunks], signal), timeout]);
      publishDraft(session, text);
    } catch (error) {
      if (owns(session) && error?.code !== 'STT_NO_SPEECH') {
        session.previews = false;
        console.warn('[speech] Live preview unavailable; final transcription remains available.', safeCode(error, 'VOICE_NETWORK'));
      }
    } finally {
      clearTimer(session.previewDeadline);
      session.previewDeadline = null;
      session.abort.signal.removeEventListener('abort', abortPreview);
      session.previewAbort = null;
    }
  }

  async function transcribe(session) {
    if (!owns(session) || session.transcribing) return;
    session.transcribing = true;
    releaseCapture(session);
    if (!session.audioBytes) return close(session, 'VOICE_NO_SPEECH');
    state(session, 'transcribing');
    deadline(session, TRANSCRIBE_TIMEOUT_MS, () => close(session, 'VOICE_TIMEOUT'));
    try {
      // The local worker accepts one inference at a time; stopping capture does not race its preview.
      if (session.previewPending) await session.previewPending;
      if (!owns(session)) return;
      deadline(session, TRANSCRIBE_TIMEOUT_MS, () => close(session, 'VOICE_TIMEOUT'));
      const chunks = session.chunks;
      session.chunks = [];
      const text = await requestTranscript(session, chunks, session.abort.signal);
      if (!owns(session)) return;
      await submit(session, text);
    } catch (error) {
      close(session, safeCode(error, 'VOICE_NETWORK'));
    }
  }

  async function beginRecognition(session) {
    if (!Recognition) return close(session, 'VOICE_BROWSER_UNSUPPORTED');
    if (!mediaDevices?.getUserMedia) return close(session, 'VOICE_CAPTURE_UNSUPPORTED');
    try {
      // Confirm microphone access separately from the browser's recognition service.
      const stream = await mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      if (!owns(session)) return;
      state(session, 'connecting');
      deadline(session, RECOGNITION_START_TIMEOUT_MS, () => close(session, 'VOICE_RECOGNITION_UNAVAILABLE'));
      const recognition = new Recognition();
      session.recognition = recognition;
      recognition.lang = session.locale;
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.onstart = () => {
        if (!owns(session)) return;
        state(session, 'listening');
        deadline(session, MAX_RECORDING_MS, finish);
      };
      recognition.onresult = (event) => {
        if (!owns(session) || session.submitted) return;
        session.transcript = Array.from(event.results || [])
          .filter((result) => result.isFinal)
          .map((result) => result[0]?.transcript || '')
          .join(' ');
        publishDraft(session, Array.from(event.results || []).map((result) => result[0]?.transcript || '').join(' '));
      };
      recognition.onerror = (event) => close(session, captureError(event));
      recognition.onend = () => { void submit(session, session.transcript); };
      recognition.start();
    } catch (error) {
      close(session, captureError(error));
    }
  }

  async function beginRecording(session) {
    if (!mediaDevices?.getUserMedia || !Recorder) return close(session, 'VOICE_CAPTURE_UNSUPPORTED');
    try {
      const stream = await mediaDevices.getUserMedia({ audio: true });
      if (!owns(session)) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      session.stream = stream;
      const recorder = new Recorder(stream, recorderOptions(Recorder));
      session.recorder = recorder;
      session.mimeType = recorder.mimeType || 'audio/webm';
      recorder.ondataavailable = ({ data }) => {
        if (!owns(session) || !data?.size) return;
        session.audioBytes += data.size;
        if (session.audioBytes > MAX_AUDIO_BYTES) return close(session, 'VOICE_AUDIO_TOO_LARGE');
        session.chunks = [...session.chunks, data];
      };
      recorder.onerror = (event) => close(session, captureError(event));
      recorder.onstop = () => { void transcribe(session); };
      recorder.start(250);
      state(session, 'listening');
      deadline(session, MAX_RECORDING_MS, finish);
      session.previews = session.previews && /^audio\/(webm|ogg)(;|$)/.test(session.mimeType);
      schedulePreview(session);
    } catch (error) {
      close(session, captureError(error));
    }
  }

  async function start({ pushToTalk = false } = {}) {
    if (destroyed || current) return;
    const session = {
      provider: 'browser', locale: getLocale() === 'zh-CN' ? 'zh-CN' : 'en-US',
      pushToTalk, phase: 'requesting', timer: null, abort: new AbortController(),
      recognition: null, recorder: null, stream: null, utterance: null,
      chunks: [], audioBytes: 0, mimeType: '', transcript: '', submitted: false,
      transcribing: false, modelPending: false, finishing: false,
      previews: false, previewTimer: null, previewPending: null, previewAbort: null,
      previewCount: 0, previewBytes: 0, draft: '',
      previewDeadline: null, playbackTimer: null, playbackQueue: [], playbackCharacters: 0,
      streamedReply: false, replyOffsets: {}, replyLengths: {}, awaitingConfirmation: false,
    };
    current = session;
    state(session, 'requesting');
    deadline(session, START_TIMEOUT_MS, () => close(session, 'VOICE_TIMEOUT'));
    try {
      const config = await getConfig();
      if (!owns(session)) return;
      if (!config?.configured) return close(session, 'VOICE_LLM_NOT_CONFIGURED');
      session.provider = config.speech?.provider || 'browser';
      if (session.provider === 'browser') return beginRecognition(session);
      if (!['current', 'custom'].includes(session.provider)) return close(session, 'STT_UNSUPPORTED_PROVIDER');
      if (!config.speech?.configured) return close(session, 'STT_NOT_CONFIGURED');
      session.previews = localSpeech(config);
      await beginRecording(session);
    } catch (error) {
      close(session, safeCode(error, 'VOICE_NETWORK'));
    }
  }

  function finish() {
    const session = current;
    if (!session || session.finishing || session.submitted || session.transcribing) return;
    session.finishing = true;
    if (['requesting', 'connecting'].includes(session.phase)) return close(session);
    clearDeadline(session);
    // stop() delivers a final recognition result or recording chunk before its end event.
    deadline(session, 3_000, () => {
      if (session.recognition) void submit(session, session.transcript);
      else void transcribe(session);
    });
    try {
      if (session.recognition) session.recognition.stop();
      else if (session.recorder?.state === 'recording') session.recorder.stop();
      else void transcribe(session);
    } catch (error) {
      close(session, captureError(error));
    }
  }

  function stop() {
    if (current) close(current);
  }

  function setPlaybackEnabled(enabled) {
    playbackEnabled = Boolean(enabled);
    const session = current;
    if (!playbackEnabled && session) {
      releasePlayback(session);
      // Skip even unfinished streamed text: re-enabling must not replay history.
      session.replyOffsets = { ...session.replyOffsets, ...session.replyLengths };
      if (session.submitted) playNext(session);
    }
    return playbackEnabled;
  }

  function setAwaitingConfirmation(waiting) {
    const session = current;
    if (!session?.modelPending) return;
    const wasWaiting = session.awaitingConfirmation;
    session.awaitingConfirmation = Boolean(waiting);
    if (waiting) {
      clearDeadline(session);
      state(session, 'confirming');
    } else if (wasWaiting) {
      state(session, session.utterance ? 'speaking' : 'thinking');
      deadline(session, MODEL_TIMEOUT_MS, () => close(session, 'VOICE_TIMEOUT'));
    }
  }

  function destroy() {
    stop();
    destroyed = true;
  }

  return { start, finish, stop, setPlaybackEnabled, setAwaitingConfirmation, receiveReply, isActive: () => current !== null, destroy };
}
