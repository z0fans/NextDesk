param(
  [string]$TargetHost = "github.com",
  [int]$TargetPort = 22,
  [string]$ExpectPrefix = "SSH-",
  [int]$ReadyTimeoutMs = 15000,
  [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Invoke-CloudJson {
  param(
    [string]$Method,
    [string]$Path,
    [object]$Body = $null
  )

  $params = @{
    Uri = "$($script:BaseUrl.TrimEnd('/'))$Path"
    Method = $Method
    Headers = @{
      Authorization = "Bearer $script:DeviceToken"
      "X-Device-Id" = $script:DeviceId
    }
    TimeoutSec = 20
    UseBasicParsing = $true
  }
  if ($null -ne $Body) {
    $params.ContentType = "application/json"
    $params.Body = $Body | ConvertTo-Json -Depth 8 -Compress
  }
  $response = Invoke-RestMethod @params
  if ($null -ne $response.data) { return $response.data }
  return $response
}

function Test-RelayEndpoint {
  param(
    [string]$HostName,
    [int]$Port,
    [string]$Prefix,
    [int]$TimeoutMs
  )

  $started = Get-Date
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $pending = $client.BeginConnect($HostName, $Port, $null, $null)
    if (!$pending.AsyncWaitHandle.WaitOne($TimeoutMs)) {
      return [pscustomobject]@{ ok = $false; error = "tcp_connect_timeout"; total_ms = $TimeoutMs }
    }
    $client.EndConnect($pending)
    if ([string]::IsNullOrEmpty($Prefix)) {
      return [pscustomobject]@{
        ok = $true
        banner_prefix = $null
        total_ms = [int] ((Get-Date) - $started).TotalMilliseconds
      }
    }

    $stream = $client.GetStream()
    $stream.ReadTimeout = $TimeoutMs
    $buffer = New-Object byte[] 128
    $read = $stream.Read($buffer, 0, $buffer.Length)
    if ($read -le 0) {
      return [pscustomobject]@{ ok = $false; error = "endpoint_closed"; total_ms = [int] ((Get-Date) - $started).TotalMilliseconds }
    }
    $banner = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
    if (!$banner.StartsWith($Prefix)) {
      return [pscustomobject]@{ ok = $false; error = "unexpected_banner"; total_ms = [int] ((Get-Date) - $started).TotalMilliseconds }
    }
    return [pscustomobject]@{
      ok = $true
      banner_prefix = $banner.Substring(0, [Math]::Min(24, $banner.Length)).Trim()
      total_ms = [int] ((Get-Date) - $started).TotalMilliseconds
    }
  } catch {
    return [pscustomobject]@{ ok = $false; error = "tcp_probe_failed"; total_ms = [int] ((Get-Date) - $started).TotalMilliseconds }
  } finally {
    $client.Close()
  }
}

function Wait-RelayEndpoint {
  param(
    [object]$Endpoint,
    [string]$Prefix,
    [int]$TimeoutMs
  )

  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  $last = $null
  while ((Get-Date) -lt $deadline) {
    $remaining = [int] ($deadline - (Get-Date)).TotalMilliseconds
    $attemptTimeout = [Math]::Min(3000, [Math]::Max(500, $remaining))
    $last = Test-RelayEndpoint -HostName $Endpoint.host -Port ([int] $Endpoint.port) -Prefix $Prefix -TimeoutMs $attemptTimeout
    if ($last.ok) { return $last }
    Start-Sleep -Milliseconds 400
  }
  throw "relay endpoint did not become usable: $($last.error)"
}

function Wait-ForwardingReleased {
  param(
    [object]$Endpoint,
    [string]$Prefix,
    [int]$TimeoutMs
  )

  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  $consecutiveFailures = 0
  while ((Get-Date) -lt $deadline) {
    $remaining = [int] ($deadline - (Get-Date)).TotalMilliseconds
    $attemptTimeout = [Math]::Min(2000, [Math]::Max(500, $remaining))
    $probe = Test-RelayEndpoint -HostName $Endpoint.host -Port ([int] $Endpoint.port) -Prefix $Prefix -TimeoutMs $attemptTimeout
    if (!$probe.ok) {
      $consecutiveFailures += 1
      if ($consecutiveFailures -ge 2) { return }
    } else {
      $consecutiveFailures = 0
    }
    Start-Sleep -Milliseconds 400
  }
  throw "binding cleanup did not release the forwarding endpoint"
}

if ($TargetPort -lt 1 -or $TargetPort -gt 65535) {
  throw "TargetPort must be from 1 to 65535"
}
if ($ReadyTimeoutMs -lt 500) {
  throw "ReadyTimeoutMs must be at least 500"
}
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $env:APPDATA "NextDesk\config.json"
}
if (!(Test-Path $ConfigPath)) {
  throw "NextDesk config not found: $ConfigPath"
}

