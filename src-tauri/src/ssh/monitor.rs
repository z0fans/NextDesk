use super::session::NextDeskSshClient;
use super::types::{SshMonitorDisk, SshMonitorProcess, SshMonitorSnapshot};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use russh::{client, ChannelMsg};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MONITOR_CHANNEL_OPEN_TIMEOUT: Duration = Duration::from_secs(1);
const MONITOR_LATENCY_TIMEOUT: Duration = Duration::from_secs(2);
const MONITOR_TIMEOUT: Duration = Duration::from_secs(4);
const MONITOR_OUTPUT_LIMIT: usize = 128 * 1024;

const LINUX_MONITOR_COMMAND: &str = r#"LC_ALL=C; export LC_ALL
printf 'nextdesk_monitor_v1\n'
if [ ! -r /proc/uptime ] || [ ! -r /proc/stat ] || [ ! -r /proc/meminfo ]; then
  printf 'unsupported\n'
  exit 0
fi
printf 'platform\tlinux\n'
awk '{printf "uptime\t%.0f\n", $1}' /proc/uptime
awk '{printf "load\t%s\t%s\t%s\n", $1, $2, $3}' /proc/loadavg
awk '/^cpu / { idle=$5+$6; total=0; for (i=2; i<=NF; i++) total+=$i; printf "cpu\t%.0f\t%.0f\n", idle, total; exit }' /proc/stat
awk '
  /^MemTotal:/ { mem_total=$2 }
  /^MemAvailable:/ { mem_available=$2 }
  /^MemFree:/ { mem_free=$2 }
  /^Buffers:/ { buffers=$2 }
  /^Cached:/ { cached=$2 }
  /^SwapTotal:/ { swap_total=$2 }
  /^SwapFree:/ { swap_free=$2 }
  END {
    if (mem_available == 0) mem_available=mem_free+buffers+cached
    mem_used=mem_total-mem_available
    swap_used=swap_total-swap_free
    if (mem_used < 0) mem_used=0
    if (swap_used < 0) swap_used=0
    printf "memory\t%.0f\t%.0f\n", mem_used, mem_total
    printf "swap\t%.0f\t%.0f\n", swap_used, swap_total
  }
' /proc/meminfo
iface=$(awk '$2 == "00000000" && $4 ~ /0003/ { print $1; exit }' /proc/net/route 2>/dev/null)
if [ -z "$iface" ]; then
  iface=$(awk -F '[: ]+' 'NR>2 && $2 != "lo" { print $2; exit }' /proc/net/dev 2>/dev/null)
fi
if [ -n "$iface" ]; then
  awk -v iface="$iface" -F '[: ]+' '$2 == iface { printf "network\t%s\t%.0f\t%.0f\n", $2, $3, $11; exit }' /proc/net/dev
fi
ps -eo rss=,pcpu=,comm= 2>/dev/null | sort -k1,1nr | awk 'NR <= 5 { command=$3; for (i=4; i<=NF; i++) command=command " " $i; gsub(/[\t\r\n]/, " ", command); printf "process\t%.0f\t%s\t%s\n", $1, $2, command }'
df -Pk 2>/dev/null | awk 'NR > 1 && count < 6 && ($1 ~ /^\/dev\// || $NF == "/") { printf "disk\t%s\t%.0f\t%.0f\n", $NF, $4, $2; count++ }'
"#;

