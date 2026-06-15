param(
  [int]$Port = 48765,
  [switch]$Expose,
  [switch]$DownloadCloudflared,
  [string]$CloudflaredPath = "",
  [int]$TimeoutMs = 10000,
  [int]$LogTail = 220
)

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$Script:StartedAt = Get-Date
$TokenBytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($TokenBytes)
$Script:Token = -join ($TokenBytes | ForEach-Object { $_.ToString("x2") })

$Global:NdDiagTunnelUrl = $null
$Global:NdDiagTunnelLines = New-Object System.Collections.Generic.List[string]
$Global:NdDiagTunnelProcess = $null

$DelayUrls = @{
  cloudflare = "http://cp.cloudflare.com/generate_204"
  gstatic = "http://www.gstatic.com/generate_204"
}

function ToJson($Value, [int]$Depth = 12) {
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

function HttpGet($Url, [int]$Timeout = 5000) {
  try {
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Proxy = $null
    $req.Timeout = $Timeout
    $req.ReadWriteTimeout = $Timeout
    $req.UserAgent = "NextDeskDiagV2/1.0"
    $resp = $req.GetResponse()
    try {
      $reader = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
      return [pscustomobject]@{
        ok = $true
        status = [int]$resp.StatusCode
        body = $reader.ReadToEnd()
        error = $null
      }
    } finally {
      $resp.Close()
    }
  } catch {
    $status = $null
    $body = ""
    if ($_.Exception.Response) {
      try {
        $status = [int]$_.Exception.Response.StatusCode
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $body = $reader.ReadToEnd()
      } catch {}
    }
    return [pscustomobject]@{
      ok = $false
      status = $status
      body = $body
      error = $_.Exception.Message
    }
  }
}

function JsonParse($Text) {
  try { return $Text | ConvertFrom-Json } catch { return $null }
}

function MatchValue($Text, $Pattern) {
  $m = [regex]::Match($Text, $Pattern, "Multiline")
  if ($m.Success) { return $m.Groups[1].Value.Trim() }
  return $null
}

function RuntimePath {
  Join-Path $env:APPDATA "NextDesk\runtime_clash.yaml"
}

function ClashLogPath {
  Join-Path $env:APPDATA "NextDesk\log\clash.log"
}

function ReadRuntimeText {
  $path = RuntimePath
  if (!(Test-Path $path)) { return "" }
  return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
}

function GetRuntimeInfo {
  $path = RuntimePath
  $text = ReadRuntimeText
  $urls = @()
  if ($text) {
    $urls = @($text -split "`r?`n" | Select-String "^\s*url:" | ForEach-Object { $_.Line.Trim() })
  }
  return [pscustomobject]@{
    path = $path
    exists = Test-Path $path
    port = MatchValue $text '(?m)^port:\s*(\d+)'
    socksPort = MatchValue $text '(?m)^socks-port:\s*(\d+)'
    externalController = MatchValue $text '(?m)^external-controller:\s*([^\r\n]+)'
    apiPort = $(if ((MatchValue $text '(?m)^external-controller:\s*([^\r\n]+)') -match ':(\d+)$') { [int]$Matches[1] } else { $null })
    dnsListen = MatchValue $text '(?m)^\s*listen:\s*([^\r\n]+)'
    interfaceName = MatchValue $text "(?m)^interface-name:\s*['""]?([^'""]*)['""]?"
    urls = $urls
  }
}

function GetNextDeskProcesses {
  $items = @()
  $ps = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -eq "nextdesk" -or $_.ProcessName -like "nextdesk-core*"
  }
  foreach ($p in $ps) {
    $path = $null
    $start = $null
    $product = $null
    $file = $null
    try { $path = $p.Path } catch {}
    try { $start = $p.StartTime.ToString("s") } catch {}
    if ($path -and (Test-Path $path)) {
      try {
        $vi = (Get-Item $path).VersionInfo
        $product = $vi.ProductVersion
        $file = $vi.FileVersion
      } catch {}
    }
    $items += [pscustomobject]@{
      name = $p.ProcessName
      id = $p.Id
      path = $path
      startTime = $start
      productVersion = $product
      fileVersion = $file
    }
  }
  return @($items)
}

