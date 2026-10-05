"""Keep the installed model and startup readiness check aligned."""

from pathlib import Path
import json
import shutil
import subprocess

import pytest

from engine import STARTUP_TIMEOUT


SCRIPTS = Path(__file__).resolve().parent


def test_setup_installs_pinned_small_model():
    setup = (SCRIPTS / "setup.ps1").read_text(encoding="utf-8")
    assert "models/speech/faster-whisper-small" in setup
    assert "Systran/faster-whisper-small" in setup
    assert "536b0662742c02347bc0e980a01041f333bce120" in setup
    assert "--revision $modelRevision" in setup


def test_start_requires_small_model_and_checks_actual_service_identity():
    start = (SCRIPTS / "start.ps1").read_text(encoding="utf-8")
    assert "'small' { 'faster-whisper-small'; break }" in start
    assert start.count("$health.model -eq $expectedModel") == 2
    assert "-WindowStyle Hidden" in start


@pytest.mark.parametrize("model,repository,revision,vocabulary", [
    ("small", "Systran/faster-whisper-small", "536b0662742c02347bc0e980a01041f333bce120", "vocabulary.txt"),
    ("medium", "Systran/faster-whisper-medium", "08e178d48790749d25932bbc082711ddcfdfbc4f", "vocabulary.txt"),
    ("large-v3-turbo", "dropbox-dash/faster-whisper-large-v3-turbo", "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf", "vocabulary.json"),
])
def test_model_download_uses_verified_repository_revision_and_vocabulary(model, repository, revision, vocabulary):
    shell = shutil.which("powershell") or shutil.which("pwsh")
    if not shell:
        pytest.skip("PowerShell is required to exercise the Windows setup script.")
    setup = (SCRIPTS / "setup.ps1").read_text(encoding="utf-8")
    download_script = setup[setup.index("$modelRepository ="):]
    harness = f"""
$ErrorActionPreference = 'Stop'
$projectDirectory = 'C:/speech-setup-test'
$env:GEV_LOCAL_SPEECH_MODEL_PATH = ''
$modelDirectoryName = 'faster-whisper-{model}'
$hfPath = 'Invoke-TestDownload'
$LASTEXITCODE = 0
function New-Item {{}}
function Invoke-TestDownload {{ $script:downloadArguments = @($args) }}
& ([scriptblock]::Create(@'
{download_script}
'@)) | Out-Null
ConvertTo-Json -InputObject $script:downloadArguments -Compress
"""
    result = subprocess.run([shell, "-NoProfile", "-NonInteractive", "-Command", harness],
                            capture_output=True, text=True, timeout=15, check=True)
    arguments = json.loads(result.stdout)
    assert arguments[:2] == ["download", repository]
    assert vocabulary in arguments
    assert arguments[arguments.index("--revision") + 1] == revision


def test_start_discovers_bundled_voiceprint_runtime_without_forcing_enforcement():
    start = (SCRIPTS / "start.ps1").read_text(encoding="utf-8")
    assert "models/speech/voiceprint" in start
    assert "voicedetect.dll" in start
    assert "campplus-zh-cn.gguf" in start
    assert "$env:PATH = $defaultVoiceprintDirectory" in start
    assert "VOICEPRINT_MODE" not in start


def run_startup_wait(ready_after, request_seconds=0, process_exited=False):
    shell = shutil.which("powershell") or shutil.which("pwsh")
    if not shell:
        pytest.skip("PowerShell is required to exercise the Windows startup script.")
    start = (SCRIPTS / "start.ps1").read_text(encoding="utf-8")
    wait_script = start[start.index("$speechProcess = Start-Process"):]
    wait_script = wait_script.replace("[System.Diagnostics.Stopwatch]::StartNew()", "(New-TestStartupTimer)")
    harness = f"""
$ErrorActionPreference = 'Stop'
$logDirectory = 'test-log-path'
$expectedModel = 'local-whisper-small'
$script:testSpeechElapsed = 0.0
$script:testSpeechError = $null
function New-TestStartupTimer {{
    $timer = [pscustomobject]@{{}}
    $timer | Add-Member -MemberType ScriptProperty -Name Elapsed -Value {{
        [TimeSpan]::FromSeconds($script:testSpeechElapsed)
    }}
    return $timer
}}
function Start-Process {{
    [pscustomobject]@{{HasExited = ${str(process_exited).lower()}; Id = 123}}
}}
function Invoke-RestMethod {{
    $script:testSpeechElapsed += {request_seconds}
    if ($script:testSpeechElapsed -ge {ready_after}) {{
        return [pscustomobject]@{{model = 'local-whisper-small'; status = 'ok'}}
    }}
    throw 'Model is still loading.'
}}
function Start-Sleep {{
    param([int]$Milliseconds)
    $script:testSpeechElapsed += $Milliseconds / 1000.0
}}
try {{
    & ([scriptblock]::Create(@'
{wait_script}
'@)) | Out-Null
}} catch {{ $script:testSpeechError = $_.Exception.Message }}
[pscustomobject]@{{elapsed = $script:testSpeechElapsed; error = $script:testSpeechError}} | ConvertTo-Json -Compress
"""
    result = subprocess.run([shell, "-NoProfile", "-NonInteractive", "-Command", harness],
                            capture_output=True, text=True, timeout=15, check=True)
    return json.loads(result.stdout)


def test_start_waits_for_a_model_that_loads_after_thirty_seconds():
    result = run_startup_wait(ready_after=40)
    assert result["error"] is None
    assert result["elapsed"] == 40


def test_start_deadline_includes_health_request_time_without_accumulating_attempts():
    result = run_startup_wait(ready_after=1000, request_seconds=1)
    assert "startup timed out" in result["error"]
    assert STARTUP_TIMEOUT + 10 <= result["elapsed"] <= 76.5


def test_start_waits_through_the_worker_startup_deadline():
    result = run_startup_wait(ready_after=STARTUP_TIMEOUT + 5)
    assert result["error"] is None


def test_start_reports_a_failed_process_without_waiting():
    result = run_startup_wait(ready_after=1000, process_exited=True)
    assert "Local speech exited" in result["error"]
    assert result["elapsed"] == 0
