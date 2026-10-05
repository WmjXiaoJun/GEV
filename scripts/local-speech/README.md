# Local Speech

Offline multilingual speech recognition for the existing AI assistant. The LLM
remains the model configured in the application; only speech-to-text runs locally.
No API key, cloud speech account, GPU, or system FFmpeg installation is required.

## Windows Setup

Requires Python 3.11 or later. Run from the project directory:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/local-speech/setup.ps1
powershell -ExecutionPolicy Bypass -File scripts/local-speech/start.ps1
```

The setup creates `.venv-speech/` and downloads the multilingual Whisper small
model to `models/speech/faster-whisper-small/` (about 486 MB). It pins the upstream
`Systran/faster-whisper-small` revision to
`536b0662742c02347bc0e980a01041f333bce120`. The service uses faster-whisper 1.2.1
and CPU INT8 inference with up to eight threads, with no downloads during normal
startup or recognition. An existing base model is preserved but no longer loaded.

Subsequent launches only need `start.ps1`. It starts a hidden background process,
checks readiness, and leaves an existing listener untouched. Logs are in
`.gev-logs/local-speech.*.log`; they contain no recordings or transcripts.
When upgrading an already running base service, stop that service before running
`start.ps1`. The startup script never terminates an unknown process on its port.

## Chinese Accuracy Model Choices

`small` remains the default because it starts quickly and works on a CPU-only
Windows machine. For Mandarin speech with accents, background noise, or longer
commands, use `medium` first, then `large-v3-turbo` when the machine has enough
memory and CPU headroom.

```powershell
$env:GEV_LOCAL_SPEECH_MODEL_ID = 'medium' # or 'large-v3-turbo'
powershell -ExecutionPolicy Bypass -File scripts/local-speech/setup.ps1
powershell -ExecutionPolicy Bypass -File scripts/local-speech/start.ps1
```

The selected model is shown in `GET /health` as `local-whisper-small`,
`local-whisper-medium`, or `local-whisper-large-v3-turbo`. To use a separately
downloaded compatible faster-whisper model, set `GEV_LOCAL_SPEECH_MODEL_PATH`
to its directory containing `config.json`, `model.bin`, `tokenizer.json`, and
the model's `vocabulary.txt` or `vocabulary.json`. The installer pins medium to
`Systran/faster-whisper-medium@08e178d48790749d25932bbc082711ddcfdfbc4f`
and turbo to
`dropbox-dash/faster-whisper-large-v3-turbo@0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf`.
Downloading a model does not replace a running service: restart the known local
speech process with the same model environment, then update the application's
transcription model. Selecting a name in the UI does not download or switch the
server's loaded weights. Check `/health` for the actual running model.

## Local Speaker Verification

The assistant's Settings tab has a voiceprint section with recording (maximum
15 seconds), file upload, enrollment, verification, deletion, a threshold slider,
and observation/enforcement modes. Use an ASCII profile identifier such as
`owner`. Record 5-15 seconds of clear speech from the intended speaker, enroll,
then test with a different recording. Enable voiceprint checking and save the
configuration. Observation mode reports a match without blocking transcription;
enforcement refuses unmatched or unavailable verification before sending audio
to the configured transcription provider. Start with observation and calibrate
against different recordings and speakers before enforcement. A lower cosine
distance threshold is stricter; the default 0.25 is not a calibrated error rate.

The local Windows deployment uses [voice-detect.cpp](https://github.com/mudler/voice-detect.cpp)
at `1db1759572c90faef6f3a78c36b5941a096a9f89` and the Chinese CAM++
192-dimensional model. The C++ engine is MIT-licensed; CAM++ weights are
Apache-2.0 according to the [model card](https://huggingface.co/mudler/voice-detect-gguf).
Age, gender, and emotion models are not used. The installed runtime is:

```text
models/speech/voiceprint/
  voicedetect.dll
  ggml.dll
  ggml-base.dll
  ggml-cpu.dll
  campplus-zh-cn.gguf
```

`start.ps1` discovers those files without enabling enforcement. The CAM++ model
is from `mudler/voice-detect-gguf` revision
`a45a8e5ef6b267eb903bc5b95efa1c5257fa005b`, SHA-256
`a6e34c6d230cff26e37b71a2df0907fde1de425654e28d9d5cacca32e02a13d3`.
The native source is currently in the ignored `output/voice-detect.cpp` checkout.
To rebuild the shared CPU library with CMake and a C++17 toolchain:

```powershell
cmake -S output/voice-detect.cpp -B output/voice-detect.cpp/build-shared -DVOICEDETECT_SHARED=ON -DVOICEDETECT_BUILD_CLI=OFF -DGGML_NATIVE=OFF
cmake --build output/voice-detect.cpp/build-shared --config Release
```

Copy the resulting library and its dependent ggml libraries into the runtime
directory. The application adapter also accepts `VOICEDETECT_LIBRARY` and
`VOICEDETECT_MODEL` pointing to a platform-built `.so` or `.dylib` and GGUF file.
Python and C ABI integration are portable; automatic setup/start scripts and
this deployment were tested only on Windows, not macOS or Linux.

Native decoding and embedding run in a single killable subprocess with a
20-second inference deadline and automatic recovery. Enrollment, verification,
and deletion share a 12-attempts/minute limit and reject overlapping work.
Health and status calls remain responsive during inference. The optional native
engine failing to load does not prevent the independent speech model starting.

Only normalized feature vectors are saved, atomically, to
`.gev-cache/voiceprints.json` (or `VOICEPRINT_STORE_PATH`); no recording is saved.
Vectors are sensitive biometric data, stored as local JSON, not encrypted.
Protect this directory with OS permissions and exclude it from cloud sync and
backups as appropriate. Git ignoring a file does not prevent BaiduSyncdisk from
syncing it. Delete a profile through Settings to remove its local vector.

This is an application voice-input filter, not OS authentication or liveness
detection: recordings or synthesized voices may pass, and local programs can
still call the speech service directly. Text input is unaffected. When enabled,
browser recognition and OpenAI Realtime are blocked because they bypass the
server-side verification path. The configured text LLM remains independent.

## Application Configuration

Use the existing voice settings, preserving the current LLM configuration:

| Setting | Value |
| --- | --- |
| Speech provider | Custom transcription service |
| Base URL | `http://127.0.0.1:8765/v1` |
| Model | `local-whisper-small` (or the selected local model identity) |
| API key | Empty |