function FindApi {
  $rt = GetRuntimeInfo
  $ports = @()
  if ($rt.apiPort) { $ports += [int]$rt.apiPort }
  $ports += 17891, 58867
  $ports = @($ports | Sort-Object -Unique)
  $attempts = @()
  $found = $null
  foreach ($port in $ports) {
    $r = HttpGet "http://127.0.0.1:$port/configs" 2500
    $json = JsonParse $r.body
    $isApi = $r.ok -and $json -and ($json.PSObject.Properties.Name -contains "mode")
    $attempts += [pscustomobject]@{ port = $port; ok = $r.ok; status = $r.status; isApi = $isApi; error = $r.error }
    if ($isApi -and $found -eq $null) {
      $found = [pscustomobject]@{ port = $port; configs = $json }
    }
  }
  return [pscustomobject]@{ found = $found; attempts = @($attempts) }
}

function GetProxySnapshot {
  $api = FindApi
  if (!$api.found) { return [pscustomobject]@{ ok = $false; error = "api not found" } }
  $r = HttpGet "http://127.0.0.1:$($api.found.port)/proxies" 5000
  return [pscustomobject]@{
    ok = $r.ok
    status = $r.status
    error = $r.error
    apiPort = $api.found.port
    json = $(if ($r.body) { JsonParse $r.body } else { $null })
  }
}

function GetNodeNamesFromRuntime {
  $text = ReadRuntimeText
  if (!$text) { return @() }
  return @([regex]::Matches($text, '(?m)^\s*-\s*name:\s*(.+Server Only.+)$') |
    ForEach-Object { $_.Groups[1].Value.Trim() } |
    Select-Object -First 20)
}

function TestNodeDelay($TestUrl) {
  $api = FindApi
  if (!$api.found) { return [pscustomobject]@{ ok = $false; error = "api not found"; nodes = @() } }
  $results = @()
  foreach ($name in (GetNodeNamesFromRuntime)) {
    $encName = [System.Uri]::EscapeDataString($name)
    $encUrl = [System.Uri]::EscapeDataString($TestUrl)
    $url = "http://127.0.0.1:$($api.found.port)/proxies/$encName/delay?url=$encUrl&timeout=$TimeoutMs"
    $r = HttpGet $url ($TimeoutMs + 3000)
    $json = JsonParse $r.body
    $results += [pscustomobject]@{
      name = $name
      testUrl = $TestUrl
      ok = $r.ok
      status = $r.status
      delay = $(if ($json -and ($json.PSObject.Properties.Name -contains "delay")) { $json.delay } else { $null })
      error = $r.error
      body = $r.body
    }
  }
  return [pscustomobject]@{ ok = $true; apiPort = $api.found.port; nodes = @($results) }
}

function TestAutoGroups {
  $snapshot = GetProxySnapshot
  if (!$snapshot.ok -or !$snapshot.json) { return $snapshot }
  $items = @()
  foreach ($p in $snapshot.json.proxies.PSObject.Properties) {
    if ($p.Name -like "*Auto*") {
      $items += [pscustomobject]@{
        name = $p.Name
        type = $p.Value.type
        now = $p.Value.now
        alive = $p.Value.alive
        history = $p.Value.history
      }
    }
  }
  return [pscustomobject]@{ ok = $true; apiPort = $snapshot.apiPort; groups = @($items) }
}

function TestSocks($TargetUrl) {
  $rt = GetRuntimeInfo
  if (!$rt.socksPort) { return [pscustomobject]@{ ok = $false; error = "socks port not found" } }
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if (!$curl) { return [pscustomobject]@{ ok = $false; error = "curl.exe not found" } }
  try {
    $out = & curl.exe -sS -o NUL -w "http_code=%{http_code} time_total=%{time_total}" --socks5-hostname "127.0.0.1:$($rt.socksPort)" $TargetUrl --max-time 15 2>&1
    $text = ($out -join "`n")
    return [pscustomobject]@{
      ok = ($LASTEXITCODE -eq 0 -and $text -match "http_code=204")
      socksPort = $rt.socksPort
      targetUrl = $TargetUrl
      exitCode = $LASTEXITCODE
      output = $text
    }
  } catch {
    return [pscustomobject]@{ ok = $false; socksPort = $rt.socksPort; targetUrl = $TargetUrl; error = $_.Exception.Message }
  }
}

function QueryDns($Name) {
  if ($Name -notmatch '^[A-Za-z0-9._-]+$') {
    return [pscustomobject]@{ ok = $false; error = "invalid DNS name" }
  }
  $api = FindApi
  if (!$api.found) { return [pscustomobject]@{ ok = $false; error = "api not found" } }
  $url = "http://127.0.0.1:$($api.found.port)/dns/query?name=$Name&type=A"
  $r = HttpGet $url 5000
  return [pscustomobject]@{ ok = $r.ok; status = $r.status; name = $Name; body = $(JsonParse $r.body); error = $r.error }
}

