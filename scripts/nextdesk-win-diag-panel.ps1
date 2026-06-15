param(
  [int]$Port = 48765,
  [switch]$Expose,
  [switch]$DownloadCloudflared,
  [string]$CloudflaredPath = "",
  [int]$DelayTimeoutMs = 8000,
  [int]$LogTail = 160
)

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function New-DiagToken {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

$Script:Token = New-DiagToken
$Script:StartedAt = Get-Date
$Global:NextDeskDiagCloudflaredLines = New-Object System.Collections.Generic.List[string]
$Global:NextDeskDiagCloudflaredUrl = $null
$Global:NextDeskDiagCloudflaredProcess = $null

function ConvertTo-DiagJson($value, [int]$Depth = 8) {
  $value | ConvertTo-Json -Depth $Depth -Compress
}

function Send-HttpResponse($Context, [int]$StatusCode, [string]$ContentType, [string]$Body) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
  $Context.Response.StatusCode = $StatusCode
  $Context.Response.ContentType = "$ContentType; charset=utf-8"
  $Context.Response.ContentLength64 = $bytes.Length
  $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Context.Response.OutputStream.Close()
}

function Test-Token($Request) {
  $provided = $Request.QueryString["token"]
  if ([string]::IsNullOrWhiteSpace($provided)) { return $false }
  return [string]::Equals($provided, $Script:Token, [System.StringComparison]::Ordinal)
}

function Get-TextFileTail([string]$Path, [int]$Tail = 120) {
  if (!(Test-Path $Path)) {
    return @{
      path = $Path
      exists = $false
      text = ""
    }
  }

  try {
    return @{
      path = $Path
      exists = $true
      text = (Get-Content -Path $Path -Tail $Tail -ErrorAction Stop) -join "`n"
    }
  } catch {
    return @{
      path = $Path
      exists = $true
      error = $_.Exception.Message
      text = ""
    }
  }
}

function Invoke-HttpGetText([string]$Url, [int]$TimeoutMs = 4000) {
  try {
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Proxy = $null
    $req.Timeout = $TimeoutMs
    $req.ReadWriteTimeout = $TimeoutMs
    $req.UserAgent = "NextDeskDiagPanel/1.0"
    $resp = $req.GetResponse()
    try {
      $reader = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
      $body = $reader.ReadToEnd()
      return @{
        ok = $true
        status = [int]$resp.StatusCode
        body = $body
      }
    } finally {
      $resp.Close()
    }
  } catch {
    $status = $null
    $body = ""
    if ($_.Exception.Response -ne $null) {
      $resp = $_.Exception.Response
      $status = [int]$resp.StatusCode
      try {
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $body = $reader.ReadToEnd()
      } catch {}
    }
    return @{
      ok = $false
      status = $status
      error = $_.Exception.Message
      body = $body
    }
  }
}

