$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$venvPath = Join-Path $projectDirectory '.venv-vision'
$pythonPath = Join-Path $venvPath 'Scripts/python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    python -m venv $venvPath
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the vision Python environment (Python 3.11+ required).' }
}
& $pythonPath -m pip install --upgrade 'pip>=26.2' 'setuptools>=83.0.0'
if ($LASTEXITCODE -ne 0) { throw 'Could not upgrade the vision Python packaging tools.' }
& $pythonPath -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Could not install local vision dependencies.' }
& $pythonPath (Join-Path $PSScriptRoot 'setup_models.py')
if ($LASTEXITCODE -ne 0) { throw 'Could not download and verify the official YOLO26 model weights.' }
Write-Output 'Local YOLO26 detection, aerial OBB, and instance segmentation models installed. Run scripts/local-vision/start.ps1.'
