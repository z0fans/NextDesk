# FlClash-Compatible Delay Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NextDesk's built-in Clash/Mihomo plane behave like a normal Clash client on Windows and macOS: real proxy nodes must produce reliable delay results before RDP consumes the SOCKS acceleration path.

**Architecture:** Keep NextDesk's product-specific RDP rules and private SOCKS plane, but align the delay-test behavior with FlClash: default to gstatic, test each real proxy independently, store testing/success/failure states explicitly, and expose diagnostics when the proxy plane fails. Do not copy FlClash GPL code; reimplement the behavior in Rust/Tauri and React.

**Tech Stack:** Tauri 2, Rust, reqwest, serde/serde_yaml/serde_json, React 19, TypeScript, existing Mihomo sidecar and REST API.

---

## File Structure

- Modify `src-tauri/src/config.rs`
  - Owns runtime YAML generation.
  - Change the default delay URL back to gstatic.
  - Keep dynamic ports, empty `interface-name`, fake-ip DNS template, and RDP-only rules.
  - Add tests for generated fallback groups and URL ordering.

- Modify `src-tauri/src/clash.rs`
  - Owns Mihomo process control and REST calls.
  - Replace final delay verdict with per-node `/proxies/{node}/delay` testing.
  - Keep compatibility with the current `HashMap<String, i64>` command response.
  - Add structured details for diagnostics.

- Modify `src-tauri/src/state.rs`
  - Add serializable structs only if the structured delay result is shared across commands.
  - Keep simple structs close to `clash.rs` if they are internal.

- Modify `src-tauri/src/lib.rs`
  - Keep existing `test_group_delays` command stable for the UI.
  - Add `test_group_delay_details` or `get_proxy_plane_diagnostics` for troubleshooting.

- Modify `frontend/src/api.ts`
  - Add TypeScript types for delay details and diagnostics.
  - Keep `testGroupDelays()` returning `Record<string, number>` for existing UI compatibility.

- Modify `frontend/src/App.tsx`
  - Mark nodes as `0` while testing, `>0` on success, `-1` on failure.
  - Display `0` as testing state, `-1` as `--`, and keep positive delays as `Nms`.
  - Avoid showing subgroup delay values as if they were real node delay values.

- Optional follow-up: Modify `scripts/nextdesk-win-diag-panel-v2.ps1`
  - Align the support script with the new delay URL order and structured diagnostics.

---

## Task 1: Lock The FlClash-Compatible Runtime Delay URL

**Files:**
- Modify: `src-tauri/src/config.rs`

- [ ] **Step 1: Write failing tests for default URL and runtime fallback groups**

Add or replace the existing Cloudflare-specific test in `src-tauri/src/config.rs`:

```rust
#[test]
fn default_delay_url_matches_flclash_baseline() {
    assert_eq!(
        PROXY_DELAY_TEST_URL,
        "https://www.gstatic.com/generate_204"
    );
}

#[test]
fn fallback_groups_use_gstatic_delay_url() {
    let groups = build_rdp_runtime_proxy_groups(&[
        "🇺🇸 US Server Only 01".to_string(),
        "🇺🇸 US Server Only 02".to_string(),
    ]);
    let fallback = groups
        .iter()
        .find(|group| group.group_type == "fallback")
        .expect("runtime groups should include fallback groups");
    let yaml = proxy_group_to_yaml(fallback);
    let map = yaml.as_mapping().expect("group yaml should be a map");

    assert_eq!(
        map.get(&ykey("url")).and_then(serde_yaml::Value::as_str),
        Some("https://www.gstatic.com/generate_204")
    );
}
```

- [ ] **Step 2: Run the targeted tests and verify they fail**

Run:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri
cargo test default_delay_url_matches_flclash_baseline fallback_groups_use_gstatic_delay_url
```

Expected: the tests fail because `PROXY_DELAY_TEST_URL` is currently `http://cp.cloudflare.com/generate_204`.

- [ ] **Step 3: Change the default URL**

Change:

