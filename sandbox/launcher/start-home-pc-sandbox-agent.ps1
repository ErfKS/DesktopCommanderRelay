$ErrorActionPreference = "Stop"

$RelayDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$ConfigFile = Join-Path $PSScriptRoot "sandbox-mounts.txt"
$ExampleConfigFile = Join-Path $PSScriptRoot "sandbox-mounts.example.txt"
$Image = "desktop-commander-dev-sandbox:latest"

if (-not (Test-Path $ConfigFile)) {
    if (-not (Test-Path $ExampleConfigFile)) {
        throw "Neither sandbox-mounts.txt nor sandbox-mounts.example.txt exists."
    }

    Copy-Item `
        -LiteralPath $ExampleConfigFile `
        -Destination $ConfigFile

    Write-Host "[INFO] Created local mount configuration:" -ForegroundColor Yellow
    Write-Host "       $ConfigFile" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host " Desktop Commander - Home PC Sandbox Agent" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path (Join-Path $RelayDir "package.json"))) {
    throw "Relay project not found: $RelayDir"
}

if (-not (Test-Path $ConfigFile)) {
    throw "Mount configuration not found: $ConfigFile"
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker CLI was not found in PATH."
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
    throw "Docker Desktop is not running or is not reachable."
}

docker image inspect $Image *> $null
if ($LASTEXITCODE -ne 0) {
    throw "Docker image was not found: $Image"
}

$DockerArgs = [System.Collections.Generic.List[string]]::new()

@(
    "run",
    "-i",
    "--rm",
    "--init",
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--pids-limit", "256",
    "--memory", "2g",
    "--cpus", "2",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
    "-e", "HOME=/tmp/dc-home"
) | ForEach-Object {
    $DockerArgs.Add($_)
}

$SeenTargets = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::Ordinal
)

$MountCount = 0
$LineNumber = 0

foreach ($RawLine in Get-Content -LiteralPath $ConfigFile) {
    $LineNumber++

    $Line = ($RawLine -replace "^\uFEFF", "").Trim()

    if ([string]::IsNullOrWhiteSpace($Line)) {
        continue
    }

    if ($Line.StartsWith("#")) {
        continue
    }

    $Parts = @($Line -split "\|")

    $HostPath = $null
    $ContainerPath = $null
    $Mode = "rw"

    if ($Parts.Count -eq 1) {
        $HostPath = $Parts[0].Trim()
    }
    elseif ($Parts.Count -eq 2) {
        $HostPath = $Parts[0].Trim()
        $Second = $Parts[1].Trim()

        if ($Second.ToLowerInvariant() -in @("rw", "ro")) {
            $Mode = $Second.ToLowerInvariant()
        }
        else {
            $ContainerPath = $Second
        }
    }
    elseif ($Parts.Count -eq 3) {
        $HostPath = $Parts[0].Trim()
        $ContainerPath = $Parts[1].Trim()
        $Mode = $Parts[2].Trim().ToLowerInvariant()
    }
    else {
        throw "Invalid mount entry on line $LineNumber."
    }

    $HostPath = [Environment]::ExpandEnvironmentVariables($HostPath)

    if ($Mode -notin @("rw", "ro")) {
        throw "Invalid mode '$Mode' on line $LineNumber."
    }

    if (-not (Test-Path -LiteralPath $HostPath -PathType Container)) {
        throw "Host directory does not exist on line ${LineNumber}: $HostPath"
    }

    $ResolvedHost = (Resolve-Path -LiteralPath $HostPath).Path

    if ([string]::IsNullOrWhiteSpace($ContainerPath)) {
        $Leaf = Split-Path -Leaf $ResolvedHost

        if ([string]::IsNullOrWhiteSpace($Leaf)) {
            throw "Could not determine project name on line $LineNumber."
        }

        $SafeLeaf = $Leaf -replace "[^A-Za-z0-9._-]", "-"
        $ContainerPath = "/projects/$SafeLeaf"
    }

    if (-not $ContainerPath.StartsWith("/")) {
        throw "Container path must start with '/' on line ${LineNumber}: $ContainerPath"
    }

    if ($ContainerPath -match "(^|/)\.\.(/|$)") {
        throw "Container path cannot contain '..' on line $LineNumber."
    }

    if (-not $SeenTargets.Add($ContainerPath)) {
        throw "Duplicate container path on line ${LineNumber}: $ContainerPath"
    }

    $MountSpec = "type=bind,source=$ResolvedHost,target=$ContainerPath"

    if ($Mode -eq "ro") {
        $MountSpec += ",readonly"
    }

    $DockerArgs.Add("--mount")
    $DockerArgs.Add($MountSpec)

    $MountCount++

    Write-Host (
        "[MOUNT] {0} -> {1} ({2})" -f
        $ResolvedHost,
        $ContainerPath,
        $Mode
    ) -ForegroundColor Green
}

if ($MountCount -eq 0) {
    throw "No mounts are configured in sandbox-mounts.txt."
}

$DockerArgs.Add($Image)
$DockerArgs.Add("node")
$DockerArgs.Add("/usr/src/app/dist/index.js")

Set-Location $RelayDir

Remove-Item Env:DESKTOP_COMMANDER_ENTRY -ErrorAction SilentlyContinue

$env:DEVICE_ID = "home-pc-sandbox"
$env:DEVICE_NAME = "Home PC Sandbox"
$env:DESKTOP_COMMANDER_COMMAND = "docker"

$env:DESKTOP_COMMANDER_ARGS_JSON = ConvertTo-Json `
    -InputObject $DockerArgs.ToArray() `
    -Compress

Write-Host ""
Write-Host "[OK] Relay     : $RelayDir" -ForegroundColor Green
Write-Host "[OK] Device ID : $($env:DEVICE_ID)" -ForegroundColor Green
Write-Host "[OK] Mounts    : $MountCount" -ForegroundColor Green
Write-Host "[OK] Image     : $Image" -ForegroundColor Green
Write-Host ""
Write-Host "Starting sandbox agent..." -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop it."
Write-Host ""

& npm.cmd run start:agent

exit $LASTEXITCODE
