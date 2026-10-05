$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$pythonPath = Join-Path $projectDirectory '.venv-speech/Scripts/python.exe'
$requestedModel = if ($env:GEV_LOCAL_SPEECH_MODEL_ID) { $env:GEV_LOCAL_SPEECH_MODEL_ID.Trim().ToLowerInvariant() } else { 'small' }
$modelDirectoryName = switch ($requestedModel) {
    'small' { 'faster-whisper-small'; break }
    'base' { 'faster-whisper-small'; break }
    'local-whisper-small' { 'faster-whisper-small'; break }
    'medium' { 'faster-whisper-medium'; break }
    'local-whisper-medium' { 'faster-whisper-medium'; break }
    'large-v3-turbo' { 'faster-whisper-large-v3-turbo'; break }
    'local-whisper-large-v3-turbo' { 'faster-whisper-large-v3-turbo'; break }
    default { throw 'Unsupported GEV_LOCAL_SPEECH_MODEL_ID. Use small, medium, or large-v3-turbo.' }
}
$expectedModel = switch ($modelDirectoryName) {
    'faster-whisper-small' { 'local-whisper-small'; break }
    'faster-whisper-medium' { 'local-whisper-medium'; break }
    'faster-whisper-large-v3-turbo' { 'local-whisper-large-v3-turbo'; break }
}
$modelPath = if ($env:GEV_LOCAL_SPEECH_MODEL_PATH) { Join-Path $env:GEV_LOCAL_SPEECH_MODEL_PATH 'model.bin' } else { Join-Path $projectDirectory ('models/speech/' + $modelDirectoryName + '/model.bin') }
# Discover the bundled optional voice-detect.cpp runtime unless the operator
# explicitly supplies another library/model pair. Observation mode remains
# the default, so enabling this does not gate transcription on voice matching.
$defaultVoiceprintDirectory = Join-Path $projectDirectory 'models/speech/voiceprint'
if (Test-Path -LiteralPath $defaultVoiceprintDirectory) {
    $env:PATH = $defaultVoiceprintDirectory + ';' + $env:PATH
}
if (-not $env:VOICEDETECT_LIBRARY) {
    $defaultVoiceprintLibrary = Join-Path $defaultVoiceprintDirectory 'voicedetect.dll'
    if (Test-Path -LiteralPath $defaultVoiceprintLibrary) { $env:VOICEDETECT_LIBRARY = $defaultVoiceprintLibrary }
}
if (-not $env:VOICEDETECT_MODEL) {
    $defaultVoiceprintModel = Join-Path $defaultVoiceprintDirectory 'campplus-zh-cn.gguf'
    if (Test-Path -LiteralPath $defaultVoiceprintModel) { $env:VOICEDETECT_MODEL = $defaultVoiceprintModel }
}
if (-not (Test-Path -LiteralPath $pythonPath) -or -not (Test-Path -LiteralPath $modelPath)) {
    throw 'Run scripts/local-speech/setup.ps1 before starting local speech.'
}
$listener = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 3
        if ($health.model -eq $expectedModel -and $health.status -eq 'ok') {
            Write-Output 'Local speech is already running at http://127.0.0.1:8765/v1'
            return
        }
    } catch { Write-Verbose 'The existing listener did not pass the speech health check.' }
    throw 'Port 8765 is in use. Existing services were left unchanged.'
}
$logDirectory = Join-Path $projectDirectory '.gev-logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$serverScript = Join-Path $PSScriptRoot 'server.py'
$speechProcess = Start-Process -FilePath $pythonPath -ArgumentList @('-u', ('"' + $serverScript + '"')) -WorkingDirectory $projectDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory 'local-speech.stdout.log') -RedirectStandardError (Join-Path $logDirectory 'local-speech.stderr.log') -PassThru
# Allow the worker's 60-second model load plus process startup overhead.
$startupTimeoutSeconds = 75
$startupTimer = [System.Diagnostics.Stopwatch]::StartNew()
while ($startupTimer.Elapsed.TotalSeconds -lt $startupTimeoutSeconds) {
    if ($speechProcess.HasExited) { throw 'Local speech exited. Check .gev-logs/local-speech.stderr.log.' }
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 1
        if ($health.model -eq $expectedModel -and $health.status -eq 'ok') {
            Write-Output ('Local speech is ready at http://127.0.0.1:8765/v1 (PID ' + $speechProcess.Id + ').')
            return
        }
    } catch { Write-Verbose 'Waiting for the local model to load.' }
    Start-Sleep -Milliseconds 500
}
throw 'Local speech startup timed out. Check .gev-logs/local-speech.stderr.log.'
