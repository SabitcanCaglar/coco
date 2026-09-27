#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$RepoUrl = "https://github.com/SabitcanCaglar/coco.git",
    [string]$Branch = "codex/m6-first-real-fixers",
    [string]$Distro = "Ubuntu-24.04",
    [string]$LinuxUser = "coco",
    [switch]$SkipTests,
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-SafeValue([string]$Name, [string]$Value, [string]$Pattern) {
    if ($Value -notmatch $Pattern) { throw "Unsafe $Name value: $Value" }
}

Assert-SafeValue "repository URL" $RepoUrl '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?$'
Assert-SafeValue "branch" $Branch '^[A-Za-z0-9._/-]+$'
Assert-SafeValue "distribution" $Distro '^[A-Za-z0-9._-]+$'
Assert-SafeValue "Linux user" $LinuxUser '^[a-z_][a-z0-9_-]*$'

if ($ValidateOnly) {
    Write-Host "Coco Windows installer validation passed."
    exit 0
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "This entrypoint must run on Windows PowerShell."
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    if (-not $PSCommandPath) { throw "Save this script to a file and run it as Administrator." }
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-RepoUrl', "`"$RepoUrl`"", '-Branch', "`"$Branch`"", '-Distro', "`"$Distro`"", '-LinuxUser', "`"$LinuxUser`"")
    if ($SkipTests) { $arguments += '-SkipTests' }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments
    exit 0
}

$stateRoot = Join-Path $env:ProgramData 'Coco\bootstrap'
New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
$logPath = Join-Path $stateRoot 'install.log'
Start-Transcript -Path $logPath -Append | Out-Null

try {
    Write-Host "[1/4] Checking WSL2 prerequisites"
    $needsRestart = $false
    foreach ($featureName in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
        $feature = Get-WindowsOptionalFeature -Online -FeatureName $featureName
        if ($feature.State -eq 'Enabled') {
            Write-Host "skip $featureName is already enabled"
            continue
        }
        Write-Host "install enabling $featureName"
        $result = Enable-WindowsOptionalFeature -Online -FeatureName $featureName -All -NoRestart
        $needsRestart = $needsRestart -or [bool]$result.RestartNeeded
    }
    if ($needsRestart) {
        Write-Host "Windows restart is required. Restart, then run the same installer command again."
        exit 3010
    }

    Write-Host "[2/4] Checking and configuring $Distro"
    & wsl.exe --status | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host "update WSL runtime is unavailable or stale"
        & wsl.exe --update | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "wsl --update failed (exit $LASTEXITCODE)." }
    } else {
        Write-Host "skip WSL runtime is already available"
    }
    & wsl.exe --set-default-version 2 | Out-Host
    $installed = @(& wsl.exe --list --quiet) -replace "`0", '' | ForEach-Object { $_.Trim() }
    if ($installed -notcontains $Distro) {
        Write-Host "install $Distro"
        & wsl.exe --install --distribution $Distro --no-launch | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "WSL distribution install failed (exit $LASTEXITCODE)." }
    } else {
        Write-Host "skip $Distro is already installed"
    }

    $rootSetup = "changed=0; id -u '$LinuxUser' >/dev/null 2>&1 || { useradd -m -s /bin/bash '$LinuxUser'; changed=1; }; printf '$LinuxUser ALL=(ALL) NOPASSWD:ALL\n' >/etc/sudoers.d/coco; chmod 0440 /etc/sudoers.d/coco; touch /etc/wsl.conf; grep -Eq '^[[:space:]]*systemd[[:space:]]*=[[:space:]]*true' /etc/wsl.conf || { printf '\n[boot]\nsystemd=true\n' >>/etc/wsl.conf; changed=1; }; grep -Eq '^[[:space:]]*default[[:space:]]*=[[:space:]]*$LinuxUser' /etc/wsl.conf || { printf '\n[user]\ndefault=$LinuxUser\n' >>/etc/wsl.conf; changed=1; }; echo COCO_WSL_CHANGED=`$changed"
    $rootOutput = @(& wsl.exe --distribution $Distro --user root -- bash -lc $rootSetup)
    $rootOutput | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "WSL user/systemd setup failed (exit $LASTEXITCODE)." }
    if ($rootOutput -contains 'COCO_WSL_CHANGED=1') {
        Write-Host "restart WSL to activate new systemd/user settings"
        & wsl.exe --shutdown
        Start-Sleep -Seconds 3
    } else {
        Write-Host "skip WSL user and systemd settings are already configured"
    }

    Write-Host "[3/4] Bootstrapping Coco inside WSL2"
    $repoSlug = $RepoUrl -replace '^https://github\.com/', '' -replace '\.git$', ''
    $bootstrapUrl = "https://raw.githubusercontent.com/$repoSlug/$Branch/scripts/windows/bootstrap-wsl.sh"
    $testFlag = if ($SkipTests) { '--skip-tests' } else { '' }
    $bootstrap = "set -euo pipefail; curl -fsSL '$bootstrapUrl' -o /tmp/coco-bootstrap-wsl.sh; chmod 0700 /tmp/coco-bootstrap-wsl.sh; /tmp/coco-bootstrap-wsl.sh --repo-url '$RepoUrl' --branch '$Branch' $testFlag"
    & wsl.exe --distribution $Distro --user $LinuxUser -- bash -lc $bootstrap | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Coco WSL bootstrap failed (exit $LASTEXITCODE)." }

    Write-Host "[4/4] Installation complete"
    Write-Host "Logs: $logPath"
    Write-Host "One human step remains: run 'wsl -d $Distro -u $LinuxUser -- codex login' and complete ChatGPT sign-in."
} finally {
    Stop-Transcript | Out-Null
}