function ConvertFrom-JsonSafe([string]$Text) {
  try {
    return $Text | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-FirstRegexValue([string]$Text, [string]$Pattern) {
  $m = [regex]::Match($Text, $Pattern, [System.Text.RegularExpressions.RegexOptions]::Multiline)
  if ($m.Success) { return $m.Groups[1].Value.Trim() }
  return $null
}

function Get-NextDeskConfigInfo {
  $cfg = Join-Path $env:APPDATA "NextDesk\runtime_clash.yaml"
  $clashLog = Join-Path $env:APPDATA "NextDesk\log\clash.log"
  $appLog = Join-Path $env:TEMP "nextdesk_debug.log"

  $info = @{
    runtimeConfigPath = $cfg
    clashLogPath = $clashLog
    appLogPath = $appLog
    runtimeConfigExists = Test-Path $cfg
    clashLogExists = Test-Path $clashLog
    appLogExists = Test-Path $appLog
    parsed = @{}
    interestingLines = @()
  }

  if (Test-Path $cfg) {
    try {
      $text = Get-Content $cfg -Raw -ErrorAction Stop
      $info.parsed = @{
        port = Get-FirstRegexValue $text '(?m)^port:\s*(\d+)'
        socksPort = Get-FirstRegexValue $text '(?m)^socks-port:\s*(\d+)'
        externalController = Get-FirstRegexValue $text '(?m)^external-controller:\s*([^\r\n]+)'
        dnsListen = Get-FirstRegexValue $text '(?m)^\s*listen:\s*([^\r\n]+)'
        interfaceName = Get-FirstRegexValue $text "(?m)^interface-name:\s*['""]?([^'""]*)['""]?"
        autoDetectInterface = Get-FirstRegexValue $text '(?m)^\s*auto-detect-interface:\s*(\S+)'
        tunEnable = Get-FirstRegexValue $text '(?m)^\s*enable:\s*(\S+)'
        mode = Get-FirstRegexValue $text '(?m)^mode:\s*(\S+)'
        bindAddress = Get-FirstRegexValue $text '(?m)^bind-address:\s*(\S+)'
      }
      $info.interestingLines = (Select-String -Path $cfg -Pattern "^(port|socks-port|mixed-port|external-controller|bind-address|mode|interface-name):|^\s*(listen|enable|auto-route|auto-detect-interface):" -ErrorAction SilentlyContinue |
        ForEach-Object { "L$($_.LineNumber): $($_.Line.TrimEnd())" })
    } catch {
      $info.error = $_.Exception.Message
    }
  }

  return $info
}

function Get-NextDeskProcesses {
  $items = @()
  foreach ($p in (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq "nextdesk" -or $_.ProcessName -like "nextdesk-core*" })) {
    $path = $null
    $start = $null
    try { $path = $p.Path } catch {}
    try { $start = $p.StartTime.ToString("s") } catch {}
    $items += @{
      name = $p.ProcessName
      id = $p.Id
      path = $path
      startTime = $start
    }
  }
  return $items
}

function Get-ListeningPorts($Processes) {
  $ids = @($Processes | Where-Object { $_.name -like "nextdesk-core*" } | ForEach-Object { $_.id })
  $ports = @()
  try {
    $ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $ids -contains $_.OwningProcess } |
      Sort-Object LocalPort |
      ForEach-Object {
        @{
          localAddress = $_.LocalAddress
          localPort = $_.LocalPort
          owningProcess = $_.OwningProcess
        }
      }
  } catch {
    $ports = @(@{ error = $_.Exception.Message })
  }
  return @($ports)
}

function Get-CandidateApiPorts($ConfigInfo, $ListeningPorts) {
  $set = New-Object System.Collections.Generic.HashSet[int]
  $controller = $ConfigInfo.parsed.externalController
  if ($controller -match ':(\d+)$') { [void]$set.Add([int]$Matches[1]) }
  foreach ($p in $ListeningPorts) {
    if ($p.localAddress -eq "127.0.0.1" -or $p.localAddress -eq "0.0.0.0" -or $p.localAddress -eq "::") {
      [void]$set.Add([int]$p.localPort)
    }
  }
  [void]$set.Add(17891)
  [void]$set.Add(58867)
  return @($set | Sort-Object)
}

function Find-ClashApi($CandidatePorts) {
  $results = @()
  $found = $null
  foreach ($port in $CandidatePorts) {
    $res = Invoke-HttpGetText "http://127.0.0.1:$port/configs" 2500
    $bodyJson = $null
    if ($res.body) { $bodyJson = ConvertFrom-JsonSafe $res.body }
    $isApi = $res.ok -and $bodyJson -ne $null -and ($bodyJson.PSObject.Properties.Name -contains "mode")
    $row = @{
      port = $port
      ok = $res.ok
      status = $res.status
      isClashApi = $isApi
      error = $res.error
    }
    if ($isApi -and $found -eq $null) {
      $found = @{
        port = $port
        configs = $bodyJson
      }
    }
    $results += $row
  }
  return @{
    found = $found
    attempts = $results
  }
}

function Test-SocksConnectivity([int]$SocksPort) {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($null -eq $curl) {
    return @{
      skipped = $true
      reason = "curl.exe not found"
    }
  }

  try {
    $output = & curl.exe -sS -o NUL -w "http_code=%{http_code} time_total=%{time_total} remote_ip=%{remote_ip}" --socks5-hostname "127.0.0.1:$SocksPort" "http://www.gstatic.com/generate_204" --max-time 10 2>&1
    return @{
      ok = ($LASTEXITCODE -eq 0 -and ($output -join "`n") -match "http_code=204")
      exitCode = $LASTEXITCODE
      output = ($output -join "`n")
    }
  } catch {
    return @{
      ok = $false
      error = $_.Exception.Message
    }
  }
}