```rust
pub(crate) const PROXY_DELAY_TEST_URL: &str = "http://cp.cloudflare.com/generate_204";
```

to:

```rust
pub(crate) const PROXY_DELAY_TEST_URL: &str = "https://www.gstatic.com/generate_204";
```

- [ ] **Step 4: Run the targeted tests and verify they pass**

Run:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri
cargo test default_delay_url_matches_flclash_baseline fallback_groups_use_gstatic_delay_url
```

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/config.rs
git commit -m "fix(clash): 对齐默认测速地址"
```

---

## Task 2: Make Per-Node Delay The Final Truth

**Files:**
- Modify: `src-tauri/src/clash.rs`
- Test: `src-tauri/src/clash.rs`

- [ ] **Step 1: Add a URL queue and structured internal result**

In `src-tauri/src/clash.rs`, replace the current URL slice:

```rust
const PROXY_DELAY_TEST_URLS: &[&str] =
    &[PROXY_DELAY_TEST_URL, "http://www.gstatic.com/generate_204"];
```

with:

```rust
const PROXY_DELAY_TEST_URLS: &[&str] = &[
    PROXY_DELAY_TEST_URL,
    "http://www.gstatic.com/generate_204",
    "http://cp.cloudflare.com/generate_204",
    "http://www.msftconnecttest.com/connecttest.txt",
];

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyDelayDetail {
    pub name: String,
    pub delay: i64,
    pub url: Option<String>,
    pub status: String,
    pub error: Option<String>,
}

impl ProxyDelayDetail {
    fn testing(name: &str) -> Self {
        Self {
            name: name.to_string(),
            delay: 0,
            url: None,
            status: "testing".to_string(),
            error: None,
        }
    }

    fn success(name: &str, url: &str, delay: i64) -> Self {
        Self {
            name: name.to_string(),
            delay: normalize_delay(delay),
            url: Some(url.to_string()),
            status: "ok".to_string(),
            error: None,
        }
    }

    fn failed(name: &str, error: String) -> Self {
        Self {
            name: name.to_string(),
            delay: -1,
            url: None,
            status: "failed".to_string(),
            error: Some(error),
        }
    }
}
```

- [ ] **Step 2: Write a pure unit test for URL order**

Add:

```rust
#[cfg(test)]
mod tests {
    use super::{PROXY_DELAY_TEST_URLS, ProxyDelayDetail};

    #[test]
    fn delay_url_order_matches_flclash_first() {
        assert_eq!(
            PROXY_DELAY_TEST_URLS[0],
            "https://www.gstatic.com/generate_204"
        );
        assert!(PROXY_DELAY_TEST_URLS.contains(&"http://www.gstatic.com/generate_204"));
        assert!(PROXY_DELAY_TEST_URLS.contains(&"http://cp.cloudflare.com/generate_204"));
        assert!(PROXY_DELAY_TEST_URLS.contains(&"http://www.msftconnecttest.com/connecttest.txt"));
    }

    #[test]
    fn proxy_delay_detail_uses_flclash_state_values() {
        assert_eq!(ProxyDelayDetail::testing("node").delay, 0);
        assert_eq!(ProxyDelayDetail::success("node", "url", 123).delay, 123);
        assert_eq!(ProxyDelayDetail::failed("node", "boom".into()).delay, -1);
    }
}
```

- [ ] **Step 3: Run the new tests**

