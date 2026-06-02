# 内置更新修复 Walkthrough

## 问题
`latest.json` 中所有平台的 `url` 缺少文件名、`signature` 为空 → Windows **和** macOS 内置更新都会失败。

## 根因
1. Windows CI 未将 `TAURI_SIGNING_PRIVATE_KEY` 传给 `tauri-action`（Trim 步骤写 `GITHUB_ENV` 但 action env 覆盖）
2. macOS/Windows 并行构建 → `latest.json` 被后完成的 job 覆盖

## 修改

render_diffs(file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/.github/workflows/build.yml)

### 改动点
| # | 改动 | 目的 |
|---|------|------|
| 1 | 删除 "Trim signing key" 步骤 | 消除不必要的复杂性 |
| 2 | `env` 加 `TAURI_SIGNING_PRIVATE_KEY` | 确保 tauri-action 能生成签名更新包 |
| 3 | `needs: build-macos` | 串行构建，Windows 后执行并合并 latest.json |

## 验证
推送新 tag 触发 CI 后检查 Release：
- [ ] 存在 `.nsis.zip` 和 `.tar.gz` 签名更新包
- [ ] `latest.json` 的 url 含完整文件名、signature 非空
- [ ] Windows 旧版本能成功下载并安装更新
