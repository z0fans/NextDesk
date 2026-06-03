use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

#[derive(Default)]
pub struct FreeRdpManager {
    children: HashMap<String, Child>,
    placements: HashMap<String, FreeRdpPlacement>,
    visible: HashMap<String, bool>,
}

impl FreeRdpManager {
    pub fn insert(&mut self, tab_id: String, child: Child) {
        if let Some(mut existing) = self.children.remove(&tab_id) {
            let _ = existing.start_kill();
        }
        self.visible.insert(tab_id.clone(), true);
        self.children.insert(tab_id, child);
    }

    pub fn pid(&self, tab_id: &str) -> Option<u32> {
        self.children.get(tab_id).and_then(Child::id)
    }

    pub fn contains(&self, tab_id: &str) -> bool {
        self.children.contains_key(tab_id)
    }

    pub fn set_placement(&mut self, tab_id: &str, placement: FreeRdpPlacement) {
        self.placements.insert(tab_id.to_string(), placement);
    }

    pub fn placement(&self, tab_id: &str) -> Option<FreeRdpPlacement> {
        self.placements.get(tab_id).copied()
    }

    pub fn set_visible(&mut self, tab_id: &str, visible: bool) {
        self.visible.insert(tab_id.to_string(), visible);
    }

    pub fn is_visible(&self, tab_id: &str) -> bool {
        self.visible.get(tab_id).copied().unwrap_or(false)
    }

    pub fn disconnect(&mut self, tab_id: &str) {
        if let Some(mut child) = self.children.remove(tab_id) {
            let _ = child.start_kill();
        }
        self.placements.remove(tab_id);
        self.visible.remove(tab_id);
    }
}

#[derive(Debug, Clone, Copy)]
pub struct FreeRdpPlacement {
    pub left: i32,
    pub top: i32,
    pub width: u16,
    pub height: u16,
}

#[derive(Debug, Clone)]
pub struct FreeRdpLaunchRequest {
    pub tab_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub domain: Option<String>,
    pub width: u16,
    pub height: u16,
    pub left: i32,
    pub top: i32,
    pub parent_window_id: Option<u64>,
    pub proxy_port: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FreeRdpLaunchInfo {
    pub pid: u32,
    pub executable: String,
    pub route: String,
    pub proxy_port: Option<u16>,
}

pub async fn launch(
    app: &AppHandle,
    request: FreeRdpLaunchRequest,
    manager: Arc<Mutex<FreeRdpManager>>,
) -> Result<FreeRdpLaunchInfo, String> {
    let executable = find_freerdp_executable(app)?;
    let args = build_freerdp_args(&request);
    let route = request
        .proxy_port
        .map(|port| format!("socks5://127.0.0.1:{port}"))
        .unwrap_or_else(|| "direct".to_string());

    log::info!(
        "[freerdp-sidecar] launching tab={} target={}:{} route={} embed_parent={:?} pos={},{} size={}x{} exe={}",
        request.tab_id,
        request.host,
        request.port,
        route,
        request.parent_window_id,
        request.left,
        request.top,
        request.width,
        request.height,
        executable.display()
    );
    log::debug!(
        "[freerdp-sidecar] args={}",
        redact_args_for_log(&args).join(" ")
    );

    let mut child = Command::new(&executable)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| {
            format!(
                "Failed to launch FreeRDP sidecar '{}': {err}",
                executable.display()
            )
        })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(format!("{}\n", request.password).as_bytes())
            .await
            .map_err(|err| format!("Failed to write FreeRDP password to stdin: {err}"))?;
    } else {
        return Err("FreeRDP stdin is unavailable; cannot pass password securely".to_string());
    }

    if let Some(stdout) = child.stdout.take() {
        spawn_log_reader(request.tab_id.clone(), "stdout", stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_log_reader(request.tab_id.clone(), "stderr", stderr);
    }

    let pid = child.id().unwrap_or(0);
    tokio::time::sleep(Duration::from_millis(500)).await;
    if let Some(status) = child
        .try_wait()
        .map_err(|err| format!("Failed to inspect FreeRDP sidecar status: {err}"))?
    {
        return Err(format!(
            "FreeRDP sidecar exited immediately with status {status}. Check FreeRDP logs for launch details."
        ));
    }

    {
        let mut mgr = manager
            .lock()
            .map_err(|err| format!("FreeRDP manager lock failed: {err}"))?;
        mgr.set_placement(
            &request.tab_id,
            FreeRdpPlacement {
                left: request.left,
                top: request.top,
                width: request.width,
                height: request.height,
            },
        );
        mgr.insert(request.tab_id.clone(), child);
    }

    spawn_macos_window_tracker(request.tab_id.clone(), pid, manager.clone());

    Ok(FreeRdpLaunchInfo {
        pid,
        executable: executable.display().to_string(),
        route,
        proxy_port: request.proxy_port,
    })
}