Run:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri
cargo test delay_url_order_matches_flclash_first proxy_delay_detail_uses_flclash_state_values
```

Expected: pass after Task 1 has changed the default URL.

- [ ] **Step 4: Extract per-node delay testing**

Add this helper to `src-tauri/src/clash.rs`:

```rust
async fn test_proxy_delay_detail(api_base: &str, proxy_name: &str) -> ProxyDelayDetail {
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .no_proxy()
        .build()
        .unwrap_or_default();
    let encoded = encode_proxy_name(proxy_name);
    let endpoint = format!("{api_base}/proxies/{encoded}/delay");
    let mut errors = Vec::new();

    for test_url in PROXY_DELAY_TEST_URLS {
        let resp = client
            .get(&endpoint)
            .query(&[("url", *test_url), ("timeout", "5000")])
            .send()
            .await;

        match resp {
            Ok(r) if r.status().is_success() => {
                let parsed = r.json::<Value>().await.ok();
                if let Some(delay) = parsed
                    .as_ref()
                    .and_then(|d| d.get("delay"))
                    .and_then(|v| v.as_i64())
                    .map(normalize_delay)
                    .filter(|delay| *delay > 0)
                {
                    return ProxyDelayDetail::success(proxy_name, test_url, delay);
                }
                errors.push(format!("{test_url}: missing positive delay"));
            }
            Ok(r) => {
                errors.push(format!("{test_url}: HTTP {}", r.status()));
            }
            Err(e) => {
                errors.push(format!("{test_url}: {e}"));
            }
        }
    }

    ProxyDelayDetail::failed(proxy_name, errors.join("; "))
}
```

- [ ] **Step 5: Replace final verdict in `test_group_delays`**

In `test_group_delays`, keep the group delay request only as a warm-up or remove it. The final returned map must come from per-node results:

```rust
pub async fn test_group_delay_details(
    api_base: &str,
    proxies: &[String],
) -> Vec<ProxyDelayDetail> {
    let mut handles = Vec::new();
    for proxy in proxies {
        let base = api_base.to_string();
        let name = proxy.clone();
        handles.push(tokio::spawn(async move {
            test_proxy_delay_detail(&base, &name).await
        }));
    }

    let mut details = Vec::new();
    for handle in handles {
        if let Ok(detail) = handle.await {
            details.push(detail);
        }
    }
    details
}

pub async fn test_group_delays(
    api_base: &str,
    _group_name: &str,
    proxies: &[String],
) -> std::collections::HashMap<String, i64> {
    test_group_delay_details(api_base, proxies)
        .await
        .into_iter()
        .map(|detail| (detail.name, detail.delay))
        .collect()
}
```

- [ ] **Step 6: Run targeted Rust tests**

Run:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri
cargo test delay_url_order_matches_flclash_first proxy_delay_detail_uses_flclash_state_values default_delay_url_matches_flclash_baseline fallback_groups_use_gstatic_delay_url
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/clash.rs src-tauri/src/config.rs
git commit -m "fix(clash): 改为节点独立测速"
```

---

## Task 3: Add Structured Diagnostics For The Proxy Plane

**Files:**
- Modify: `src-tauri/src/clash.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/state.rs` only if shared public structs are preferred there
- Modify: `frontend/src/api.ts`

- [ ] **Step 1: Add diagnostic structs**

Add to `src-tauri/src/clash.rs` or `src-tauri/src/state.rs`:

```rust
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyPlaneDiagnostics {
    pub api_base: String,
    pub api_ready: bool,
    pub proxy_count: usize,
    pub real_proxy_count: usize,
    pub delay_urls: Vec<String>,
    pub details: Vec<ProxyDelayDetail>,
}
```

- [ ] **Step 2: Add diagnostic function**

Add to `src-tauri/src/clash.rs`:

```rust
pub async fn get_proxy_plane_diagnostics(
    api_base: &str,
    proxies: &[String],
) -> ProxyPlaneDiagnostics {
    let api_ready = fetch_proxies_snapshot(api_base).await.is_some();
    let details = test_group_delay_details(api_base, proxies).await;
    ProxyPlaneDiagnostics {
        api_base: api_base.to_string(),
        api_ready,
        proxy_count: proxies.len(),
        real_proxy_count: proxies.len(),
        delay_urls: PROXY_DELAY_TEST_URLS
            .iter()
            .map(|url| url.to_string())
            .collect(),
        details,
    }
}
```

- [ ] **Step 3: Add Tauri command**

Add to `src-tauri/src/lib.rs`:

