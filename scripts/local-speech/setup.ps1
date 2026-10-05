$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$pythonPath = Join-Path $projectDirectory '.venv-speech/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    python -m venv (Join-Path $projectDirectory '.venv-speech')
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the speech Python environment.' }
}
& $pythonPath -m pip install --upgrade 'pip>=26.2' 'setuptools>=83.0.0'
if ($LASTEXITCODE -ne 0) { throw 'Could not upgrade the speech Python packaging tools.' }
& $pythonPath -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Could not install speech dependencies.' }
$hfPath = Join-Path $projectDirectory '.venv-speech/Scripts/hf.exe'
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
$modelRepository = if ($modelDirectoryName -eq 'faster-whisper-large-v3-turbo') { 'dropbox-dash/faster-whisper-large-v3-turbo' } else { 'Systran/' + $modelDirectoryName }
$modelRevision = switch ($modelDirectoryName) {
    'faster-whisper-small' { '536b0662742c02347bc0e980a01041f333bce120'; break }
    'faster-whisper-medium' { '08e178d48790749d25932bbc082711ddcfdfbc4f'; break }
    'faster-whisper-large-v3-turbo' { '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf'; break }
}
$vocabularyFile = if ($modelDirectoryName -eq 'faster-whisper-large-v3-turbo') { 'vocabulary.json' } else { 'vocabulary.txt' }
# Default path: models/speech/faster-whisper-small (overridden for medium/turbo or an explicit path).
# Default repository: Systran/faster-whisper-small (pinned below for reproducible installs).
$modelDirectory = if ($env:GEV_LOCAL_SPEECH_MODEL_PATH) { (Resolve-Path -LiteralPath $env:GEV_LOCAL_SPEECH_MODEL_PATH -ErrorAction SilentlyContinue).Path } else { Join-Path $projectDirectory ('models/speech/' + $modelDirectoryName) }
if (-not $modelDirectory) { $modelDirectory = [System.IO.Path]::GetFullPath($env:GEV_LOCAL_SPEECH_MODEL_PATH) }
New-Item -ItemType Directory -Force -Path $modelDirectory | Out-Null
& $hfPath download $modelRepository config.json model.bin tokenizer.json $vocabularyFile --revision $modelRevision --local-dir $modelDirectory
if ($LASTEXITCODE -ne 0) { throw 'Could not download the pinned speech model.' }
Write-Output ('Local multilingual speech model installed (' + $modelDirectoryName + '). Run scripts/local-speech/start.ps1 to start it.')
