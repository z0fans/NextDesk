# 内置更新下载失败分析 & 修复方案

## 问题分析

### 🔴 核心发现：`latest.json` 完全损坏

当前 v1.0.86 的 [latest.json](https://github.com/z0fans/NextDesk/releases/download/v1.0.86/latest.json) 内容：

```json
{
  "version": "1.0.86",
  "platforms": {
    "darwin-aarch64": { "signature": "", "url": "...download/v1.0.86/" },
    "darwin-x86_64":  { "signature": "", "url": "...download/v1.0.86/" },
    "windows-x86_64": { "signature": "", "url": "...download/v1.0.86/" }
  }
}
```

**三个致命问题**：

| # | 问题 | 影响 |
|---|------|------|
| 1 | `url` 只到目录，**缺少文件名** | `tauri-plugin-updater` 下载到的是空/404 |
| 2 | `signature` 全部为**空字符串** | 即使下载成功，签名验证必然失败 |
| 3 | Release 中**缺少 updater 包**（`.nsis.zip` / `.tar.gz`）| 没有可下载的更新包 |

> **这意味着 Windows 和 macOS 的内置更新都会失败，不仅仅是 Windows。**

---

### 根因分析

Release Assets 实际只有：
- `latest.json` (损坏)
- `NextDesk_1.0.86_universal.dmg` (安装包，不是 updater 包)
- `NextDesk_1.0.86_x64-setup.exe` (安装包，不是 updater 包)

Tauri updater 需要的是**签名更新包**：
- macOS: `NextDesk.app.tar.gz` + `NextDesk.app.tar.gz.sig`
- Windows: `NextDesk_1.0.86_x64-setup.nsis.zip` + `NextDesk_1.0.86_x64-setup.nsis.zip.sig`

**根因在 CI 构建配置** ([build.yml](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/.github/workflows/build.yml))：

#### 问题 1: Windows 构建缺少 `TAURI_SIGNING_PRIVATE_KEY` 环境变量

```yaml
# macOS ✅ 正确 — 直接在 env 中设置
- name: Build & Release
  uses: tauri-apps/tauri-action@v0
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}  # ✅

# Windows ❌ 错误 — 通过 pwsh 预处理了 key，但没传给 tauri-action
- name: Trim signing key
  shell: pwsh
  run: |
    $key = "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}".Trim()
    echo "TAURI_SIGNING_PRIVATE_KEY=$key" >> $env:GITHUB_ENV

- name: Build & Release
  uses: tauri-apps/tauri-action@v0
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    # ❌ 没有显式设 TAURI_SIGNING_PRIVATE_KEY！
    # 虽然上一步写到了 GITHUB_ENV，但 action 的 env 块可能覆盖了环境
```

> [!WARNING]
> 即使 `GITHUB_ENV` 正确生效，`tauri-action` 的 `env:` 块不含 `TAURI_SIGNING_PRIVATE_KEY`，可能导致 action 内部环境变量不一致。

#### 问题 2: macOS 和 Windows 构建独立 Release，后者覆盖 `latest.json`

两个 job（`build-macos` 和 `build-windows`）各自独立运行 `tauri-action`，都带 `includeUpdaterJson: true`。由于是**并行执行 + 写同一个 Release**，后完成的 job 会覆盖先前的 `latest.json`。

如果 Windows 后完成但签名失败 → 产生损坏的 `latest.json` 覆盖掉 macOS 可能正确的版本。

#### 问题 3: macOS universal 构建产物命名可能不匹配

macOS 使用 `--target universal-apple-darwin` 构建，但 `latest.json` 中 platform key 是 `darwin-aarch64` 和 `darwin-x86_64`。universal 构建可能导致 `tauri-action` 无法正确映射产物文件名到 platform。

---

## 修复方案

### [MODIFY] [build.yml](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/.github/workflows/build.yml)

#### 修改 1: 修复 Windows signing key 传递

```diff
      - name: Build & Release
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
+         TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
```

同时删除多余的 "Trim signing key" 步骤（Trim 不是必要的，macOS 不需要 Trim 也工作正常）。

#### 修改 2: 确保 `latest.json` 正确合并

让两个 job 串行执行（Windows `needs: build-macos`），或者只让最后一个 job 设 `includeUpdaterJson: true`，前面的不设。

**推荐方案**：Windows 依赖 macOS 完成后执行，并设置 `updaterJsonPreferNewer: true` 或使用 `updaterJsonKeepUniversal: true`。

> [!IMPORTANT]
> 最简单的修改：直接给 Windows 的 `env` 加上 `TAURI_SIGNING_PRIVATE_KEY`，删除 Trim 步骤，同时添加 `needs: build-macos` 让 Windows 后执行。

---

## Verification Plan

### 手动验证
1. 推送一个新 tag（如 `v1.0.87`）触发 CI
2. CI 完成后检查 Release Assets，确认包含：
   - `NextDesk_x.x.x_x64-setup.nsis.zip` + `.sig`
   - `NextDesk.app.tar.gz` + `.sig`
   - `latest.json`（url 和 signature 字段不为空）
3. 在 Windows 旧版本上测试内置更新是否能下载并安装
