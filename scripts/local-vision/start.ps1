$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$pythonPath = Join-Path $projectDirectory '.venv-vision/Scripts/python.exe'
$visionPort = 8766
$healthUrl = 'http://127.0.0.1:' + $visionPort + '/health'
if (-not (Test-Path -LiteralPath $pythonPath)) { throw 'Run scripts/local-vision/setup.ps1 before starting local vision.' }
foreach ($modelName in @('yolo26n.pt', 'yolo26n-obb.pt')) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectDirectory ('models/vision/' + $modelName)))) {
        throw 'YOLO26 weights are missing. Run scripts/local-vision/setup.ps1.'
    }
}
$buildingSegPath = Join-Path $projectDirectory 'models/vision/yolov8n-building-seg.pt'
$genericSegPath = Join-Path $projectDirectory 'models/vision/yolo26n-seg.pt'
if (-not (Test-Path -LiteralPath $buildingSegPath) -and -not (Test-Path -LiteralPath $genericSegPath)) {
    throw 'No segmentation weights are installed. Run scripts/local-vision/setup.ps1 or install the building weight.'
}
$listener = Get-NetTCPConnection -LocalPort $visionPort -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
        if ($health.service -eq 'gev-local-vision' -and $health.status -in @('ok', 'degraded') -and $health.version -eq '8.4.148' -and $health.models.'buildings-seg'.installed) {
            Write-Output ('Local YOLO26 vision is already running at ' + $healthUrl)
            return
        }
    } catch { Write-Verbose 'Existing listener did not pass the vision health check.' }
    throw ('Port ' + $visionPort + ' is in use. Existing services were left unchanged.')
}
$logDirectory = Join-Path $projectDirectory '.gev-logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$serverScript = Join-Path $PSScriptRoot 'server.py'
$visionProcess = Start-Process -FilePath $pythonPath -ArgumentList @('-u', ('"' + $serverScript + '"')) -WorkingDirectory $projectDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory 'local-vision.stdout.log') -RedirectStandardError (Join-Path $logDirectory 'local-vision.stderr.log') -PassThru
$startupTimer = [System.Diagnostics.Stopwatch]::StartNew()
while ($startupTimer.Elapsed.TotalSeconds -lt 20) {
    if ($visionProcess.HasExited) { throw 'Local vision exited. Check .gev-logs/local-vision.stderr.log.' }
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
        if ($health.service -eq 'gev-local-vision' -and $health.status -in @('ok', 'degraded') -and $health.version -eq '8.4.148' -and $health.models.'buildings-seg'.installed) {
            Write-Output ('Local YOLO26 vision is ready at ' + $healthUrl + ' (PID ' + $visionProcess.Id + '). Models load on first detection.')
            return
        }
    } catch { Write-Verbose 'Waiting for local vision startup.' }
    Start-Sleep -Milliseconds 250
}
throw 'Local vision startup timed out. Check .gev-logs/local-vision.stderr.log.'