The application server sends the audio to `/v1/audio/transcriptions` and forwards
the recognized text to the selected LLM. `GET /health` returns readiness and the
 configured model identifier. The multipart request accepts `file`, `model`,
`response_format=json`, and optional `language=zh` or `language=en`. Aliases
`small`, `local-whisper-base`, `base`, and `whisper-1` select the offline small
model. `medium` and `large-v3-turbo` are accepted when the service was started
with the corresponding model. Existing application settings remain compatible.

Chinese requests use five decoding candidates and a short Simplified Chinese
map-vocabulary prompt. The prompt contains no specific city names or scripted
answers. English requests retain the previous decoding settings. Recognition
results are never rewritten through guessed homophone or place-name substitutions.
The application's existing Simplified Chinese normalization remains in place.

## Limits and Privacy

- Binds only to `127.0.0.1:8765`; validates loopback client and local Host.
- Browser cross-origin requests are rejected. No CORS headers are enabled.
- Audio is held in memory, never written to temporary files.
- Decoder input is limited to audio containers; file and network protocols are disabled.
- Maximum audio size is 4 MiB and maximum decoded duration is 60 seconds.
- One recognition job at a time, maximum 12 attempts per minute, no inference queue.
- Upload deadline is 10 seconds. Inference deadline is 35 seconds, including IPC transfer and decode.
- A timed-out inference process is terminated and the local model is reloaded.
- Errors contain safe codes and messages, not paths, tokens, or audio content.

Small is a multilingual model, not a guarantee of error-free recognition. Clear short commands generally work
best; recognition accuracy depends on microphone quality, accent and background
noise. The service does not make a general chat model accept raw audio.

## Verification

```powershell
.venv-speech/Scripts/python.exe -m pip install --upgrade 'pip>=26.2' 'setuptools>=83.0.0'
.venv-speech/Scripts/python.exe -m pip install -r scripts/local-speech/requirements-dev.txt
.venv-speech/Scripts/python.exe -m pytest scripts/local-speech -q --cov=engine --cov=server --cov=voiceprint --cov=voiceprint_worker --cov-report=term-missing --cov-fail-under=80
curl.exe http://127.0.0.1:8765/health
curl.exe -F "file=@scripts/fixtures/voice/full-globe-turn-on-radio.wav;type=audio/wav" -F "model=local-whisper-small" -F "language=en" http://127.0.0.1:8765/v1/audio/transcriptions
```

The bundled WAV fixture is approved repository QA audio, not a microphone
recording. The tests cover multipart validation, locality, size/duration limits,
rate limits, decoding, sanitization, worker failure, cancellation, and recovery.

Deployment acceptance on 2026-09-07: the 9.2-second repository WAV returned
`Go to full globe view and then turn on the radio.`. A 4.204-second public Mandarin
fixture from the [FunASR example list](https://github.com/modelscope/FunASR/blob/main/data/list/train_wav.scp)
(`BAC009S0764W0121`) was also transcribed successfully, with one homophone error
against its published transcript. That downloaded QA fixture is only in ignored
`output/local-speech/chinese-public-fixture.wav`, not a user recording. Its SHA-256
is `46dbc998c9d1d48111267c40741dd3200f2e5bcf4075f8c4c97f4451160dce50`.
No real microphone audio was collected during automated verification.

For native CAM++ acceptance on this Windows installation:

```powershell
$env:GEV_TEST_NATIVE_VOICEPRINT = '1'
.venv-speech/Scripts/python.exe -m pytest scripts/local-speech/test_voiceprint_runtime.py -q
```

This uses the repository fixture and a temporary feature store, never the real
profile store. It checks embedding, enrollment, identical-fixture verification,
persistence, deletion, and absence of saved audio. It is not a speaker accuracy,
replay-resistance, or real-microphone benchmark.

September 9 accuracy upgrade acceptance: the same public Mandarin fixture now
matches its [published transcript](https://github.com/modelscope/FunASR/blob/main/data/list/train_text.txt),
ignoring punctuation; the previous one-character homophone error is corrected.
The upgraded CPU model processed this 4.204-second clip in about 1.7 seconds and
retained the English command above. Five-second silence and low-amplitude random
noise produced no transcript. A 50.447-second repetition of the public clip
completed in 6.6 seconds, below the 35-second worker deadline; this is a latency
stress test, not evidence that repeated wording or real microphones transcribe
perfectly. The live application `/api/ai/transcribe` route also returned the
correct Simplified Chinese text using the legacy model alias. These checks do
not establish accuracy for the user's voice, accent, or microphone.

Primary references: [faster-whisper](https://github.com/SYSTRAN/faster-whisper) and
[pinned model](https://huggingface.co/Systran/faster-whisper-small/tree/536b0662742c02347bc0e980a01041f333bce120).
