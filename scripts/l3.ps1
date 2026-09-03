[CmdletBinding()]
param(
  [switch]$InfrastructureOnly,
  [switch]$WebCspOnly,
  [switch]$DesktopOnly,
  [switch]$TauriProcessSmoke
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$exclusiveStageCount = @($InfrastructureOnly, $WebCspOnly, $DesktopOnly).Where({ $_ }).Count
if ($exclusiveStageCount -gt 1) {
  throw 'InfrastructureOnly, WebCspOnly, and DesktopOnly are mutually exclusive.'
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $repositoryRoot 'infra/compose/docker-compose.yml'

function Invoke-Checked {
  param(
    [Parameter(Mandatory)] [string]$FilePath,
    [Parameter(ValueFromRemainingArguments)] [string[]]$Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
  }
}

function New-RandomHex {
  param([int]$Bytes = 32)
  return [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes($Bytes)).ToLowerInvariant()
}

function Get-AvailableTcpPort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  }
  finally {
    $listener.Stop()
  }
}

function Assert-LoopbackPublishedPorts {
  param(
    [Parameter(Mandatory)] [string[]]$ComposeArguments,
    [Parameter(Mandatory)] [string[]]$Services
  )

  foreach ($service in $Services) {
    $containerId = (& docker @ComposeArguments ps --quiet $service | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($containerId)) {
      throw "Unable to resolve the L3 container for $service."
    }
    $hostIps = @(
      & docker inspect --format '{{range .NetworkSettings.Ports}}{{range .}}{{println .HostIp}}{{end}}{{end}}' $containerId |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    if ($LASTEXITCODE -ne 0 -or $hostIps.Count -eq 0) {
      throw "Unable to inspect published ports for $service."
    }
    if (@($hostIps | Where-Object { $_ -ne '127.0.0.1' }).Count -gt 0) {
      throw "$service published a dependency port outside 127.0.0.1: $($hostIps -join ', ')"
    }
  }
  Write-Host '[L3] Dependency ports are bound only to 127.0.0.1.'
}

function Remove-ValidatedTemporaryRoot {
  param([Parameter(Mandatory)] [string]$Path)

  $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $resolvedTarget = [IO.Path]::GetFullPath($Path).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $expectedPrefix = "$resolvedTemp$([IO.Path]::DirectorySeparatorChar)"
  $leaf = Split-Path -Leaf $resolvedTarget
  if (-not $resolvedTarget.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a temporary path outside the system temp directory: $resolvedTarget"
  }
  if ($leaf -notmatch '^aw-l3-[a-f0-9]{12}$') {
    throw "Refusing to remove a temporary path without an exact aw-l3 run name: $resolvedTarget"
  }
  if (Test-Path -LiteralPath $resolvedTarget) {
    Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
  }
}

function Invoke-InfrastructureL3 {
  Invoke-Checked docker info --format '{{.ServerVersion}}'
  Invoke-Checked docker compose version

  $suffix = (New-RandomHex 6)
  $projectName = "aw-l3-$suffix"
  $runId = "run-$suffix"
  $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) $projectName
  $environmentFile = Join-Path $temporaryRoot 'compose.env'
  $postgresPort = Get-AvailableTcpPort
  $redisPort = Get-AvailableTcpPort
  $minioApiPort = Get-AvailableTcpPort
  $minioConsolePort = Get-AvailableTcpPort
  $postgresPassword = New-RandomHex
  $minioAccessKey = "aw-l3-$suffix"
  $minioSecretKey = New-RandomHex
  $artifactBucket = "aw-l3-$suffix"
  $sessionSecret = New-RandomHex
  $otpPepper = New-RandomHex
  $workerToken = New-RandomHex
  $adminPassword = New-RandomHex
  $adminEmail = "l3-$suffix@example.test"

  New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
  [IO.File]::WriteAllLines(
    $environmentFile,
    @(
      'NODE_ENV=test'
      'POSTGRES_USER=aw_l3'
      "POSTGRES_PASSWORD=$postgresPassword"
      "POSTGRES_PORT=$postgresPort"
      "REDIS_PORT=$redisPort"
      "MINIO_ROOT_USER=$minioAccessKey"
      "MINIO_ROOT_PASSWORD=$minioSecretKey"
      "MINIO_API_PORT=$minioApiPort"
      "MINIO_CONSOLE_PORT=$minioConsolePort"
      'MINIO_INTERNAL_ENDPOINT=http://minio:9000'
      "MINIO_PUBLIC_ENDPOINT=http://127.0.0.1:$minioApiPort"
      'MINIO_API_CORS_ALLOW_ORIGIN=http://localhost:4300'
      "ARTIFACT_BUCKET=$artifactBucket"
      "SESSION_SECRET=$sessionSecret"
      "OTP_PEPPER=$otpPepper"
      'AUTH_MODE=local_otp'
      'OIDC_CLIENT_ID=l3-not-used'
      "OIDC_CLIENT_SECRET=$(New-RandomHex)"
      "WORKER_CALLBACK_TOKEN=$workerToken"
      'RELEASE_SIGNING_PUBLIC_KEYS=l3-not-used'
    ),
    [Text.UTF8Encoding]::new($false)
  )

  $composeArguments = @(
    'compose',
    '--project-name', $projectName,
    '--env-file', $environmentFile,
    '--file', $composeFile
  )
  $runError = $null

  try {
    Write-Host "[L3] Compose project: $projectName"
    Write-Host "[L3] Isolated ports: postgres=$postgresPort redis=$redisPort minio=$minioApiPort"
    Invoke-Checked docker @composeArguments config --quiet
    Invoke-Checked docker @composeArguments up --detach --wait postgres redis minio
    Assert-LoopbackPublishedPorts -ComposeArguments $composeArguments -Services @('postgres', 'redis', 'minio')
    Invoke-Checked docker @composeArguments run --rm --no-deps minio-bootstrap

    Push-Location $repositoryRoot
    try {
      Invoke-Checked pnpm --filter '@awesome-workflow/api...' --filter '@awesome-workflow/worker...' build

      $databaseUrl = "postgresql://aw_l3:$postgresPassword@127.0.0.1:$postgresPort/awesome_workflow"
      $redisUrl = "redis://127.0.0.1:$redisPort"
      $s3Url = "http://127.0.0.1:$minioApiPort"
      $savedEnvironment = @{}
      $l3Environment = @{
        AW_L3_RUN_ID = $runId
        AW_L3_ADMIN_EMAIL = $adminEmail
        AW_L3_ADMIN_PASSWORD = $adminPassword
        AW_L3_SESSION_SECRET = $sessionSecret
        AW_L3_OTP_PEPPER = $otpPepper
        AW_L3_WORKER_TOKEN = $workerToken
        DATABASE_URL = $databaseUrl
        REDIS_URL = $redisUrl
        S3_ENDPOINT = $s3Url
        S3_BUCKET = $artifactBucket
        S3_ACCESS_KEY_ID = $minioAccessKey
        S3_SECRET_ACCESS_KEY = $minioSecretKey
      }
      foreach ($name in $l3Environment.Keys) {
        $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $l3Environment[$name], 'Process')
      }
      try {
        Invoke-Checked pnpm db:migrate
        Invoke-Checked pnpm --filter '@awesome-workflow/api' exec tsx scripts/l3-infrastructure.ts
      }
      finally {
        foreach ($name in $l3Environment.Keys) {
          [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
        }
      }
    }
    finally {
      Pop-Location
    }
  }
  catch {
    $runError = $_
    Write-Warning '[L3] Failure detected; collecting bounded Compose diagnostics before cleanup.'
    & docker @composeArguments ps --all
    & docker @composeArguments logs --no-color --tail 120 postgres redis minio minio-bootstrap
  }
  finally {
    Write-Host "[L3] Removing isolated project $projectName and its volumes."
    & docker @composeArguments down --volumes --remove-orphans --timeout 10
    $cleanupExitCode = $LASTEXITCODE
    try {
      Remove-ValidatedTemporaryRoot -Path $temporaryRoot
    }
    catch {
      if ($null -eq $runError) {
        $runError = $_
      }
      else {
        Write-Warning "[L3] Temporary directory cleanup also failed: $($_.Exception.Message)"
      }
    }
    if ($cleanupExitCode -ne 0 -and $null -eq $runError) {
      $runError = [InvalidOperationException]::new("Compose cleanup failed with exit code $cleanupExitCode")
    }
  }

  if ($null -ne $runError) {
    throw $runError
  }
}