function Test-ProxyDelays([int]$ApiPort, [int]$TimeoutMs) {
  $proxyRes = Invoke-HttpGetText "http://127.0.0.1:$ApiPort/proxies" 5000
  if (!$proxyRes.ok) {
    return @{
      ok = $false
      error = $proxyRes.error
      status = $proxyRes.status
      body = $proxyRes.body
      nodes = @()
    }
  }

  $json = ConvertFrom-JsonSafe $proxyRes.body
  if ($json -eq $null -or $json.proxies -eq $null) {
    return @{
      ok = $false
      error = "Cannot parse /proxies JSON"
      nodes = @()
    }
  }

  $props = @($json.proxies.PSObject.Properties)
  $nodes = @($props | Where-Object { $_.Name -like "*Server Only*" })
  if ($nodes.Count -eq 0) {
    $nodes = @($props | Where-Object {
      $type = $_.Value.type
      $type -and $type -notin @("Selector", "URLTest", "Fallback", "LoadBalance", "Relay", "Direct", "Reject", "CompatibleProvider")
    } | Select-Object -First 8)
  }

  $results = @()
  foreach ($node in $nodes) {
    $name = $node.Name
    $enc = [System.Uri]::EscapeDataString($name)
    $url = "http://127.0.0.1:$ApiPort/proxies/$enc/delay?url=http%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=$TimeoutMs"
    $res = Invoke-HttpGetText $url ($TimeoutMs + 3000)
    $delayJson = $null
    if ($res.body) { $delayJson = ConvertFrom-JsonSafe $res.body }
    $results += @{
      name = $name
      type = $node.Value.type
      ok = $res.ok
      status = $res.status
      delay = $(if ($delayJson -and ($delayJson.PSObject.Properties.Name -contains "delay")) { $delayJson.delay } else { $null })
      error = $res.error
      body = $res.body
    }
  }

  return @{
    ok = $true
    nodes = $results
  }
}

function New-PortPatchCommand($ConfigInfo, $ApiInfo, $ListeningPorts) {
  if ($ApiInfo.found -eq $null) { return $null }
  $configs = $ApiInfo.found.configs
  $dnsListen = $null
  if ($configs.dns -and $configs.dns.listen) { $dnsListen = $configs.dns.listen }
  $dnsPort = $null
  if ($dnsListen -match ':(\d+)$') { $dnsPort = [int]$Matches[1] }

  $port = $configs.port
  $socksPort = $configs.'socks-port'
  $controller = $ApiInfo.found.port
  if (!$port -or !$socksPort -or !$controller) { return $null }

  $lines = @(
    '$cfg="$env:APPDATA\NextDesk\runtime_clash.yaml"',
    '$backup="$cfg.bak.$(Get-Date -Format yyyyMMdd_HHmmss)"',
    'Copy-Item $cfg $backup -Force',
    '$text = Get-Content $cfg -Raw',
    "`$text = `$text -replace '(?m)^port:\s*\d+', 'port: $port'",
    "`$text = `$text -replace '(?m)^socks-port:\s*\d+', 'socks-port: $socksPort'",
    "`$text = `$text -replace '(?m)^external-controller:\s*127\.0\.0\.1:\d+', 'external-controller: 127.0.0.1:$controller'"
  )
  if ($dnsPort) {
    $lines += "`$text = `$text -replace '(?m)^(\s*listen:\s*)127\.0\.0\.1:\d+', '`${1}127.0.0.1:$dnsPort'"
  }
  $lines += 'Set-Content -Path $cfg -Value $text -Encoding UTF8'
  $lines += 'Write-Host "patched runtime_clash.yaml; backup=$backup"'
  return ($lines -join "`r`n")
}