pub fn disconnect(tab_id: &str, manager: Arc<Mutex<FreeRdpManager>>) -> Result<(), String> {
    let mut mgr = manager
        .lock()
        .map_err(|err| format!("FreeRDP manager lock failed: {err}"))?;
    mgr.disconnect(tab_id);
    log::info!("[freerdp-sidecar] disconnected tab={tab_id}");
    Ok(())
}

pub async fn place_window(
    tab_id: &str,
    left: i32,
    top: i32,
    width: u16,
    height: u16,
    manager: Arc<Mutex<FreeRdpManager>>,
) -> Result<(), String> {
    let placement = FreeRdpPlacement {
        left,
        top,
        width,
        height,
    };
    let pid = {
        let mut mgr = manager
            .lock()
            .map_err(|err| format!("FreeRDP manager lock failed: {err}"))?;
        mgr.set_placement(tab_id, placement);
        mgr.pid(tab_id)
    }
    .ok_or_else(|| format!("FreeRDP sidecar process not found for tab {tab_id}"))?;

    place_window_by_pid(tab_id, pid, placement).await
}

pub async fn set_visible(
    tab_id: &str,
    visible: bool,
    manager: Arc<Mutex<FreeRdpManager>>,
) -> Result<(), String> {
    let (pid, placement) = {
        let mut mgr = manager
            .lock()
            .map_err(|err| format!("FreeRDP manager lock failed: {err}"))?;
        mgr.set_visible(tab_id, visible);
        let pid = mgr.pid(tab_id);
        let placement = mgr.placement(tab_id);
        (pid, placement)
    };
    let pid = pid.ok_or_else(|| format!("FreeRDP sidecar process not found for tab {tab_id}"))?;

    set_visible_by_pid(tab_id, pid, visible).await?;
    if visible {
        if let Some(placement) = placement {
            place_window_by_pid(tab_id, pid, placement).await?;
        }
    }
    Ok(())
}

fn spawn_log_reader<R>(tab_id: String, stream_name: &'static str, stream: R)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log::info!("[freerdp-sidecar][{tab_id}][{stream_name}] {line}");
        }
    });
}

