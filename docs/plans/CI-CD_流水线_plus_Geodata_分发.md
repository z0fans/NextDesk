# CI/CD 流水线 + Geodata 分发

## 背景

项目需要 GitHub Actions 实现双端（macOS/Windows）自动构建。关键阻塞：
1. `ironrdp-rdcleanpath` 使用本地路径依赖 → CI 无法编译
2. `.backend/bin/` 含 ~90MB 大型二进制 → 不应入 git，需 CI 动态下载
3. 无 geodata 自动更新机制

## Proposed Changes

### 1. 修复依赖（CI 可构建）

#### [MODIFY] [Cargo.toml](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri/Cargo.toml)

将 `ironrdp-rdcleanpath` 从本地路径改为 crates.io 发布版本（版本一致，均为 0.2.1）：

```diff
-ironrdp-rdcleanpath = { path = "../../IronRDP/crates/ironrdp-rdcleanpath" }
+ironrdp-rdcleanpath = "0.2.1"
```

> [!IMPORTANT]
> 这意味着后续如果你在本地修改了 IronRDP 的 rdcleanpath，需要先发布到 crates.io 再更新版本号。

---

### 2. `.gitignore` 排除大型二进制

#### [MODIFY] [.gitignore](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/.gitignore)

```diff
+# Large binaries (downloaded by CI)
+.backend/bin/mihomo
+.backend/bin/mihomo.exe
+.backend/bin/Country.mmdb
+.backend/bin/geoip.metadb
+.backend/bin/geosite.dat
```

---

### 3. 下载脚本

#### [NEW] [download-deps.sh](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/scripts/download-deps.sh)

Shell 脚本根据 `$TARGET` 参数下载对应平台 mihomo + geodata：
- macOS arm64: `mihomo-darwin-arm64-v{VER}.gz`
- macOS x64: `mihomo-darwin-amd64-v{VER}.gz`
- Windows x64: `mihomo-windows-amd64-v{VER}.zip`
- 从 GitHub 下载最新 geodata (Country.mmdb, geoip.metadb, geosite.dat)

---

### 4. GitHub Actions 工作流

#### [NEW] [build.yml](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/.github/workflows/build.yml)

矩阵构建，触发条件 push to `main` + tag `v*`：

| 平台 | Runner | Target |
|:---|:---|:---|
| macOS arm64 | `macos-latest` | `aarch64-apple-darwin` |
| macOS x64 | `macos-13` | `x86_64-apple-darwin` |
| Windows x64 | `windows-latest` | `x86_64-pc-windows-msvc` |

步骤：checkout → setup Node → setup Rust → 运行 `download-deps.sh` → `npm install` → `npx tauri build`

---

## User Review Required

> [!WARNING]
> 将 `ironrdp-rdcleanpath` 从本地路径改为 crates.io 版本后，本地开发时将不再使用你 fork 的源码。如果你对 IronRDP 有自定义修改，需要发布到 crates.io 或使用 git 依赖。

## Verification Plan

### 自动化测试
- `cargo check` 确认切换 crates.io 依赖后编译通过
- CI 工作流推送后检查 GitHub Actions 日志

### 手动验证
- 本地运行 `scripts/download-deps.sh` 验证下载逻辑
- `npx tauri dev` 确认切换依赖后功能正常