function Get-Diagnosis {
  $config = Get-NextDeskConfigInfo
  $processes = Get-NextDeskProcesses
  $ports = Get-ListeningPorts $processes
  $api = Find-ClashApi (Get-CandidateApiPorts $config $ports)

  $socksPort = $null
  if ($api.found -and $api.found.configs.'socks-port') {
    $socksPort = [int]$api.found.configs.'socks-port'
  } elseif ($config.parsed.socksPort) {
    $socksPort = [int]$config.parsed.socksPort
  }

  $socks = $null
  if ($socksPort) { $socks = Test-SocksConnectivity $socksPort }

  $delays = $null
  if ($api.found) { $delays = Test-ProxyDelays $api.found.port $DelayTimeoutMs }

  $expectedController = $null
  if ($config.parsed.externalController -match ':(\d+)$') { $expectedController = [int]$Matches[1] }
  $configDrift = $false
  if ($api.found -and $expectedController -and $expectedController -ne $api.found.port) { $configDrift = $true }

  $findings = @()
  if ($processes.Count -eq 0) {
    $findings += @{ level = "error"; text = "未发现 NextDesk/nextdesk-core 进程。" }
  }
  if ($api.found -eq $null) {
    $findings += @{ level = "error"; text = "未发现可用的 Mihomo REST API 端口；连通测试会无法调用 /proxies/delay。" }
  }
  if ($configDrift) {
    $findings += @{ level = "error"; text = "runtime_clash.yaml 的 external-controller 与实际 API 端口不一致，疑似配置被订阅刷新覆盖。" }
  }
  if ($api.found -and $socks -and !$socks.ok) {
    $findings += @{ level = "warn"; text = "SOCKS 代理本地连通测试失败，请优先看端口/核心状态。" }
  }
  if ($delays -and $delays.nodes) {
    $failed = @($delays.nodes | Where-Object { !$_.ok -or $_.status -ge 400 -or $_.error })
    if ($failed.Count -gt 0) {
      $findings += @{ level = "warn"; text = "发现节点 delay 失败；如果 DIRECT/SOCKS 正常，问题可能在节点出站或规则选择。" }
    }
  }
  if ($config.parsed.interfaceName -eq "" -and $config.parsed.autoDetectInterface -eq "true") {
    $findings += @{ level = "info"; text = "interface-name 为空且 auto-detect-interface=true：这是自动寻找网卡，不是固定锁死网卡。" }
  }
  if ($findings.Count -eq 0) {
    $findings += @{ level = "ok"; text = "基础端口、API 与 SOCKS 检查未发现明显异常。" }
  }

  return @{
    generatedAt = (Get-Date).ToString("s")
    uptimeSeconds = [int]((Get-Date) - $Script:StartedAt).TotalSeconds
    host = @{
      computerName = $env:COMPUTERNAME
      userName = $env:USERNAME
      powershell = $PSVersionTable.PSVersion.ToString()
      os = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { "$($_.Caption) build $($_.BuildNumber)" })
    }
    tunnel = @{
      exposed = [bool]$Expose
      url = $Global:NextDeskDiagCloudflaredUrl
      recentLines = @($Global:NextDeskDiagCloudflaredLines | Select-Object -Last 30)
    }
    config = $config
    processes = @($processes)
    listeningPorts = @($ports)
    api = $api
    socks = $socks
    delays = $delays
    patchCommand = New-PortPatchCommand $config $api $ports
    logs = @{
      clash = Get-TextFileTail $config.clashLogPath $LogTail
      app = Get-TextFileTail $config.appLogPath $LogTail
    }
    findings = $findings
  }
}