function TestRdpTarget($Host, [int]$TargetPort) {
  if ($Host -notmatch '^[A-Za-z0-9._-]+$') {
    return [pscustomobject]@{ ok = $false; error = "invalid host" }
  }
  if ($TargetPort -le 0 -or $TargetPort -gt 65535) {
    return [pscustomobject]@{ ok = $false; error = "invalid port" }
  }
  $rt = GetRuntimeInfo
  if (!$rt.socksPort) { return [pscustomobject]@{ ok = $false; error = "socks port not found" } }
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if (!$curl) { return [pscustomobject]@{ ok = $false; error = "curl.exe not found" } }
  try {
    $out = & curl.exe -v --socks5-hostname "127.0.0.1:$($rt.socksPort)" "telnet://$Host`:$TargetPort" --max-time 15 2>&1
    $text = ($out -join "`n")
    return [pscustomobject]@{
      ok = ($LASTEXITCODE -eq 0 -or $text -match "SOCKS5 request granted")
      host = $Host
      port = $TargetPort
      socksPort = $rt.socksPort
      exitCode = $LASTEXITCODE
      output = $text
    }
  } catch {
    return [pscustomobject]@{ ok = $false; host = $Host; port = $TargetPort; socksPort = $rt.socksPort; error = $_.Exception.Message }
  }
}

function TailLogs {
  $path = ClashLogPath
  if (!(Test-Path $path)) { return [pscustomobject]@{ exists = $false; path = $path; text = "" } }
  return [pscustomobject]@{
    exists = $true
    path = $path
    text = ((Get-Content $path -Tail $LogTail -ErrorAction SilentlyContinue) -join "`n")
  }
}

function Snapshot {
  return [pscustomobject]@{
    generatedAt = (Get-Date).ToString("s")
    uptimeSeconds = [int]((Get-Date) - $Script:StartedAt).TotalSeconds
    processes = GetNextDeskProcesses
    runtime = GetRuntimeInfo
    api = FindApi
    autoGroups = TestAutoGroups
    socksCloudflare = TestSocks $DelayUrls.cloudflare
    dnsCloudflare = QueryDns "cp.cloudflare.com"
    dnsGstatic = QueryDns "www.gstatic.com"
    logs = TailLogs
    tunnel = [pscustomobject]@{
      url = $Global:NdDiagTunnelUrl
      recentLines = @($Global:NdDiagTunnelLines | Select-Object -Last 30)
    }
  }
}

function RunAction($Request) {
  $action = $Request.QueryString["action"]
  switch ($action) {
    "snapshot" { return Snapshot }
    "version" { return [pscustomobject]@{ processes = GetNextDeskProcesses } }
    "runtime" { return GetRuntimeInfo }
    "api" { return FindApi }
    "auto-groups" { return TestAutoGroups }
    "socks-cloudflare" { return TestSocks $DelayUrls.cloudflare }
    "socks-gstatic" { return TestSocks $DelayUrls.gstatic }
    "delay-cloudflare" { return TestNodeDelay $DelayUrls.cloudflare }
    "delay-gstatic" { return TestNodeDelay $DelayUrls.gstatic }
    "dns-cloudflare" { return QueryDns "cp.cloudflare.com" }
    "dns-gstatic" { return QueryDns "www.gstatic.com" }
    "logs" { return TailLogs }
    "rdp-target" {
      $hostName = $Request.QueryString["host"]
      $portText = $Request.QueryString["port"]
      $targetPort = 3389
      if ($portText) { [void][int]::TryParse($portText, [ref]$targetPort) }
      return TestRdpTarget $hostName $targetPort
    }
    default {
      return [pscustomobject]@{
        ok = $false
        error = "unknown action"
        allowed = @("snapshot","version","runtime","api","auto-groups","socks-cloudflare","socks-gstatic","delay-cloudflare","delay-gstatic","dns-cloudflare","dns-gstatic","logs","rdp-target")
      }
    }
  }
}

function IndexHtml {
@"
<!doctype html>
<meta charset="utf-8">
<title>NextDesk Diagnostics v2</title>
<pre>
NextDesk Diagnostics v2

Token is required on every endpoint.

JSON:
  /api/snapshot?token=$Script:Token
  /api/action?token=$Script:Token&action=version
  /api/action?token=$Script:Token&action=runtime
  /api/action?token=$Script:Token&action=auto-groups
  /api/action?token=$Script:Token&action=socks-cloudflare
  /api/action?token=$Script:Token&action=delay-cloudflare
  /api/action?token=$Script:Token&action=logs
  /api/action?token=$Script:Token&action=rdp-target&host=HOST&port=3389

No arbitrary shell execution is exposed.
</pre>
"@
}