function Invoke-DesktopHeadlessPreflight {
  Push-Location $repositoryRoot
  try {
    Write-Host '[preflight] Building the Tauri WebView application without launching a GUI.'
    Invoke-Checked pnpm --filter '@awesome-workflow/desktop' build:web
    Write-Host '[preflight] Compiling all native sidecars.'
    Invoke-Checked cargo build --package awesome-workflow-agent --package awesome-workflow-runner --package awesome-workflow-elevated-helper
    Write-Host '[preflight] Running persistent Agent/IPC/lease/task-RPC headless contracts.'
    Invoke-Checked cargo test --package awesome-workflow-agent --lib
    Write-Host '[preflight] Running the Tauri host/authentication headless contracts.'
    Invoke-Checked cargo test --package awesome-workflow-desktop --lib
  }
  finally {
    Pop-Location
  }
}

function Invoke-WebFederationCspL3 {
  Push-Location $repositoryRoot
  try {
    Write-Host '[L3] Building the real Federation remote used by the browser gate.'
    Invoke-Checked pnpm --filter '@awesome-workflow/control-plane' build
    Write-Host '[L3] Launching the Shell and remote fixture under repository-owned Playwright.'
    Invoke-Checked pnpm --filter '@awesome-workflow/web-shell' exec playwright test --config playwright.l3.config.ts
  }
  finally {
    Pop-Location
  }
}