const WINDOWS_MONITOR_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output 'nextdesk_monitor_v1'
Write-Output "platform`tWindows"
$os = Get-CimInstance Win32_OperatingSystem
$uptime = [Math]::Max(0, [Math]::Floor(((Get-Date) - $os.LastBootUpTime).TotalSeconds))
Write-Output "uptime`t$uptime"
Write-Output "load`t0`t0`t0"
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
if ($null -eq $cpu) { $cpu = 0 }
Write-Output "cpu_percent`t$([Math]::Round($cpu, 2))"
$memoryTotal = [uint64]$os.TotalVisibleMemorySize
$memoryUsed = $memoryTotal - [uint64]$os.FreePhysicalMemory
Write-Output "memory`t$memoryUsed`t$memoryTotal"
$pageFiles = @(Get-CimInstance Win32_PageFileUsage)
$swapTotal = [uint64](($pageFiles | Measure-Object -Property AllocatedBaseSize -Sum).Sum * 1024)
$swapUsed = [uint64](($pageFiles | Measure-Object -Property CurrentUsage -Sum).Sum * 1024)
Write-Output "swap`t$swapUsed`t$swapTotal"
try {
  $adapter = Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object -First 1
  if ($null -ne $adapter) {
    $stats = Get-NetAdapterStatistics -Name $adapter.Name
    Write-Output "network`t$($adapter.Name -replace "`t", ' ')`t$($stats.ReceivedBytes)`t$($stats.SentBytes)"
  }
} catch {
  # Network adapter cmdlets are not installed on every Windows Server image.
}
try {
  Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |
    Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } |
    Sort-Object WorkingSetPrivate -Descending |
    Select-Object -First 5 |
    ForEach-Object {
      $memoryKiB = [Math]::Floor([double]$_.WorkingSetPrivate / 1024)
      $cpuPercent = [Math]::Round([double]$_.PercentProcessorTime, 2)
      $name = $_.Name -replace "`t", ' '
      Write-Output "process`t$memoryKiB`t$cpuPercent`t$name"
    }
} catch {
  Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 | ForEach-Object {
    $memoryKiB = [Math]::Floor($_.WorkingSet64 / 1024)
    $name = $_.ProcessName -replace "`t", ' '
    Write-Output "process`t$memoryKiB`t0`t$name"
  }
}
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object -First 6 | ForEach-Object {
  $availableKiB = [Math]::Floor($_.FreeSpace / 1024)
  $totalKiB = [Math]::Floor($_.Size / 1024)
  Write-Output "disk`t$($_.DeviceID)`t$availableKiB`t$totalKiB"
}
"#;

#[derive(Debug, Clone, Copy)]
struct CpuCounters {
    idle: u64,
    total: u64,
}

#[derive(Debug, Clone)]
struct NetworkCounters {
    interface: String,
    received: u64,
    transmitted: u64,
    sampled_at: Instant,
}

#[derive(Debug, Default)]
struct RawMonitorSnapshot {
    supported: bool,
    platform: String,
    uptime_seconds: u64,
    load_average: [f64; 3],
    cpu: Option<CpuCounters>,
    cpu_percent: Option<f64>,
    memory_used_bytes: u64,
    memory_total_bytes: u64,
    swap_used_bytes: u64,
    swap_total_bytes: u64,
    processes: Vec<SshMonitorProcess>,
    network: Option<(String, u64, u64)>,
    disks: Vec<SshMonitorDisk>,
}

#[derive(Default)]
pub struct MonitorRuntime {
    previous_cpu: Option<CpuCounters>,
    previous_network: Option<NetworkCounters>,
}

impl MonitorRuntime {
    fn materialize(&mut self, raw: RawMonitorSnapshot, latency_ms: f64) -> SshMonitorSnapshot {
        let sampled_at = Instant::now();

        let cpu_percent = raw.cpu_percent.unwrap_or_else(|| {
            raw.cpu.map_or(0.0, |current| {
                let percent = cpu_percent(self.previous_cpu, current);
                self.previous_cpu = Some(current);
                percent
            })
        });

        let (network_interface, receive_rate, transmit_rate) =
            if let Some((interface, received, transmitted)) = raw.network {
                let (receive_rate, transmit_rate) = network_rates(
                    self.previous_network.as_ref(),
                    &interface,
                    received,
                    transmitted,
                    sampled_at,
                );
                self.previous_network = Some(NetworkCounters {
                    interface: interface.clone(),
                    received,
                    transmitted,
                    sampled_at,
                });
                (Some(interface), receive_rate, transmit_rate)
            } else {
                self.previous_network = None;
                (None, 0.0, 0.0)
            };

        SshMonitorSnapshot {
            supported: raw.supported,
            platform: if raw.platform.is_empty() {
                "unknown".to_string()
            } else {
                raw.platform
            },
            uptime_seconds: raw.uptime_seconds,
            load_average: raw.load_average,
            cpu_percent,
            memory_used_bytes: raw.memory_used_bytes,
            memory_total_bytes: raw.memory_total_bytes,
            swap_used_bytes: raw.swap_used_bytes,
            swap_total_bytes: raw.swap_total_bytes,
            processes: raw.processes,
            network_interface,
            network_receive_bytes_per_second: receive_rate,
            network_transmit_bytes_per_second: transmit_rate,
            latency_ms,
            disks: raw.disks,
        }
    }
}

