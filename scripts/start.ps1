param([ValidateSet('live','demo')][string]$Mode='live',[int]$Port=8010)
$ErrorActionPreference='Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not (Test-Path '.venv/Scripts/python.exe')) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python environment creation failed.' }
    & ./.venv/Scripts/python.exe -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
}
if (-not (Test-Path node_modules)) {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'Node dependency installation failed.' }
}
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
$env:WEATHER_MODE=$Mode
Write-Host "VieWeather will be available at http://127.0.0.1:$Port"
& ./.venv/Scripts/python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port $Port