function Invoke-TauriProcessL3 {
  if (-not $IsWindows -and -not $IsMacOS) {
    throw 'The Tauri process smoke requires Windows or macOS with an interactive desktop session.'
  }
  if ($env:AW_L3_INTERACTIVE_DESKTOP -ne '1') {
    throw 'Set AW_L3_INTERACTIVE_DESKTOP=1 only inside an interactive desktop session to run the Tauri process smoke.'
  }

  $suffix = New-RandomHex 6
  $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "aw-l3-$suffix"
  $agentDataRoot = Join-Path $temporaryRoot 'agent-data'
  New-Item -ItemType Directory -Path $agentDataRoot -Force | Out-Null
  $desktopProcess = $null
  $newAgentProcesses = @()
  try {
    Push-Location $repositoryRoot
    try {
      Invoke-Checked cargo build --package awesome-workflow-agent --package awesome-workflow-runner --package awesome-workflow-elevated-helper
      Invoke-Checked node apps/desktop/scripts/stage-sidecars.mjs debug
      Invoke-Checked pnpm --filter '@awesome-workflow/desktop' exec tauri build --debug --no-bundle
    }
    finally {
      Pop-Location
    }

    $extension = if ($IsWindows) { '.exe' } else { '' }
    $desktopExecutable = Join-Path $repositoryRoot "target/debug/awesome-workflow-desktop$extension"
    $agentExecutable = [IO.Path]::GetFullPath(
      (Join-Path $repositoryRoot "target/debug/awesome-workflow-agent$extension")
    )
    if (-not (Test-Path -LiteralPath $desktopExecutable -PathType Leaf)) {
      throw "Tauri debug executable is missing: $desktopExecutable"
    }
    $existingAgentIds = @(
      Get-Process -Name 'awesome-workflow-agent' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and [IO.Path]::GetFullPath($_.Path) -eq $agentExecutable } |
        Select-Object -ExpandProperty Id
    )
    $desktopStdout = Join-Path $temporaryRoot 'tauri.stdout.log'
    $desktopStderr = Join-Path $temporaryRoot 'tauri.stderr.log'
    $startArguments = @{
      FilePath = $desktopExecutable
      PassThru = $true
      RedirectStandardOutput = $desktopStdout
      RedirectStandardError = $desktopStderr
      Environment = @{
        AW_AGENT_DATA_ROOT = $agentDataRoot
        AW_AGENT_PATH = $agentExecutable
        AW_RUNNER_PATH = [IO.Path]::GetFullPath((Join-Path $repositoryRoot "target/debug/awesome-workflow-runner$extension"))
      }
    }
    if ($IsWindows) {
      $startArguments.WindowStyle = 'Hidden'
    }
    $desktopProcess = Start-Process @startArguments
    Start-Sleep -Seconds 5
    if ($desktopProcess.HasExited) {
      if (Test-Path -LiteralPath $desktopStdout) {
        Get-Content -LiteralPath $desktopStdout | Select-Object -Last 80 | Write-Warning
      }
      if (Test-Path -LiteralPath $desktopStderr) {
        Get-Content -LiteralPath $desktopStderr | Select-Object -Last 80 | Write-Warning
      }
      throw "Tauri process exited during startup with code $($desktopProcess.ExitCode)"
    }
    $newAgentProcesses = @(
      Get-Process -Name 'awesome-workflow-agent' -ErrorAction SilentlyContinue |
        Where-Object {
          $_.Path -and
          [IO.Path]::GetFullPath($_.Path) -eq $agentExecutable -and
          $_.Id -notin $existingAgentIds
        }
    )
    if ($newAgentProcesses.Count -ne 1) {
      throw "Expected exactly one isolated Agent process, observed $($newAgentProcesses.Count)."
    }

    Stop-Process -Id $desktopProcess.Id -Force
    $desktopProcess.WaitForExit(10000) | Out-Null
    Start-Sleep -Seconds 2
    $newAgentProcesses[0].Refresh()
    if ($newAgentProcesses[0].HasExited) {
      throw 'The persistent Agent exited when the Tauri management UI closed.'
    }
    Write-Host '[L3] Tauri GUI process started, launched one isolated Agent, and Agent survived UI exit.'
  }
  finally {
    if ($null -ne $desktopProcess -and -not $desktopProcess.HasExited) {
      Stop-Process -Id $desktopProcess.Id -Force -ErrorAction SilentlyContinue
    }
    foreach ($agentProcess in $newAgentProcesses) {
      if (-not $agentProcess.HasExited) {
        Stop-Process -Id $agentProcess.Id -Force -ErrorAction SilentlyContinue
      }
    }
    Remove-ValidatedTemporaryRoot -Path $temporaryRoot
  }
}

if (-not $DesktopOnly -and -not $WebCspOnly) {
  Invoke-InfrastructureL3
  Write-Host '[L3] Compose-backed services plus host TCP API/BullMQ Worker stage passed.'
}
if (-not $InfrastructureOnly -and -not $DesktopOnly) {
  Invoke-WebFederationCspL3
  Write-Host '[L3] Federation CSP browser stage passed.'
}
if (-not $InfrastructureOnly -and -not $WebCspOnly) {
  Invoke-DesktopHeadlessPreflight
  Write-Host '[preflight] Tauri/Agent headless contracts passed; this is not a GUI L3 result.'
  if ($TauriProcessSmoke) {
    Invoke-TauriProcessL3
  }
  else {
    Write-Host '[L3] Tauri GUI process gate: NOT RUN (pass -TauriProcessSmoke in an interactive desktop session).'
  }
}

Write-Host '[acceptance] Requested stages completed.'