async fn open_monitor_channel(
    ssh: &client::Handle<NextDeskSshClient>,
) -> Result<russh::Channel<client::Msg>, String> {
    let channel = tokio::time::timeout(MONITOR_CHANNEL_OPEN_TIMEOUT, ssh.channel_open_session())
        .await
        .map_err(|_| "ssh_monitor_channel_open_timeout".to_string())?
        .map_err(|_| "ssh_monitor_channel_open_failed".to_string())?;
    Ok(channel)
}

pub async fn collect_monitor_snapshot(
    ssh: Arc<client::Handle<NextDeskSshClient>>,
    runtime: Arc<Mutex<MonitorRuntime>>,
) -> Result<SshMonitorSnapshot, String> {
    let latency_ms = measure_ssh_latency(ssh.as_ref()).await?;
    let linux_result = async {
        let channel = open_monitor_channel(ssh.as_ref()).await?;
        let output = collect_monitor_output(channel, LINUX_MONITOR_COMMAND).await?;
        parse_monitor_output(&output)
    }
    .await;
    let raw = match linux_result {
        Ok(raw) if raw.supported => raw,
        linux_result => {
            let channel = open_monitor_channel(ssh.as_ref()).await?;
            let output = collect_monitor_output(channel, &windows_monitor_command()).await;
            match output.and_then(|output| parse_monitor_output(&output)) {
                Ok(raw) => raw,
                Err(_) => linux_result?,
            }
        }
    };
    Ok(runtime.lock().unwrap().materialize(raw, latency_ms))
}

async fn measure_ssh_latency(ssh: &client::Handle<NextDeskSshClient>) -> Result<f64, String> {
    tokio::time::timeout(MONITOR_LATENCY_TIMEOUT, async {
        let started_at = Instant::now();
        let mut channel = ssh
            .channel_open_session()
            .await
            .map_err(|_| "ssh_monitor_latency_channel_failed".to_string())?;
        channel
            .exec(true, "echo")
            .await
            .map_err(|_| "ssh_monitor_latency_exec_failed".to_string())?;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::ExitStatus { exit_status: 0 } | ChannelMsg::Eof | ChannelMsg::Close => {
                    return Ok(started_at.elapsed().as_secs_f64() * 1000.0)
                }
                ChannelMsg::ExitStatus { .. } => {
                    return Err("ssh_monitor_latency_exec_failed".to_string())
                }
                _ => {}
            }
        }
        Err("ssh_monitor_latency_channel_closed".to_string())
    })
    .await
    .map_err(|_| "ssh_monitor_latency_timeout".to_string())?
}

async fn collect_monitor_output(
    mut channel: russh::Channel<client::Msg>,
    command: &str,
) -> Result<String, String> {
    tokio::time::timeout(MONITOR_TIMEOUT, async {
        channel
            .exec(true, command)
            .await
            .map_err(|_| "ssh_monitor_exec_failed".to_string())?;

        let mut output = Vec::new();
        let mut exit_status = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if output.len().saturating_add(data.len()) > MONITOR_OUTPUT_LIMIT {
                        return Err("ssh_monitor_output_too_large".to_string());
                    }
                    output.extend_from_slice(&data);
                }
                ChannelMsg::ExitStatus {
                    exit_status: status,
                } => exit_status = Some(status),
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        if exit_status.is_some_and(|status| status != 0) {
            return Err("ssh_monitor_exec_failed".to_string());
        }
        String::from_utf8(output).map_err(|_| "ssh_monitor_output_invalid".to_string())
    })
    .await
    .map_err(|_| "ssh_monitor_timeout".to_string())?
}

