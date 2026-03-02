param(
  [string]$RepoUrl = $env:OPENCODE_SLAVE_REPO_URL,
  [string]$InstallDir = $(Join-Path $HOME ".config/opencode/plugins/opencode-slave"),
  [switch]$Local,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Show-Usage {
  @"
Install opencode-slave into your OpenCode profile.

Usage:
  .\install.ps1 [options]

Options:
  -RepoUrl <url>       Git repository URL (used when not running from local checkout)
  -InstallDir <path>   Install path for cloned repository
  -Local               Force using current checkout as source
  -DryRun              Print commands without executing

Environment variables:
  OPENCODE_SLAVE_REPO_URL
  OPENCODE_SLAVE_INSTALL_DIR
"@
}

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "'$Name' is required but not installed."
  }
}

function Invoke-Step([string]$Title, [string]$DisplayCommand, [scriptblock]$Script) {
  Write-Host "==> $Title"
  Write-Host "+ $DisplayCommand"
  if (-not $DryRun) {
    & $Script
  }
}

if ($args -contains "-h" -or $args -contains "--help") {
  Show-Usage
  exit 0
}

$scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$envInstallDir = $env:OPENCODE_SLAVE_INSTALL_DIR
if ($envInstallDir) {
  $InstallDir = $envInstallDir
}

$localSourceAvailable = (Test-Path (Join-Path $scriptRoot "package.json")) -and (Test-Path (Join-Path $scriptRoot "src/cli.js"))
$sourceDir = $null
$mode = $null

if ($Local) {
  if (-not $localSourceAvailable) {
    throw "-Local was requested but no local opencode-slave checkout was detected."
  }
  $sourceDir = $scriptRoot
  $mode = "local"
} elseif ($localSourceAvailable) {
  $sourceDir = $scriptRoot
  $mode = "local"
} else {
  if ([string]::IsNullOrWhiteSpace($RepoUrl)) {
    throw "No local checkout detected and no repository URL provided. Set OPENCODE_SLAVE_REPO_URL or pass -RepoUrl."
  }
  $mode = "remote"
}

Require-Command "npm"

if ($mode -eq "remote") {
  Require-Command "git"
  $parentDir = Split-Path -Parent $InstallDir
  Invoke-Step "Creating install directory parent" "New-Item -ItemType Directory -Force '$parentDir'" {
    New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
  }

  if (Test-Path $InstallDir) {
    Invoke-Step "Removing previous installation" "Remove-Item -Recurse -Force '$InstallDir'" {
      Remove-Item -Recurse -Force $InstallDir
    }
  }

  Invoke-Step "Cloning repository" "git clone --depth 1 $RepoUrl '$InstallDir'" {
    git clone --depth 1 $RepoUrl $InstallDir | Out-Host
  }

  $sourceDir = $InstallDir
}

Invoke-Step "Installing npm dependencies" "npm --prefix '$sourceDir' install" {
  npm --prefix $sourceDir install | Out-Host
}

Invoke-Step "Installing OpenCode commands" "npm --prefix '$sourceDir' run install:opencode" {
  npm --prefix $sourceDir run install:opencode | Out-Host
}

Write-Host ""
Write-Host "opencode-slave installed successfully."
Write-Host "Source: $sourceDir"
Write-Host "Try: /slave-status"
