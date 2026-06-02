# Mihomo v1.19.21 双端内核 + CI/CD 流水线 — Walkthrough

## 阶段一：内核集成（已完成）

| 平台 | 文件 | 大小 | 验证 |
|:---|:---|:---|:---|
| macOS arm64 | `.backend/bin/mihomo` | 31MB | `Mihomo Meta v1.19.21 darwin arm64` ✅ |
| Windows amd64 | `.backend/bin/mihomo.exe` | 35MB | `PE32+ executable (console) x86-64` ✅ |

## 阶段二：CI/CD 流水线

### 变更文件

#### [MODIFY] [Cargo.toml](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri/Cargo.toml)
`ironrdp-rdcleanpath` 从本地路径改为 crates.io `0.2.1`

#### [MODIFY] [.gitignore](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/.gitignore)
排除大型二进制（mihomo, geodata）和 Rust target/

#### [MODIFY] [tauri.conf.json](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri/tauri.conf.json)
- `targets`: `["dmg", "nsis"]` — macOS dmg + Windows exe 安装包
- `resources`: 打包 mihomo + geodata 到 `bin/` 子目录
- `windows.nsis`: 中英双语 + 安装模式选择

#### [NEW] [download-deps.sh](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/scripts/download-deps.sh)
下载脚本，支持 4 种 target：
- `aarch64-apple-darwin` — macOS ARM
- `x86_64-apple-darwin` — macOS Intel
- `universal-apple-darwin` — macOS Universal（lipo 合并）
- `x86_64-pc-windows-msvc` — Windows x64

#### [NEW] [build.yml](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/.github/workflows/build.yml)
GitHub Actions 矩阵构建：

| Job | Runner | 产物 |
|:---|:---|:---|
| macOS arm64 | `macos-latest` | `.dmg` |
| macOS x64 | `macos-latest` | `.dmg` |
| Windows x64 | `windows-latest` | `.exe` (NSIS) |
| Release | `ubuntu-latest` | Draft GitHub Release |

## 验证结果

- `cargo check` 编译成功 ✅（crates.io 依赖）
- `npx tauri dev` 运行正常 ✅

## 后续使用

```bash
# 本地触发 CI
git tag v1.0.70 && git push --tags

# 手动触发
# GitHub → Actions → Build & Release → Run workflow
```
