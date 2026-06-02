# 修复打包后代理端口为 0 和 RDP 连接失败

## 根因分析

### Bug 1: Mac 代理端口显示为 0

**根因**: Mihomo 的 `/configs` API **始终**返回所有字段，包括未使用的 `mixed-port`（值为 `0`）。而代码中两个获取代理端口的函数都**优先检查 `mixed-port`**：

1. `clash.rs:get_clash_proxy_port()` (async 版) — 第 61 行: `data.get("mixed-port").or(data.get("socks-port"))`
2. `lib.rs:get_proxy_port_sync()` (同步版) — 第 574 行: 只搜索 `"mixed-port"`，完全不检查 `socks-port`

NextDesk 生成的 `runtime_clash.yaml` 使用 `socks-port: 17897`（不使用 `mixed-port`），所以 Mihomo 返回 `mixed-port: 0` → 代码读到 `0`。

### Bug 2: Windows RDP 连接失败

从截图看，`192.168.3.249` 是 LAN IP，`rdp_proxy.rs` 会跳过 SOCKS5 直接连接。连接卡在 "Connecting..." 可能原因：

1. Windows 防火墙阻止了 RDP 代理绑定端口
2. WebSocket 端口绑定问题（IPv4 vs IPv6）
3. 或者需要用户进一步提供 Windows 的日志

### Bug 3: Windows Server 选项卡底部没有 Server 和 Group

从截图看，RDP 选项卡的 `+ Server` 和 `+ Group` 按钮是可见的。用户可能指的是：
- **Servers 选项卡**（显示代理组）底部确实没有按钮 — 因为设计上那就是代理组列表，没有添加按钮

> [!IMPORTANT]
> **需要用户确认**：Server 选项卡 "没有 Server 和 Group" 是指 Servers 代理组视图为空（没有加载到 proxy groups），还是 RDP 侧边栏底部按钮不可见？

## Proposed Changes

### Clash 端口检测

#### [MODIFY] [clash.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri/src/clash.rs)

修改 `get_clash_proxy_port()` 函数，**过滤掉 `0` 值**的 `mixed-port`：

```diff
-            if let Some(p) = data
-                .get("mixed-port")
-                .or(data.get("socks-port"))
-                .and_then(|v| v.as_u64())
-            {
-                return p as u16;
-            }
+            // mixed-port=0 means disabled; prefer non-zero mixed-port, else socks-port
+            if let Some(p) = data
+                .get("mixed-port")
+                .and_then(|v| v.as_u64())
+                .filter(|&p| p > 0)
+                .or_else(|| data.get("socks-port").and_then(|v| v.as_u64()).filter(|&p| p > 0))
+            {
+                return p as u16;
+            }
```

#### [MODIFY] [lib.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri/src/lib.rs)

修改 `get_proxy_port_sync()` 函数，同样**检查 `socks-port` 并过滤 0 值**：

```diff
 // Find mixed-port in JSON body
-if let Some(pos) = body.find("\"mixed-port\"") {
-    let after = &body[pos..];
-    if let Some(colon) = after.find(':') {
-        let num_str: String = after[colon + 1..]
-            .chars()
-            .take_while(|c| c.is_ascii_digit() || *c == ' ')
-            .collect();
-        if let Ok(p) = num_str.trim().parse::<u16>() {
-            return p;
-        }
-    }
-}
+// Try mixed-port first, then socks-port; skip if 0
+for key in &["\"mixed-port\"", "\"socks-port\""] {
+    if let Some(pos) = body.find(key) {
+        let after = &body[pos..];
+        if let Some(colon) = after.find(':') {
+            let num_str: String = after[colon + 1..]
+                .chars()
+                .take_while(|c| c.is_ascii_digit() || *c == ' ')
+                .collect();
+            if let Ok(p) = num_str.trim().parse::<u16>() {
+                if p > 0 { return p; }
+            }
+        }
+    }
+}
```

## Verification Plan

### 手动验证
1. `cargo check` 确保编译通过
2. 用户在 Mac 打包后测试代理端口是否正确显示 17897 而非 0
3. 用户在 Windows 测试 RDP 连接是否恢复

### 本地编译检查
```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri && cargo check 2>&1 | tail -20
```
