# 迁移至 Tauri 官方 Updater 插件

## 背景

当前的自制更新方案（手动下载 DMG/EXE → 执行脚本安装）不够稳定，尤其 Windows 端多次出现路径转义、UAC 提权、NSIS 向导弹出等问题。行业标准方案是使用 **Tauri 2 官方 `@tauri-apps/plugin-updater`**。

## 方案对比

| 特性 | 自制方案 | Tauri 官方 Updater |
|:---|:---|:---|
| Windows 安装 | 手动下载 `.exe` + PowerShell 执行 | **passive 模式**：自动静默安装，仅显示小进度条 |
| macOS 安装 | 下载 DMG → hdiutil 脚本 | **自动替换** `.app`，无需 DMG |
| 签名验证 | ❌ 无 | ✅ EdDSA 签名验证，防止中间人攻击 |
| 增量下载 | ❌ 全量下载 | ✅ 内置支持 |
| 进度回调 | 轮询 `get_download_status` | ✅ 原生事件流 (`Started/Progress/Finished`) |
| 安全性 | 低 | 生产级（强制 TLS + 签名） |
| CI 改动量 | 无 | 中等（需增加签名环节） |

## 实施步骤

### 1. 生成签名密钥对（一次性操作）

```bash
npx tauri signer generate -w ~/.tauri/nextdesk.key
```

会生成：
- `~/.tauri/nextdesk.key` — 私钥（**保密**，存入 GitHub Secrets）
- 屏幕输出公钥 — 写入 `tauri.conf.json`

### 2. 后端添加依赖 (`src-tauri/Cargo.toml`)

```toml
[target.'cfg(any(target_os = "macos", windows))'.dependencies]
tauri-plugin-updater = "2"
```

### 3. 注册插件 (`src-tauri/src/lib.rs`)

在 `tauri::Builder` 中注册插件：
```rust
.plugin(tauri_plugin_updater::Builder::new().build())
```

### 4. 配置 `tauri.conf.json`

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "pubkey": "<公钥内容>",
      "endpoints": [
        "https://github.com/z0fans/NextDesk/releases/latest/download/latest.json"
      ],
      "windows": {
        "installMode": "passive"
      }
    }
  }
}
```

> `passive` 模式 = 仅显示进度条，无 NSIS 向导，无需用户交互。

### 5. 前端安装插件 (`frontend/`)

```bash
npm install @tauri-apps/plugin-updater @tauri-apps/plugin-process
```

### 6. 重写前端更新逻辑 (`api.ts` + `App.tsx`)

```typescript
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

const update = await check();
if (update) {
  await update.downloadAndInstall((event) => {
    if (event.event === 'Progress') { /* 更新进度条 */ }
  });
  await relaunch(); // 自动重启
}
```

### 7. 清理旧代码

- 删除 `updater.rs` 中的 `start_download_update`、`get_download_status`、`install_update`
- 删除 `state.rs` 中的 `UpdaterState`
- 保留 `check_for_update` 和 `get_current_version`（供设置页显示版本号）

### 8. CI 修改 (`.github/workflows/build.yml`)

添加环境变量用于签名：
```yaml
env:
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

构建时 Tauri 会自动生成：
- `latest.json` — 更新描述文件（版本号、下载链接、签名）
- `.nsis.zip` + `.nsis.zip.sig` — Windows 签名安装包
- `.app.tar.gz` + `.app.tar.gz.sig` — macOS 签名安装包

将 `latest.json` 也上传到 Release Assets 中。

## 验证

1. 先发布一个带签名更新包的版本（如 v1.0.85）
2. 安装 v1.0.85 后，发布 v1.0.86
3. 在 v1.0.85 内检查更新 → 自动下载 → 自动静默安装 → 自动重启
4. 确认版本号已更新为 v1.0.86

> [!IMPORTANT]
> 迁移过程中需要你将私钥添加到 [GitHub Secrets](https://github.com/z0fans/NextDesk/settings/secrets/actions) 中。
