$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Resolve-Path (Join-Path $ScriptDir "..")
$OutDir = Join-Path $RootDir ".backend\freerdp\windows\bin"

$candidates = New-Object System.Collections.Generic.List[string]

if ($env:NEXTDESK_FREERDP_BIN) {
  $candidates.Add($env:NEXTDESK_FREERDP_BIN)
}

$cmd = Get-Command "sdl-freerdp.exe" -ErrorAction SilentlyContinue
if ($cmd -and $cmd.Source) {
  $candidates.Add($cmd.Source)
}

$searchRoots = @(
  "$env:ProgramData\chocolatey\lib",
  "$env:ProgramFiles",
  "${env:ProgramFiles(x86)}"
) | Where-Object { $_ -and (Test-Path $_) }

foreach ($root in $searchRoots) {
  Get-ChildItem -Path $root -Recurse -Filter "sdl-freerdp.exe" -ErrorAction SilentlyContinue |
    ForEach-Object { $candidates.Add($_.FullName) }
}

$freerdpBin = $candidates |
  Where-Object { $_ -and (Test-Path $_) } |
  Select-Object -First 1

if (-not $freerdpBin) {
  throw "sdl-freerdp.exe not found. Install FreeRDP or set NEXTDESK_FREERDP_BIN."
}

$freerdpBin = Resolve-Path $freerdpBin
$sourceDir = Split-Path -Parent $freerdpBin

if (Test-Path $OutDir) {
  Remove-Item -Recurse -Force $OutDir
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Copy-Item -Force $freerdpBin (Join-Path $OutDir "sdl-freerdp.exe")

$dlls = Get-ChildItem -Path $sourceDir -Filter "*.dll" -File -ErrorAction SilentlyContinue
foreach ($dll in $dlls) {
  Copy-Item -Force $dll.FullName (Join-Path $OutDir $dll.Name)
}

$dllCount = (Get-ChildItem -Path $OutDir -Filter "*.dll" -File -ErrorAction SilentlyContinue | Measure-Object).Count
if ($dllCount -lt 5) {
  throw "Only copied $dllCount DLL files from $sourceDir. FreeRDP runtime dependencies are incomplete."
}

Write-Host "Packaged FreeRDP for Windows:"
Write-Host "  binary: $(Join-Path $OutDir 'sdl-freerdp.exe')"
Write-Host "  source: $freerdpBin"
Write-Host "  dlls: $dllCount"