```rust
#[tauri::command]
async fn get_proxy_plane_diagnostics(
    group_name: String,
    app_state: State<'_, AppState>,
) -> Result<clash::ProxyPlaneDiagnostics, String> {
    let api = app_state.clash_api_base.lock().unwrap().clone();
    let proxies = real_group_proxies(&group_name, &app_state);
    Ok(clash::get_proxy_plane_diagnostics(&api, &proxies).await)
}

fn real_group_proxies(group_name: &str, app_state: &AppState) -> Vec<String> {
    let groups = app_state.proxy_groups.lock().unwrap();
    let server_names: std::collections::HashSet<String> = app_state
        .servers
        .lock()
        .unwrap()
        .iter()
        .filter(|s| config::is_selectable_proxy_name(&s.name))
        .map(|s| s.name.clone())
        .collect();
    groups
        .iter()
        .find(|g| g.name == group_name)
        .map(|g| {
            g.proxies
                .iter()
                .filter(|proxy| server_names.contains(*proxy))
                .cloned()
                .collect::<Vec<String>>()
        })
        .unwrap_or_default()
}
```

Then simplify the existing `test_group_delays` command to call `real_group_proxies()` instead of duplicating the proxy filtering logic.

- [ ] **Step 4: Register command**

Add `get_proxy_plane_diagnostics` to the `tauri::generate_handler![]` list in `src-tauri/src/lib.rs`.

- [ ] **Step 5: Add TypeScript API types**

Add to `frontend/src/api.ts`:

```ts
export interface ProxyDelayDetail {
  name: string;
  delay: number;
  url?: string | null;
  status: 'testing' | 'ok' | 'failed' | string;
  error?: string | null;
}

export interface ProxyPlaneDiagnostics {
  apiBase: string;
  apiReady: boolean;
  proxyCount: number;
  realProxyCount: number;
  delayUrls: string[];
  details: ProxyDelayDetail[];
}
```

Add:

```ts
getProxyPlaneDiagnostics: (groupName: string) =>
  invoke<ProxyPlaneDiagnostics>(
    'get_proxy_plane_diagnostics',
    { groupName },
  ),
```

- [ ] **Step 6: Run backend compile check**

Run:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri
cargo check
```

Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/clash.rs src-tauri/src/lib.rs src-tauri/src/state.rs frontend/src/api.ts
git commit -m "feat(clash): 增加代理平面诊断"
```

---

