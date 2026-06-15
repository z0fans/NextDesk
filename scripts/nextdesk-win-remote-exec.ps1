param(
  [int]$Port = 48766,
  [switch]$Expose,
  [switch]$DownloadCloudflared,
  [string]$CloudflaredPath = "",
  [int]$MaxMinutes = 20
)

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$TokenBytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($TokenBytes)
$Script:Token = -join ($TokenBytes | ForEach-Object { $_.ToString("x2") })
$Script:Deadline = (Get-Date).AddMinutes($MaxMinutes)
$Script:TunnelProcess = $null
$Script:TunnelUrl = $null

function ToJson($Value, [int]$Depth = 8) {
  $Value | ConvertTo-Json -Depth $Depth
}

function SendResponse($Context, [int]$StatusCode, [string]$ContentType, [string]$Body) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
  $Context.Response.StatusCode = $StatusCode
  $Context.Response.ContentType = "$ContentType; charset=utf-8"
  $Context.Response.ContentLength64 = $bytes.Length
  $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Context.Response.OutputStream.Close()
}

function CheckToken($Request) {
  $token = $Request.QueryString["token"]
  return (![string]::IsNullOrWhiteSpace($token) -and [string]::Equals($token, $Script:Token, [System.StringComparison]::Ordinal))
}

function LimitText([string]$Text, [int]$MaxChars = 120000) {
  if ($null -eq $Text) { return "" }
  if ($Text.Length -le $MaxChars) { return $Text }
  return $Text.Substring(0, $MaxChars) + "`n...[truncated]"
}

function ReadSharedText([string]$Path) {
  if (!(Test-Path $Path)) { return "" }
  try {
    $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $reader = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
      try { return $reader.ReadToEnd() } finally { $reader.Close() }
    } finally {
      $fs.Close()
    }
  } catch {
    return ""
  }
}

function ReadRequestBody($Request) {
  $reader = New-Object System.IO.StreamReader($Request.InputStream, [System.Text.Encoding]::UTF8)
  try { return $reader.ReadToEnd() } finally { $reader.Close() }
}

function Invoke-ExecCommand([string]$Command, [int]$TimeoutSeconds = 20) {
  if ([string]::IsNullOrWhiteSpace($Command)) {
    return [pscustomobject]@{ ok = $false; error = "empty command" }
  }
  if ($TimeoutSeconds -lt 1) { $TimeoutSeconds = 1 }
  if ($TimeoutSeconds -gt 120) { $TimeoutSeconds = 120 }

  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($Command))
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "powershell.exe"
  $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded"
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  $started = Get-Date
  [void]$proc.Start()
  $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
  $stderrTask = $proc.StandardError.ReadToEndAsync()
  $exited = $proc.WaitForExit($TimeoutSeconds * 1000)
  if (!$exited) {
    try { $proc.Kill() } catch {}
    try { $proc.WaitForExit(3000) } catch {}
  }
  try { $stdoutTask.Wait(3000) } catch {}
  try { $stderrTask.Wait(3000) } catch {}

  $exitCode = $null
  if ($exited) {
    try { $exitCode = $proc.ExitCode } catch {}
  }
  return [pscustomobject]@{
    ok = $exited -and $exitCode -eq 0
    timedOut = !$exited
    exitCode = $exitCode
    startedAt = $started.ToString("s")
    finishedAt = (Get-Date).ToString("s")
    stdout = LimitText $stdoutTask.Result
    stderr = LimitText $stderrTask.Result
  }
}

function FindCloudflared {
  if ($CloudflaredPath -and (Test-Path $CloudflaredPath)) { return (Resolve-Path $CloudflaredPath).Path }
  $candidates = @(
    (Join-Path $PSScriptRoot "cloudflared.exe"),
    (Join-Path $env:TEMP "cloudflared.exe"),
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "cloudflared.exe")
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) { return $c }
  }
  if ($DownloadCloudflared) {
    $dest = Join-Path $env:TEMP "cloudflared.exe"
    Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $dest
    if (Test-Path $dest) { return $dest }
  }
  return $null
}