$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$script:BaseUrl = [string] $config.dashboard_url
if ([string]::IsNullOrWhiteSpace($script:BaseUrl)) {
  $script:BaseUrl = [string] $config.cloud_authorization_base_url
}
$script:DeviceId = [string] $config.cloud_device_id
if ([string]::IsNullOrWhiteSpace($script:BaseUrl) -or [string]::IsNullOrWhiteSpace($script:DeviceId)) {
  throw "NextDesk Cloud Mode is not authorized on this device"
}

$tokenPath = Join-Path (Split-Path $ConfigPath) "cloud_device_$($script:DeviceId).token"
if (!(Test-Path $tokenPath)) {
  throw "cloud device token is not available on this device"
}
$script:DeviceToken = (Get-Content $tokenPath -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($script:DeviceToken)) {
  throw "cloud device token is empty"
}

$status = Invoke-CloudJson -Method Get -Path "/api/v1/connect/me"
if (!$status.account.available) {
  throw "cloud account is unavailable: $($status.account.reason)"
}

$binding = $null
$result = $null
$closeError = $null
try {
  $binding = Invoke-CloudJson -Method Post -Path "/api/v1/connect/bind" -Body @{
    target_host = $TargetHost
    target_port = $TargetPort
    preferred_region = "auto"
    client = @{
      platform = "windows"
      app_version = "cloud-relay-e2e"
    }
  }
  if ([string]::IsNullOrWhiteSpace([string] $binding.binding_id) -or
      [string]::IsNullOrWhiteSpace([string] $binding.endpoint.host) -or
      [int] $binding.endpoint.port -le 0) {
    throw "bind response is missing the binding or endpoint"
  }

  $probe = Wait-RelayEndpoint -Endpoint $binding.endpoint -Prefix $ExpectPrefix -TimeoutMs $ReadyTimeoutMs
  $result = [pscustomobject]@{
    ok = $true
    platform = "win32"
    authorized = $true
    account_available = $true
    binding_active = ([string] $binding.status -eq "active")
    endpoint_host = [string] $binding.endpoint.host
    endpoint_port = [int] $binding.endpoint.port
    protocols = @($binding.endpoint.protocols)
    data_plane_verified = [bool] $probe.ok
    banner_prefix = $probe.banner_prefix
    probe_ms = [int] $probe.total_ms
  }
} finally {
  if ($null -ne $binding -and ![string]::IsNullOrWhiteSpace([string] $binding.binding_id)) {
    try {
      Invoke-CloudJson -Method Post -Path "/api/v1/connect/close" -Body @{ binding_id = $binding.binding_id } | Out-Null
    } catch {
      $closeError = $_
    }
  }
}

if ($null -ne $closeError) {
  throw "binding cleanup failed: $($closeError.Exception.Message)"
}
if ($null -eq $result) {
  throw "relay verification did not produce a result"
}
Wait-ForwardingReleased -Endpoint $binding.endpoint -Prefix $ExpectPrefix -TimeoutMs $ReadyTimeoutMs
$result | Add-Member -NotePropertyName binding_closed -NotePropertyValue $true
$result | Add-Member -NotePropertyName forwarding_released -NotePropertyValue $true
$result | ConvertTo-Json -Depth 5