fn windows_monitor_command() -> String {
    let encoded_bytes = WINDOWS_MONITOR_SCRIPT
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    format!(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
        BASE64_STANDARD.encode(encoded_bytes)
    )
}

fn parse_monitor_output(output: &str) -> Result<RawMonitorSnapshot, String> {
    let mut lines = output.lines();
    if lines.next() != Some("nextdesk_monitor_v1") {
        return Err("ssh_monitor_output_invalid".to_string());
    }
    let mut snapshot = RawMonitorSnapshot {
        supported: true,
        ..Default::default()
    };
    for line in lines {
        let fields = line.split('\t').collect::<Vec<_>>();
        match fields.as_slice() {
            ["unsupported"] => snapshot.supported = false,
            ["platform", value] => snapshot.platform = value.to_ascii_lowercase(),
            ["uptime", value] => snapshot.uptime_seconds = parse_u64(value)?,
            ["load", one, five, fifteen] => {
                snapshot.load_average = [parse_f64(one)?, parse_f64(five)?, parse_f64(fifteen)?];
            }
            ["cpu", idle, total] => {
                snapshot.cpu = Some(CpuCounters {
                    idle: parse_u64(idle)?,
                    total: parse_u64(total)?,
                });
            }
            ["cpu_percent", value] => snapshot.cpu_percent = Some(parse_f64(value)?),
            ["memory", used, total] => {
                snapshot.memory_used_bytes = kib_to_bytes(parse_u64(used)?);
                snapshot.memory_total_bytes = kib_to_bytes(parse_u64(total)?);
            }
            ["swap", used, total] => {
                snapshot.swap_used_bytes = kib_to_bytes(parse_u64(used)?);
                snapshot.swap_total_bytes = kib_to_bytes(parse_u64(total)?);
            }
            ["network", interface, received, transmitted] if !interface.is_empty() => {
                snapshot.network = Some((
                    interface.to_string(),
                    parse_u64(received)?,
                    parse_u64(transmitted)?,
                ));
            }
            ["process", memory, cpu, command] if !command.is_empty() => {
                if snapshot.processes.len() < 5 {
                    snapshot.processes.push(SshMonitorProcess {
                        memory_bytes: kib_to_bytes(parse_u64(memory)?),
                        cpu_percent: parse_f64(cpu)?,
                        command: command.chars().take(128).collect(),
                    });
                }
            }
            ["disk", path, available, total] if !path.is_empty() => {
                if snapshot.disks.len() < 6 {
                    snapshot.disks.push(SshMonitorDisk {
                        path: path.chars().take(256).collect(),
                        available_bytes: kib_to_bytes(parse_u64(available)?),
                        total_bytes: kib_to_bytes(parse_u64(total)?),
                    });
                }
            }
            _ => {}
        }
    }
    Ok(snapshot)
}

fn parse_u64(value: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|_| "ssh_monitor_output_invalid".to_string())
}

fn parse_f64(value: &str) -> Result<f64, String> {
    let number = value
        .parse::<f64>()
        .map_err(|_| "ssh_monitor_output_invalid".to_string())?;
    if number.is_finite() {
        Ok(number)
    } else {
        Err("ssh_monitor_output_invalid".to_string())
    }
}

fn kib_to_bytes(value: u64) -> u64 {
    value.saturating_mul(1024)
}

fn cpu_percent(previous: Option<CpuCounters>, current: CpuCounters) -> f64 {
    let (idle, total) = if let Some(previous) = previous {
        (
            current.idle.saturating_sub(previous.idle),
            current.total.saturating_sub(previous.total),
        )
    } else {
        (current.idle, current.total)
    };
    if total == 0 {
        return 0.0;
    }
    (100.0 - idle as f64 * 100.0 / total as f64).clamp(0.0, 100.0)
}