function FindCloudflared {
  if ($CloudflaredPath -and (Test-Path $CloudflaredPath)) { return (Resolve-Path $CloudflaredPath).Path }
  $cmd = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path (Get-Location) "cloudflared.exe"),
    (Join-Path $env:TEMP "cloudflared.exe"),
    (Join-Path ([Environment]::GetFolderPath("UserProfile")) "Downloads\cloudflared.exe"),
    (Join-Path ([Environment]::GetFolderPath("UserProfile")) "Downloads\cloudflared-windows-amd64.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
  }
  if ($DownloadCloudflared) {
    $target = Join-Path $env:TEMP "cloudflared.exe"
    $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    Write-Host "Downloading cloudflared: $url"
    Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing
    return $target
  }
  return $null
}

function StartTunnel($Exe, [int]$LocalPort) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.Arguments = "tunnel --url http://127.0.0.1:$LocalPort"
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  $handler = {
    if ($EventArgs.Data) {
      $line = $EventArgs.Data
      $Global:NdDiagTunnelLines.Add($line)
      if ($line -match 'https://[a-zA-Z0-9-]+\.trycloudflare\.com') {
        $Global:NdDiagTunnelUrl = $Matches[0]
      }
    }
  }
  Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action $handler | Out-Null
  Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action $handler | Out-Null
  [void]$proc.Start()
  $proc.BeginOutputReadLine()
  $proc.BeginErrorReadLine()
  return $proc
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://127.0.0.1:$Port/"
$listener.Prefixes.Add($prefix)
try {
  $listener.Start()
} catch {
  Write-Error "Cannot listen on $prefix. Try another -Port or run PowerShell as Administrator. $($_.Exception.Message)"
  exit 1
}

if ($Expose) {
  $cf = FindCloudflared
  if ($cf) {
    $Global:NdDiagTunnelProcess = StartTunnel $cf $Port
  } else {
    Write-Warning "cloudflared.exe not found. Use -DownloadCloudflared or pass -CloudflaredPath."
  }
}

Write-Host ""
Write-Host "NextDesk diagnostic panel v2 running."
Write-Host "Local:  http://127.0.0.1:$Port/?token=$($Script:Token)"
if ($Expose) {
  Write-Host "Waiting for Cloudflare tunnel URL..."
  for ($i = 0; $i -lt 35 -and !$Global:NdDiagTunnelUrl; $i++) {
    Start-Sleep -Seconds 1
  }
  if ($Global:NdDiagTunnelUrl) {
    Write-Host "Remote: $($Global:NdDiagTunnelUrl)/?token=$($Script:Token)"
  } else {
    Write-Warning "No trycloudflare.com URL detected yet. Keep this window open."
  }
}
Write-Host "Press Ctrl+C to stop."
Write-Host ""

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try {
      $path = $ctx.Request.Url.AbsolutePath
      if ($path -eq "/") {
        if (!(CheckToken $ctx.Request)) {
          SendResponse $ctx 403 "text/plain" "bad token"
        } else {
          SendResponse $ctx 200 "text/html" (IndexHtml)
        }
      } elseif ($path -eq "/api/snapshot") {
        if (!(CheckToken $ctx.Request)) {
          SendResponse $ctx 403 "application/json" '{"error":"bad token"}'
        } else {
          SendResponse $ctx 200 "application/json" (ToJson (Snapshot) 14)
        }
      } elseif ($path -eq "/api/action") {
        if (!(CheckToken $ctx.Request)) {
          SendResponse $ctx 403 "application/json" '{"error":"bad token"}'
        } else {
          SendResponse $ctx 200 "application/json" (ToJson (RunAction $ctx.Request) 14)
        }
      } else {
        SendResponse $ctx 404 "application/json" '{"error":"not found"}'
      }
    } catch {
      SendResponse $ctx 500 "application/json" (ToJson ([pscustomobject]@{ error = $_.Exception.Message }) 4)
    }
  }
} finally {
  try { $listener.Stop() } catch {}
  if ($Global:NdDiagTunnelProcess -and !$Global:NdDiagTunnelProcess.HasExited) {
    try { $Global:NdDiagTunnelProcess.Kill() } catch {}
  }
}