function StartTunnel([string]$CloudflaredExe) {
  $outLog = Join-Path $env:TEMP "nextdesk-remote-exec-cloudflared.out.log"
  $errLog = Join-Path $env:TEMP "nextdesk-remote-exec-cloudflared.err.log"
  Remove-Item $outLog,$errLog -ErrorAction SilentlyContinue
  $args = @("tunnel", "--url", "http://127.0.0.1:$Port", "--no-autoupdate")
  $p = Start-Process -FilePath $CloudflaredExe -ArgumentList $args -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 750
    $text = (ReadSharedText $outLog) + "`n" + (ReadSharedText $errLog)
    $m = [regex]::Match($text, "https://[a-zA-Z0-9-]+\.trycloudflare\.com")
    if ($m.Success) {
      $Script:TunnelUrl = $m.Value
      break
    }
  }
  return $p
}

function HandleRequest($Context) {
  $path = $Context.Request.Url.AbsolutePath
  if ($path -eq "/") {
    if (!(CheckToken $Context.Request)) { SendResponse $Context 403 "text/plain" "bad token"; return }
    $body = "NextDesk remote exec is running.`nPOST /api/exec?token=$Script:Token with JSON {`"cmd`":`"Get-Process nextdesk`",`"timeoutSeconds`":20}`nExpires: $($Script:Deadline.ToString("s"))"
    SendResponse $Context 200 "text/plain" $body
    return
  }
  if ($path -eq "/api/health") {
    if (!(CheckToken $Context.Request)) { SendResponse $Context 403 "application/json" '{"error":"bad token"}'; return }
    SendResponse $Context 200 "application/json" (ToJson ([pscustomobject]@{ ok = $true; now = (Get-Date).ToString("s"); expires = $Script:Deadline.ToString("s") }))
    return
  }
  if ($path -eq "/api/exec") {
    if (!(CheckToken $Context.Request)) { SendResponse $Context 403 "application/json" '{"error":"bad token"}'; return }
    if ($Context.Request.HttpMethod -ne "POST") { SendResponse $Context 405 "application/json" '{"error":"POST required"}'; return }
    $payload = ReadRequestBody $Context.Request | ConvertFrom-Json
    $cmd = [string]$payload.cmd
    $timeout = 20
    if ($payload.PSObject.Properties.Name -contains "timeoutSeconds") { $timeout = [int]$payload.timeoutSeconds }
    SendResponse $Context 200 "application/json" (ToJson (Invoke-ExecCommand $cmd $timeout) 6)
    return
  }
  SendResponse $Context 404 "application/json" '{"error":"not found"}'
}

$listener = $null
$boundPort = $null
for ($candidate = $Port; $candidate -lt ($Port + 30); $candidate++) {
  $tryListener = New-Object System.Net.HttpListener
  $prefix = "http://127.0.0.1:$candidate/"
  $tryListener.Prefixes.Add($prefix)
  try {
    $tryListener.Start()
    $listener = $tryListener
    $boundPort = $candidate
    break
  } catch {
    try { $tryListener.Close() } catch {}
  }
}

if ($null -eq $listener) {
  Write-Error "Cannot listen on any local port from $Port to $($Port + 29). Close old diagnostic PowerShell windows or pass another -Port."
  exit 1
}

$Port = $boundPort

if ($Expose) {
  $cf = FindCloudflared
  if (!$cf) {
    Write-Error "cloudflared.exe not found. Use -DownloadCloudflared or pass -CloudflaredPath."
    exit 1
  }
  $Script:TunnelProcess = StartTunnel $cf
}

Write-Host ""
Write-Host "NextDesk remote exec running."
Write-Host "Local:  http://127.0.0.1:$Port/?token=$Script:Token"
if ($Expose -and $Script:TunnelUrl) {
  Write-Host "Remote: $Script:TunnelUrl/?token=$Script:Token"
} elseif ($Expose) {
  Write-Warning "No trycloudflare.com URL detected yet. Check cloudflared logs in $env:TEMP."
}
Write-Host "Expires: $($Script:Deadline.ToString("s"))"
Write-Host "Press Ctrl+C to stop."
Write-Host ""

try {
  $pending = $listener.BeginGetContext($null, $null)
  while ($listener.IsListening -and (Get-Date) -lt $Script:Deadline) {
    if ($pending.AsyncWaitHandle.WaitOne(500)) {
      $ctx = $listener.EndGetContext($pending)
      $pending = $listener.BeginGetContext($null, $null)
      try {
        HandleRequest $ctx
      } catch {
        SendResponse $ctx 500 "application/json" (ToJson ([pscustomobject]@{ error = $_.Exception.Message }) 4)
      }
    }
  }
} finally {
  try { $listener.Stop() } catch {}
  if ($Script:TunnelProcess -and !$Script:TunnelProcess.HasExited) {
    try { $Script:TunnelProcess.Kill() } catch {}
  }
}