fn network_rates(
    previous: Option<&NetworkCounters>,
    interface: &str,
    received: u64,
    transmitted: u64,
    sampled_at: Instant,
) -> (f64, f64) {
    let Some(previous) = previous.filter(|sample| sample.interface == interface) else {
        return (0.0, 0.0);
    };
    let elapsed = sampled_at.duration_since(previous.sampled_at).as_secs_f64();
    if elapsed <= 0.0 {
        return (0.0, 0.0);
    }
    (
        received.saturating_sub(previous.received) as f64 / elapsed,
        transmitted.saturating_sub(previous.transmitted) as f64 / elapsed,
    )
}

#[cfg(test)]
mod tests {
    use super::{cpu_percent, network_rates, parse_monitor_output, CpuCounters, NetworkCounters};
    use std::time::{Duration, Instant};

    #[test]
    fn parses_linux_monitor_output_into_typed_values() {
        let output = "nextdesk_monitor_v1\n\
platform\tlinux\n\
uptime\t219900\n\
load\t0.00\t0.02\t0.00\n\
cpu\t900\t1000\n\
memory\t3145728\t8388608\n\
swap\t0\t0\n\
network\teth0\t1000000\t2000000\n\
process\t70656\t1.0\tomni-rs-bin\n\
disk\t/\t16777216\t20971520\n";

        let parsed = parse_monitor_output(output).unwrap();

        assert!(parsed.supported);
        assert_eq!(parsed.platform, "linux");
        assert_eq!(parsed.uptime_seconds, 219900);
        assert_eq!(parsed.load_average, [0.0, 0.02, 0.0]);
        assert_eq!(parsed.memory_used_bytes, 3 * 1024 * 1024 * 1024);
        assert_eq!(parsed.processes[0].command, "omni-rs-bin");
        assert_eq!(parsed.network.unwrap().0, "eth0");
        assert_eq!(parsed.disks[0].path, "/");
        assert_eq!(parsed.disks[0].available_bytes, 16 * 1024 * 1024 * 1024);
    }

    #[test]
    fn parses_windows_monitor_output_into_typed_values() {
        let output = "nextdesk_monitor_v1\n\
platform\tWindows\n\
uptime\t3600\n\
load\t0\t0\t0\n\
cpu_percent\t27.5\n\
memory\t4194304\t8388608\n\
swap\t1024\t4096\n\
network\tEthernet\t1000000\t2000000\n\
process\t70656\t0\tpowershell\n\
disk\tC:\t16777216\t20971520\n";

        let parsed = parse_monitor_output(output).unwrap();

        assert!(parsed.supported);
        assert_eq!(parsed.platform, "windows");
        assert_eq!(parsed.cpu_percent, Some(27.5));
        assert_eq!(parsed.processes[0].command, "powershell");
        assert_eq!(parsed.disks[0].path, "C:");
    }

    #[test]
    fn calculates_cpu_and_network_rates_from_consecutive_samples() {
        let previous_cpu = CpuCounters {
            idle: 800,
            total: 1000,
        };
        let current_cpu = CpuCounters {
            idle: 850,
            total: 1100,
        };
        assert_eq!(cpu_percent(Some(previous_cpu), current_cpu), 50.0);

        let now = Instant::now();
        let previous_network = NetworkCounters {
            interface: "eth0".to_string(),
            received: 1_000,
            transmitted: 2_000,
            sampled_at: now,
        };
        let (received, transmitted) = network_rates(
            Some(&previous_network),
            "eth0",
            3_048,
            3_024,
            now + Duration::from_secs(2),
        );
        assert_eq!(received, 1024.0);
        assert_eq!(transmitted, 512.0);
    }

    #[test]
    fn reports_unsupported_hosts_without_fabricating_metrics() {
        let parsed = parse_monitor_output("nextdesk_monitor_v1\nunsupported\n").unwrap();
        assert!(!parsed.supported);
        assert_eq!(parsed.memory_total_bytes, 0);
        assert!(parsed.processes.is_empty());
    }
}
