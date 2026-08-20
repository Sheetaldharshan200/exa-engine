#Requires -Version 5
# exa installer for Windows:  irm https://raw.githubusercontent.com/Sheetaldharshan200/exa-engine/main/install.ps1 | iex
# Installs the latest release binary to $env:LOCALAPPDATA\Programs\exa and adds it to the user PATH.
$ErrorActionPreference = "Stop"

$Repo = "Sheetaldharshan200/exa-engine"
$Arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "arm64" } else { "x64" }
$Asset = "exa-windows-$Arch.zip"

$Release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "exa-install" }
$Tag = $Release.tag_name
$Url = "https://github.com/$Repo/releases/download/$Tag/$Asset"

$Dir = Join-Path $env:LOCALAPPDATA "Programs\exa"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Zip = Join-Path $env:TEMP "exa-install.zip"

Write-Host "installing exa $Tag ($Asset)" -ForegroundColor Green
Invoke-WebRequest $Url -OutFile $Zip -UseBasicParsing
Expand-Archive -Path $Zip -DestinationPath $Dir -Force
Remove-Item $Zip -Force

# The archive contains exa.exe at its root; expose that directory on the user PATH.
$Bin = $Dir
if (-not (Test-Path (Join-Path $Bin "exa.exe"))) {
  # tolerate a bin\ layout should a future release move it
  $Bin = Join-Path $Dir "bin"
  if (-not (Test-Path (Join-Path $Bin "exa.exe"))) { throw "exa.exe not found after extraction — the release layout changed." }
}
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$Bin*") {
  [Environment]::SetEnvironmentVariable("Path", "$UserPath;$Bin", "User")
  Write-Host "added $Bin to your user PATH (new terminals will see it)"
}

Write-Host ""
Write-Host "done. start the terminal agent with:  exa" -ForegroundColor Green
Write-Host "      or the browser UI with:        exa web"
