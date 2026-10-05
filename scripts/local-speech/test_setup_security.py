"""Exercise Windows setup ordering without installing packages or models."""

import json
from pathlib import Path
import shutil
import subprocess

import pytest


SERVICES = Path(__file__).resolve().parents[1]


def run_setup_prefix(service, environment_exists=True, upgrade_fails=False):
    shell = shutil.which("powershell") or shutil.which("pwsh")
    if not shell:
        pytest.skip("PowerShell is required to exercise the Windows installer.")
    setup = (SERVICES / f"local-{service}" / "setup.ps1").read_text(encoding="utf-8")
    end_marker = "$hfPath =" if service == "speech" else "& $pythonPath (Join-Path"
    prefix = setup[:setup.index(end_marker)]
    # Capture only external interpreter execution; retain the installer's own
    # interpreter selection, ordering, arguments, and failure checks.
    prefix = prefix.replace("& $pythonPath", "Invoke-TestPython $pythonPath")
    prefix = prefix.replace("$PSScriptRoot", f"'C:/setup-contract/scripts/local-{service}'")
    harness = f"""
$script:setupCalls = @()
$script:setupFailure = $null
function Resolve-Path {{ [pscustomobject]@{{Path = 'C:/setup-contract'}} }}
function Test-Path {{ return ${str(environment_exists).lower()} }}
function python {{
    $script:setupCalls += ,(@('python') + $args)
    $global:LASTEXITCODE = 0
}}
function Invoke-TestPython {{
    $script:setupCalls += ,$args
    $global:LASTEXITCODE = if (${str(upgrade_fails).lower()} -and ($args -contains '--upgrade')) {{ 1 }} else {{ 0 }}
}}
try {{
    & ([scriptblock]::Create(@'
{prefix}
'@)) | Out-Null
}} catch {{ $script:setupFailure = $_.Exception.Message }}
[pscustomobject]@{{calls = @($script:setupCalls); error = $script:setupFailure}} | ConvertTo-Json -Depth 5 -Compress
"""
    result = subprocess.run(
        [shell, "-NoProfile", "-NonInteractive", "-Command", harness],
        capture_output=True, text=True, timeout=15, check=True,
    )
    return json.loads(result.stdout)


@pytest.mark.parametrize("service", ["speech", "vision"])
@pytest.mark.parametrize("environment_exists", [True, False])
def test_setup_upgrades_venv_tools_before_installing_dependencies(service, environment_exists):
    result = run_setup_prefix(service, environment_exists=environment_exists)
    assert result["error"] is None
    calls = result["calls"]
    if not environment_exists:
        assert calls[0][0:3] == ["python", "-m", "venv"]
        calls = calls[1:]
    assert len(calls) == 2
    interpreter = calls[0][0].replace("\\", "/")
    assert interpreter.endswith(f"/.venv-{service}/Scripts/python.exe")
    assert calls[0][1:] == [
        "-m", "pip", "install", "--upgrade", "pip>=26.2", "setuptools>=83.0.0",
    ]
    assert calls[1][0] == calls[0][0]
    assert calls[1][1:5] == ["-m", "pip", "install", "-r"]


@pytest.mark.parametrize("service", ["speech", "vision"])
def test_failed_tool_upgrade_stops_before_dependency_or_model_install(service):
    result = run_setup_prefix(service, upgrade_fails=True)
    assert "Could not upgrade" in result["error"]
    assert len(result["calls"]) == 1
    assert "--upgrade" in result["calls"][0]