fn spawn_macos_window_tracker(tab_id: String, pid: u32, manager: Arc<Mutex<FreeRdpManager>>) {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn(async move {
            let mut failure_count = 0_u32;
            loop {
                let state = {
                    let mgr = match manager.lock() {
                        Ok(mgr) => mgr,
                        Err(err) => {
                            log::warn!("[freerdp-sidecar] tracker lock failed tab={tab_id}: {err}");
                            return;
                        }
                    };
                    if !mgr.contains(&tab_id) {
                        return;
                    }
                    (mgr.is_visible(&tab_id), mgr.placement(&tab_id))
                };

                if let (true, Some(placement)) = state {
                    if let Err(err) = set_macos_window_frame(std::process::id(), pid, placement).await {
                        failure_count += 1;
                        if failure_count == 1 || failure_count % 20 == 0 {
                            log::warn!(
                                "[freerdp-sidecar] macOS tracker placement failed tab={} pid={} error={}",
                                tab_id,
                                pid,
                                err
                            );
                        }
                    } else {
                        failure_count = 0;
                    }
                }

                tokio::time::sleep(Duration::from_millis(120)).await;
            }
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (tab_id, pid, manager);
    }
}

async fn place_window_by_pid(tab_id: &str, pid: u32, placement: FreeRdpPlacement) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        set_macos_window_frame(std::process::id(), pid, placement)
            .await
            .map_err(|err| {
                format!(
                    "Place FreeRDP macOS window failed for tab {tab_id} pid {pid}: {err}"
                )
            })?;
        log::debug!(
            "[freerdp-sidecar] placed macOS window tab={} pid={} pos={},{} size={}x{}",
            tab_id,
            pid,
            placement.left,
            placement.top,
            placement.width,
            placement.height
        );
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (tab_id, pid, placement);
        Ok(())
    }
}

async fn set_visible_by_pid(tab_id: &str, pid: u32, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        set_macos_process_visible(pid, visible)
            .await
            .map_err(|err| {
                format!(
                    "Set FreeRDP macOS visibility failed for tab {tab_id} pid {pid}: {err}"
                )
            })?;
        log::debug!(
            "[freerdp-sidecar] set macOS visibility tab={} pid={} visible={}",
            tab_id,
            pid,
            visible
        );
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (tab_id, pid, visible);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
async fn set_macos_window_frame(
    owner_pid: u32,
    pid: u32,
    placement: FreeRdpPlacement,
) -> Result<(), String> {
    let left = placement.left;
    let top = placement.top;
    let width = placement.width;
    let height = placement.height;
    let script = format!(
        r#"
tell application "System Events"
  set ownerProcess to first process whose unix id is {owner_pid}
  if (count of windows of ownerProcess) is 0 then error "no NextDesk windows"
  set ownerPosition to position of front window of ownerProcess
  set targetLeft to (item 1 of ownerPosition) + {left}
  set targetTop to (item 2 of ownerPosition) + {top}
  set targetProcess to first process whose unix id is {pid}
  if (count of windows of targetProcess) is 0 then error "no FreeRDP windows"
  tell front window of targetProcess
    set position to {{targetLeft, targetTop}}
    set size to {{{width}, {height}}}
    try
      perform action "AXRaise"
    end try
  end tell
end tell
"#
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .await
        .map_err(|err| format!("osascript launch failed: {err}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if stderr.is_empty() {
        format!("osascript exited with {} stdout={stdout}", output.status)
    } else {
        format!("osascript exited with {} stderr={stderr}", output.status)
    })
}

#[cfg(target_os = "macos")]
async fn set_macos_process_visible(pid: u32, visible: bool) -> Result<(), String> {
    let visible_literal = if visible { "true" } else { "false" };
    let script = format!(
        r#"
tell application "System Events"
  set targetProcess to first process whose unix id is {pid}
  set visible of targetProcess to {visible_literal}
  if {visible_literal} then
    if (count of windows of targetProcess) > 0 then
      try
        perform action "AXRaise" of front window of targetProcess
      end try
    end if
  end if
end tell
"#
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .await
        .map_err(|err| format!("osascript launch failed: {err}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if stderr.is_empty() {
        format!("osascript exited with {} stdout={stdout}", output.status)
    } else {
        format!("osascript exited with {} stderr={stderr}", output.status)
    })
}

fn find_freerdp_executable(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("NEXTDESK_FREERDP_BIN") {
        let path = PathBuf::from(path);
        if is_executable_candidate(&path) {
            return Ok(path);
        }
        return Err(format!(
            "NEXTDESK_FREERDP_BIN points to a missing FreeRDP binary: {}",
            path.display()
        ));
    }

    let resource_dir = app.path().resource_dir().ok();
    for path in freerdp_candidate_paths(resource_dir.as_deref()) {
        if is_executable_candidate(&path) {
            return Ok(path);
        }
    }

    Err(format!(
        "FreeRDP sidecar not found. Install FreeRDP or set NEXTDESK_FREERDP_BIN. Checked executable name '{}'.",
        freerdp_executable_name()
    ))
}

fn is_executable_candidate(path: &Path) -> bool {
    path.is_file()
}

fn freerdp_candidate_paths(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let exe = freerdp_executable_name();
    let mut candidates = Vec::new();

    if let Some(resource_dir) = resource_dir {
        candidates.push(resource_dir.join("bin").join("freerdp").join(exe));
        candidates.push(resource_dir.join("bin").join(exe));
        candidates.push(resource_dir.join(exe));
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin").join(exe));
        candidates.push(PathBuf::from("/usr/local/bin").join(exe));
    }

    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join(exe)));
    }

    candidates
}