function Get-IndexHtml {
@'
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NextDesk Windows Diagnostic</title>
  <style>
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#f6f7f9; color:#111827; }
    header { background:#111827; color:white; padding:18px 22px; }
    main { padding:18px 22px 40px; max-width:1280px; margin:0 auto; }
    button { border:1px solid #cbd5e1; background:white; border-radius:7px; padding:8px 12px; cursor:pointer; }
    button:hover { background:#f1f5f9; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap:14px; }
    .card { background:white; border:1px solid #e5e7eb; border-radius:8px; padding:14px; box-shadow:0 1px 2px rgba(0,0,0,.04); }
    .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .pill { display:inline-flex; align-items:center; border-radius:999px; padding:3px 9px; font-size:12px; border:1px solid #d1d5db; background:#fff; }
    .ok { color:#047857; border-color:#a7f3d0; background:#ecfdf5; }
    .warn { color:#92400e; border-color:#fde68a; background:#fffbeb; }
    .error { color:#b91c1c; border-color:#fecaca; background:#fef2f2; }
    .info { color:#1d4ed8; border-color:#bfdbfe; background:#eff6ff; }
    pre { overflow:auto; background:#0b1020; color:#d7e1ff; border-radius:7px; padding:12px; line-height:1.45; font-size:12px; max-height:520px; }
    code { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    td,th { text-align:left; border-bottom:1px solid #e5e7eb; padding:7px 6px; vertical-align:top; }
    .muted { color:#6b7280; }
    .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
  </style>
</head>
<body>
  <header>
    <div class="row">
      <h1 style="margin:0;font-size:20px;">NextDesk Windows Diagnostic</h1>
      <button onclick="refresh()">刷新</button>
      <span id="status" class="muted"></span>
    </div>
  </header>
  <main>
    <section id="findings" class="grid"></section>
    <section class="grid" style="margin-top:14px;">
      <div class="card"><h2>核心状态</h2><div id="core"></div></div>
      <div class="card"><h2>配置摘要</h2><div id="config"></div></div>
      <div class="card"><h2>SOCKS/API 测试</h2><div id="tests"></div></div>
    </section>
    <section class="card" style="margin-top:14px;"><h2>节点 Delay</h2><div id="delays"></div></section>
    <section class="card" style="margin-top:14px;"><h2>建议临时修复命令</h2><p class="muted">只有检测到实际 API 端口时才会生成。复制到对方 Windows PowerShell 里运行。</p><pre id="patch"></pre></section>
    <section class="grid" style="margin-top:14px;">
      <div class="card"><h2>clash.log</h2><pre id="clashlog"></pre></div>
      <div class="card"><h2>nextdesk_debug.log</h2><pre id="applog"></pre></div>
    </section>
    <section class="card" style="margin-top:14px;"><h2>原始 JSON</h2><pre id="raw"></pre></section>
  </main>
  <script>
    const token = new URLSearchParams(location.search).get('token') || '';
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const pill = (text, cls='info') => `<span class="pill ${cls}">${esc(text)}</span>`;
    function table(rows) {
      return `<table>${rows.map(r => `<tr><th>${esc(r[0])}</th><td>${r[1]}</td></tr>`).join('')}</table>`;
    }
    async function refresh() {
      document.getElementById('status').textContent = '加载中...';
      const res = await fetch('/api/snapshot?token=' + encodeURIComponent(token), { cache: 'no-store' });
      if (!res.ok) {
        document.getElementById('status').textContent = '访问失败：' + res.status;
        return;
      }
      const d = await res.json();
      document.getElementById('status').textContent = `生成时间 ${d.generatedAt}，面板运行 ${d.uptimeSeconds}s`;
      document.getElementById('findings').innerHTML = (d.findings || []).map(f => `<div class="card"><span class="pill ${esc(f.level)}">${esc(f.level)}</span><p>${esc(f.text)}</p></div>`).join('');
      document.getElementById('core').innerHTML = table([
        ['Host', esc(`${d.host?.computerName || ''} / ${d.host?.userName || ''}`)],
        ['OS', esc(d.host?.os || '')],
        ['Processes', `<pre>${esc(JSON.stringify(d.processes, null, 2))}</pre>`],
        ['Listening', `<pre>${esc(JSON.stringify(d.listeningPorts, null, 2))}</pre>`],
        ['Tunnel', d.tunnel?.url ? `<a href="${esc(d.tunnel.url)}?token=${encodeURIComponent(token)}" target="_blank">${esc(d.tunnel.url)}</a>` : esc('未启用或等待 cloudflared 输出')]
      ]);
      document.getElementById('config').innerHTML = table([
        ['runtime_clash.yaml', esc(d.config?.runtimeConfigPath || '')],
        ['exists', pill(d.config?.runtimeConfigExists ? 'true' : 'false', d.config?.runtimeConfigExists ? 'ok' : 'error')],
        ['parsed', `<pre>${esc(JSON.stringify(d.config?.parsed || {}, null, 2))}</pre>`],
        ['interesting lines', `<pre>${esc((d.config?.interestingLines || []).join('\\n'))}</pre>`]
      ]);
      const apiFound = d.api?.found;
      document.getElementById('tests').innerHTML = table([
        ['API', apiFound ? pill('127.0.0.1:' + apiFound.port, 'ok') : pill('not found', 'error')],
        ['API attempts', `<pre>${esc(JSON.stringify(d.api?.attempts || [], null, 2))}</pre>`],
        ['SOCKS', `<pre>${esc(JSON.stringify(d.socks || {}, null, 2))}</pre>`]
      ]);
      const nodes = d.delays?.nodes || [];
      document.getElementById('delays').innerHTML = nodes.length
        ? `<table><tr><th>节点</th><th>类型</th><th>状态</th><th>Delay</th><th>错误/响应</th></tr>${nodes.map(n => `<tr><td>${esc(n.name)}</td><td>${esc(n.type)}</td><td>${n.ok && (!n.status || n.status < 400) ? pill('ok','ok') : pill('fail','error')} ${esc(n.status || '')}</td><td>${esc(n.delay || '')}</td><td><code>${esc(n.error || n.body || '')}</code></td></tr>`).join('')}</table>`
        : '<p class="muted">没有可测试节点，或 API 不可用。</p>';
      document.getElementById('patch').textContent = d.patchCommand || '未生成：需要先发现可用的 Mihomo API 端口。';
      document.getElementById('clashlog').textContent = d.logs?.clash?.text || d.logs?.clash?.error || '无';
      document.getElementById('applog').textContent = d.logs?.app?.text || d.logs?.app?.error || '无';
      document.getElementById('raw').textContent = JSON.stringify(d, null, 2);
    }
    refresh();
    setInterval(refresh, 15000);
  </script>
</body>
</html>
'@
}

function Find-Cloudflared([string]$RequestedPath) {
  if (![string]::IsNullOrWhiteSpace($RequestedPath) -and (Test-Path $RequestedPath)) {
    return (Resolve-Path $RequestedPath).Path
  }

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
    $arch = "amd64"
    if ($env:PROCESSOR_ARCHITECTURE -match "86" -and -not [Environment]::Is64BitOperatingSystem) { $arch = "386" }
    $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$arch.exe"
    Write-Host "Downloading cloudflared: $url"
    Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing
    return $target
  }

  return $null
}

function Start-QuickTunnel([string]$ExePath, [int]$LocalPort) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $ExePath
  $psi.Arguments = "tunnel --url http://127.0.0.1:$LocalPort"
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  $handler = {
    if (![string]::IsNullOrWhiteSpace($EventArgs.Data)) {
      $line = $EventArgs.Data
      $Global:NextDeskDiagCloudflaredLines.Add($line)
      if ($line -match 'https://[a-zA-Z0-9-]+\.trycloudflare\.com') {
        $Global:NextDeskDiagCloudflaredUrl = $Matches[0]
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
  Write-Error "Cannot start HTTP listener on $prefix. Try running PowerShell as Administrator or choose another -Port. $($_.Exception.Message)"
  exit 1
}

if ($Expose) {
  $cf = Find-Cloudflared $CloudflaredPath
  if ($null -eq $cf) {
    Write-Warning "cloudflared.exe not found. Re-run with -DownloadCloudflared, install with winget, or pass -CloudflaredPath."
  } else {
    $Global:NextDeskDiagCloudflaredProcess = Start-QuickTunnel $cf $Port
  }
}

Write-Host ""
Write-Host "NextDesk diagnostic panel is running."
Write-Host "Local:  http://127.0.0.1:$Port/?token=$($Script:Token)"
if ($Expose) {
  Write-Host "Cloudflare tunnel requested. Waiting for trycloudflare.com URL..."
  for ($i = 0; $i -lt 30 -and !$Global:NextDeskDiagCloudflaredUrl; $i++) {
    Start-Sleep -Seconds 1
  }
  if ($Global:NextDeskDiagCloudflaredUrl) {
    Write-Host "Remote: $($Global:NextDeskDiagCloudflaredUrl)/?token=$($Script:Token)"
  } else {
    Write-Warning "Tunnel URL not detected yet. Keep this window open and check the dashboard JSON after a moment."
  }
}
Write-Host "Press Ctrl+C to stop."
Write-Host ""

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $path = $ctx.Request.Url.AbsolutePath
    try {
      if ($path -eq "/") {
        Send-HttpResponse $ctx 200 "text/html" (Get-IndexHtml)
      } elseif ($path -eq "/api/snapshot") {
        if (!(Test-Token $ctx.Request)) {
          Send-HttpResponse $ctx 403 "application/json" (ConvertTo-DiagJson @{ error = "bad token" })
        } else {
          Send-HttpResponse $ctx 200 "application/json" (ConvertTo-DiagJson (Get-Diagnosis) 12)
        }
      } else {
        Send-HttpResponse $ctx 404 "application/json" (ConvertTo-DiagJson @{ error = "not found" })
      }
    } catch {
      Send-HttpResponse $ctx 500 "application/json" (ConvertTo-DiagJson @{ error = $_.Exception.Message })
    }
  }
} finally {
  try { $listener.Stop() } catch {}
  if ($Global:NextDeskDiagCloudflaredProcess -and !$Global:NextDeskDiagCloudflaredProcess.HasExited) {
    try { $Global:NextDeskDiagCloudflaredProcess.Kill() } catch {}
  }
}