## Task 4: Align UI State With FlClash Delay Semantics

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/api.ts`

- [ ] **Step 1: Mark expanded nodes as testing before calling backend**

In `handleTestConnectivity`, before `api.testGroupDelays(groupName)`, compute real proxy names and set them to `0`:

```ts
const markGroupTesting = (groupName: string) => {
  const group = proxyGroups.find(g => g.name === groupName);
  if (!group) return;
  const realProxyNames = new Set(servers.map(s => s.name));
  const testingDelays = Object.fromEntries(
    group.proxies
      .filter(proxy => realProxyNames.has(proxy))
      .map(proxy => [proxy, 0]),
  );
  setNodeDelays(prev => ({ ...prev, ...testingDelays }));
};
```

Use:

```ts
for (const groupName of expandedGroupNames) {
  markGroupTesting(groupName);
  const delays = await api.testGroupDelays(groupName);
  setNodeDelays(prev => ({ ...prev, ...delays }));
}
```

- [ ] **Step 2: Display `0` as testing**

Update the delay helpers in the server list:

```ts
const isTesting = delay === 0;
const isTimeout = delay === -1;
const getDelayColor = () => {
  if (!hasDelay) return '';
  if (isTesting) return 'text-cyan-400';
  if (isTimeout) return 'text-red-400';
  if (delay < 100) return 'text-emerald-400';
  if (delay < 300) return 'text-yellow-400';
  return 'text-orange-400';
};
const getDelayText = () => {
  if (!hasDelay) return null;
  if (isTesting) return '...';
  if (isTimeout) return '--';
  return `${delay}ms`;
};
```

- [ ] **Step 3: Avoid testing subgroups as real nodes**

Keep:

```ts
const isSubGroup = proxyGroups.some(g => g.name === proxy);
```

Ensure subgroup buttons never show a direct node delay value:

```ts
const delay = isSubGroup ? undefined : nodeDelays[proxy];
```

- [ ] **Step 4: Run frontend build**

Run:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend
npm run build
```

Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/api.ts
git commit -m "fix(ui): 对齐节点测速状态显示"
```

---

## Task 5: Preserve Runtime Isolation Across Windows And macOS

**Files:**
- Modify only if tests reveal drift: `src-tauri/src/config.rs`
- Test: `src-tauri/src/config.rs`

- [ ] **Step 1: Confirm tests exist for runtime ports and interface behavior**

Check for these test behaviors in `src-tauri/src/config.rs`:

```rust
assert_eq!(
    map.get(&ykey("interface-name"))
        .and_then(serde_yaml::Value::as_str),
    Some("")
);
```

and:

```rust
assert_eq!(
    map.get(&ykey("external-controller"))
        .and_then(serde_yaml::Value::as_str),
    Some("127.0.0.1:58867")
);
```

- [ ] **Step 2: Add a regression test if missing**

If there is no single test proving all dynamic ports are patched, add:

```rust
#[test]
fn runtime_port_patch_keeps_dynamic_ports_and_empty_interface() {
    let _lock = CONFIG_FILE_LOCK.lock().unwrap();
    let config_path = get_user_config_dir().join("runtime_clash.yaml");
    let _ = std::fs::remove_file(&config_path);
    generate_clash_config(&[proxy("🇺🇸 US Server Only 01")]);

    patch_runtime_ports(
        &config_path,
        RuntimePorts {
            http_port: 58865,
            socks_port: 58866,
            controller_port: 58867,
            dns_port: 58868,
        },
    )
    .expect("port patch should succeed");

    let content = std::fs::read_to_string(&config_path).unwrap();
    let doc: serde_yaml::Value = serde_yaml::from_str(&content).unwrap();
    let map = doc.as_mapping().unwrap();
    assert_eq!(map.get(&ykey("port")).and_then(serde_yaml::Value::as_i64), Some(58865));
    assert_eq!(map.get(&ykey("socks-port")).and_then(serde_yaml::Value::as_i64), Some(58866));
    assert_eq!(
        map.get(&ykey("external-controller")).and_then(serde_yaml::Value::as_str),
        Some("127.0.0.1:58867")
    );
    assert_eq!(
        map.get(&ykey("interface-name")).and_then(serde_yaml::Value::as_str),
        Some("")
    );
}
```

- [ ] **Step 3: Run config tests**

Run:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri
cargo test config::tests -- --nocapture
```

Expected: all config tests pass on macOS. The runtime behavior is cross-platform because this code path writes the same runtime YAML for Windows and macOS, with platform-specific paths resolved by `dirs`.

- [ ] **Step 4: Commit if test added or fixed**

```bash
git add src-tauri/src/config.rs
git commit -m "test(clash): 覆盖运行时端口隔离"
```

---

## Task 6: Windows And macOS Verification Matrix

**Files:**
- No source changes required unless verification fails.

- [ ] **Step 1: macOS local verification**

Run:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri
cargo test default_delay_url_matches_flclash_baseline fallback_groups_use_gstatic_delay_url delay_url_order_matches_flclash_first proxy_delay_detail_uses_flclash_state_values
cargo test config::tests -- --nocapture
```

Expected:

```text
test result: ok
```

- [ ] **Step 2: Frontend verification**

Run:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend
npm run build
```

Expected: Vite production build succeeds.

- [ ] **Step 3: macOS smoke check**