fn freerdp_executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "sdl-freerdp.exe"
    } else {
        "sdl-freerdp"
    }
}

fn build_freerdp_args(request: &FreeRdpLaunchRequest) -> Vec<String> {
    let mut args = vec![
        format!("/u:{}", request.username),
        "/from-stdin:force".to_string(),
        format!("/v:{}:{}", request.host, request.port),
        "/cert:ignore".to_string(),
        "+clipboard".to_string(),
        "/clipboard:direction-to:all,files-to:all".to_string(),
        "+dynamic-resolution".to_string(),
        "+window-drag".to_string(),
        "-decorations".to_string(),
        "/gfx:progressive:on,AVC420:on,small-cache:on".to_string(),
        "/network:auto".to_string(),
        format!("/size:{}x{}", request.width, request.height),
        "/window-position:-32000x-32000".to_string(),
        format!("/t:FreeRDP: {}", request.host),
        "/log-level:INFO".to_string(),
    ];

    if let Some(parent_window_id) = request.parent_window_id {
        args.push(format!("/parent-window:{parent_window_id}"));
    }

    if let Some(domain) = request
        .domain
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        args.push(format!("/d:{domain}"));
    }

    if let Some(port) = request.proxy_port {
        args.push(format!("/proxy:socks5://127.0.0.1:{port}"));
    }

    args
}

fn redact_args_for_log(args: &[String]) -> Vec<String> {
    args.iter()
        .map(|arg| {
            if arg.starts_with("/p:") {
                "/p:<redacted>".to_string()
            } else {
                arg.clone()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_request(proxy_port: Option<u16>) -> FreeRdpLaunchRequest {
        FreeRdpLaunchRequest {
            tab_id: "tab-1".to_string(),
            host: "rdp.example.com".to_string(),
            port: 3389,
            username: "administrator".to_string(),
            password: "secret".to_string(),
            domain: None,
            width: 1400,
            height: 900,
            left: 10,
            top: 20,
            parent_window_id: Some(12345),
            proxy_port,
        }
    }

    #[test]
    fn freerdp_args_pass_password_through_stdin() {
        let args = build_freerdp_args(&sample_request(None));

        assert!(args.contains(&"/from-stdin:force".to_string()));
        assert!(!args.iter().any(|arg| arg.contains("secret")));
        assert!(args.contains(&"+clipboard".to_string()));
        assert!(args.contains(&"+dynamic-resolution".to_string()));
        assert!(args.contains(&"-decorations".to_string()));
        assert!(args.contains(&"/parent-window:12345".to_string()));
        assert!(args.contains(&"/window-position:-32000x-32000".to_string()));
    }

    #[test]
    fn freerdp_args_include_socks_proxy_when_requested() {
        let args = build_freerdp_args(&sample_request(Some(17897)));

        assert!(args.contains(&"/proxy:socks5://127.0.0.1:17897".to_string()));
    }
}
