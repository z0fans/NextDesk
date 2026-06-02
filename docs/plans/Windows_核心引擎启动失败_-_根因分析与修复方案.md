# Windows 核心引擎启动失败 — 根因分析与修复方案

## 根因分析

### 🔴 根本原因：`mihomo.exe` 未被打包到 Windows 安装包

**数据流追踪：**

```
用户点击"启动引擎" → api.startEngine()
  → lib.rs::start_engine() → clash.rs::start_clash_process()
    → get_bin_dir() 查找 bin 目录
    → 在 bin/ 下查找 "mihomo.exe"
    → ❌ 文件不存在 → 返回 "mihomo binary not found"
```

**关键代码路径：**

1. [get_bin_dir()](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri/src/clash.rs#L157-L190) 按如下优先级查找：
   - `exe所在目录/bin/` → Windows 生产环境命中此路径
   - `exe/../Resources/bin/` → macOS 路径
   - `.backend/bin/` → 开发模式 fallback

2. [tauri.conf.json resources](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri/tauri.conf.json#L36-L40) **只打包了 geodata 文件**：
   ```json
   "resources": {
     "../.backend/bin/Country.mmdb": "bin/Country.mmdb",
     "../.backend/bin/geoip.metadb": "bin/geoip.metadb",
     "../.backend/bin/geosite.dat": "bin/geosite.dat"
   }
   ```
   **缺少** `"../.backend/bin/mihomo.exe": "bin/mihomo.exe"`

3. [download-deps.sh](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/scripts/download-deps.sh) CI 脚本正确下载 mihomo.exe 到 `.backend/bin/`，但 Tauri 打包时遗漏了

> [!CAUTION]
> macOS 之所以能工作，是因为 [tauri.conf.json](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri/tauri.conf.json#L36-L40) 的 resources 在 macOS 上打包到 `Contents/Resources/bin/`。但无论 macOS 还是 Windows，**mihomo binary 都未在 resources 中配置**。macOS 如果也不能工作，请确认是否有其他路径提供了 mihomo。

### 🟡 次要问题：`frontend_log` 硬编码 Unix 路径

[lib.rs L519](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri/src/lib.rs#L519) 写死了 `/tmp/nextdesk_clipboard.log`，在 Windows 上会失败：
```rust
.open("/tmp/nextdesk_clipboard.log")  // ❌ Windows 没有 /tmp
```

---

## 修复方案

### 修复 1：在 resources 中添加 mihomo binary

#### [MODIFY] [tauri.conf.json](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri/tauri.conf.json)

在 `resources` 中添加平台特定的 mihomo binary：

```diff
 "resources": {
+  "../.backend/bin/mihomo": "bin/mihomo",
+  "../.backend/bin/mihomo.exe": "bin/mihomo.exe",
   "../.backend/bin/Country.mmdb": "bin/Country.mmdb",
   "../.backend/bin/geoip.metadb": "bin/geoip.metadb",
   "../.backend/bin/geosite.dat": "bin/geosite.dat"
 }
```

> [!IMPORTANT]
> Tauri 的 resources 在**每个平台**只打包存在的文件，不存在的会被跳过。因此同时写 `mihomo` 和 `mihomo.exe` 是安全的——macOS 构建只会打包 `mihomo`，Windows 只会打包 `mihomo.exe`。
>
> **但需确认**：Tauri 2 是否真的会跳过不存在的 resource 文件（而不是报错）。如果会报错，则需要使用平台条件资源配置。

### 修复 2：frontend_log 路径跨平台兼容

#### [MODIFY] [lib.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri/src/lib.rs)

将硬编码的 `/tmp/` 改为使用 `std::env::temp_dir()`：
```diff
-    .open("/tmp/nextdesk_clipboard.log")
+    .open(std::env::temp_dir().join("nextdesk_clipboard.log"))
```

---

## 验证方案

### 自动验证
```bash
# 确认修改后 tauri.conf.json 是合法 JSON
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk
python3 -c "import json; json.load(open('src-tauri/tauri.conf.json'))"

# 确认 Rust 编译通过
cd src-tauri && cargo check 2>&1 | head -20
```

### 手动验证（需要用户在 Windows 上测试）
1. 推送修改后在 Windows 上构建：`npx tauri build`
2. 安装 NSIS 安装包
3. 检查安装目录下 `bin/mihomo.exe` 是否存在
4. 启动应用，点击"启动引擎"按钮，确认引擎正常启动