Run the app:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk
npx tauri dev
```

Manual checks:

```text
1. Load subscription.
2. Start engine.
3. Open Servers tab.
4. Expand Server-Americas or Server-Asia.
5. Click connectivity test.
6. Nodes show "..." while testing.
7. Nodes show positive ms or "--" after completion.
8. runtime_clash.yaml fallback groups use gstatic.
```

- [ ] **Step 4: Windows packaged verification**

After CI builds a Windows package, on Windows run:

```powershell
notepad "$env:APPDATA\NextDesk\runtime_clash.yaml"
```

Verify:

```yaml
url: https://www.gstatic.com/generate_204
interface-name: ''
external-controller: 127.0.0.1:<dynamic-port>
```

Then run:

```powershell
$cfg="$env:APPDATA\NextDesk\runtime_clash.yaml"
$api = (Select-String -Path $cfg -Pattern "^external-controller:" |
  ForEach-Object { ($_ -split ":")[-1].Trim() })
Invoke-RestMethod "http://127.0.0.1:$api/proxies" | ConvertTo-Json -Depth 4
```

Expected: API returns proxy data.

- [ ] **Step 5: Windows delay verification**

Run:

```powershell
$cfg="$env:APPDATA\NextDesk\runtime_clash.yaml"
$api = (Select-String -Path $cfg -Pattern "^external-controller:" |
  ForEach-Object { ($_ -split ":")[-1].Trim() })
$p = Invoke-RestMethod "http://127.0.0.1:$api/proxies"
$nodes = $p.proxies.PSObject.Properties | Where-Object { $_.Name -like "*Server Only*" }
foreach ($n in $nodes) {
  $name = $n.Name
  $enc = [System.Uri]::EscapeDataString($name)
  "---- $name ----"
  Invoke-RestMethod "http://127.0.0.1:$api/proxies/$enc/delay?url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=10000"
}
```

Expected: at least the nodes known-good in FlClash return positive delay values. Nodes that fail return a controlled `--` in UI and a diagnostic reason in the new diagnostic command.

- [ ] **Step 6: Windows SOCKS verification**

Run:

```powershell
$cfg="$env:APPDATA\NextDesk\runtime_clash.yaml"
$socks = (Select-String -Path $cfg -Pattern "^socks-port:" |
  ForEach-Object { ($_ -split ":")[-1].Trim() })
curl.exe -v --socks5-hostname 127.0.0.1:$socks https://www.gstatic.com/generate_204 --max-time 15
```

Expected: HTTP 204 or a reachable response path. If delay succeeds but this fails, inspect the node and rule selection path.

- [ ] **Step 7: Commit verification notes if docs are updated**

If a walkthrough is added after verification:

```bash
git add docs/walkthroughs/<new-file>.md
git commit -m "docs(clash): 记录节点测速验证"
```

---

## Task 7: Release Gate

**Files:**
- Modify only version files when preparing release.

- [ ] **Step 1: Run final checks**

Run:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri
cargo test config::tests -- --nocapture
cargo test delay_url_order_matches_flclash_first proxy_delay_detail_uses_flclash_state_values
cd ../frontend
npm run build
```

Expected: all pass.

- [ ] **Step 2: Inspect git diff**

Run:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk
git diff --check
git status --short
```

Expected: no whitespace errors; only intended files changed.

- [ ] **Step 3: Prepare release only after Windows smoke passes**

Version files to update together:

```text
src-tauri/tauri.conf.json
src-tauri/Cargo.toml
src-tauri/Cargo.lock
```

Commit format:

```bash
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(release): 提升版本到 1.0.112"
```

- [ ] **Step 4: Tag after package verification**

```bash
git tag -a v1.0.112 -m "v1.0.112"
git push origin main
git push origin v1.0.112
```

Expected: GitHub Actions package build starts for Windows and macOS.

---

## Self-Review

- Spec coverage: The plan covers FlClash-style default URL, per-node delay final verdict, explicit UI testing state, proxy-plane diagnostics, runtime isolation, Windows verification, macOS verification, and release gate.
- Placeholder scan: No unresolved placeholder markers remain.
- Type consistency: `ProxyDelayDetail` and `ProxyPlaneDiagnostics` use camelCase serialization, matching the TypeScript interfaces.
- Scope check: The plan is one coherent subsystem: NextDesk's built-in Clash/Mihomo proxy plane delay and diagnostics. RDP rendering, subscription access policy, and installer cleanup are intentionally out of scope.
