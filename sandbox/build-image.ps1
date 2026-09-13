$ErrorActionPreference = "Stop"

$SandboxDir = $PSScriptRoot
$BaseImageFile = Join-Path $SandboxDir "base-image.txt"

if (-not (Test-Path $BaseImageFile)) {
    throw "base-image.txt not found."
}

$BaseImage = (Get-Content -Raw $BaseImageFile).Trim()

if ([string]::IsNullOrWhiteSpace($BaseImage)) {
    throw "base-image.txt is empty."
}

Write-Host "Building from:" -ForegroundColor Cyan
Write-Host $BaseImage -ForegroundColor Green
Write-Host ""

docker build `
    --build-arg "BASE_IMAGE=$BaseImage" `
    --tag "desktop-commander-dev-sandbox:latest" `
    $SandboxDir

if ($LASTEXITCODE -ne 0) {
    throw "Docker image build failed."
}

Write-Host ""
Write-Host "Image built successfully:" -ForegroundColor Green
Write-Host "desktop-commander-dev-sandbox:latest"
