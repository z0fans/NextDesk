$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Resolve-Path (Join-Path $ScriptDir "..")
$OutDir = Join-Path $RootDir ".backend\freerdp\windows\bin"
$ExecutableNames = @(
  "wfreerdp.exe",
  "sdl3-freerdp.exe",
  "sdl2-freerdp.exe",
  "sdl-freerdp.exe"
)

$candidates = New-Object System.Collections.Generic.List[string]

if ($env:NEXTDESK_FREERDP_BIN) {
  $candidates.Add($env:NEXTDESK_FREERDP_BIN)
}

$searchRoots = @(
  "$env:ProgramData\chocolatey\lib",
  "$env:ProgramFiles",
  "${env:ProgramFiles(x86)}"
) | Where-Object { $_ -and (Test-Path $_) }

foreach ($root in $searchRoots) {
  foreach ($exeName in $ExecutableNames) {
    Get-ChildItem -Path $root -Recurse -Filter $exeName -ErrorAction SilentlyContinue |
      ForEach-Object { $candidates.Add($_.FullName) }
  }
}

foreach ($exeName in $ExecutableNames) {
  $cmd = Get-Command $exeName -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) {
    $candidates.Add($cmd.Source)
  }
}

$freerdpBin = $candidates |
  Where-Object { $_ -and (Test-Path $_) } |
  Select-Object -First 1

if (-not $freerdpBin) {
  Write-Host "Searched for FreeRDP executables: $($ExecutableNames -join ', ')"
  Write-Host "Search roots:"
  foreach ($root in $searchRoots) {
    Write-Host "  $root"
  }
  throw "FreeRDP client executable not found. Install FreeRDP or set NEXTDESK_FREERDP_BIN."
}

$freerdpBin = Resolve-Path $freerdpBin
$sourceDir = Split-Path -Parent $freerdpBin
$targetName = Split-Path -Leaf $freerdpBin

if (Test-Path $OutDir) {
  Remove-Item -Recurse -Force $OutDir
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Copy-Item -Force $freerdpBin (Join-Path $OutDir $targetName)

$dlls = Get-ChildItem -Path $sourceDir -Filter "*.dll" -File -ErrorAction SilentlyContinue
foreach ($dll in $dlls) {
  Copy-Item -Force $dll.FullName (Join-Path $OutDir $dll.Name)
}

$dllCount = (Get-ChildItem -Path $OutDir -Filter "*.dll" -File -ErrorAction SilentlyContinue | Measure-Object).Count
if ($dllCount -eq 0) {
  Write-Host "No adjacent DLL files found. Treating $targetName as a self-contained FreeRDP portable executable."
}

Write-Host "Packaged FreeRDP for Windows:"
Write-Host "  binary: $(Join-Path $OutDir $targetName)"
Write-Host "  source: $freerdpBin"
Write-Host "  dlls: $dllCount"
