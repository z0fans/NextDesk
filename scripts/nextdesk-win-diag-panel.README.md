# NextDesk Windows Diagnostic Panel

这是一个给 Windows 用户临时运行的只读诊断面板，用来快速排查 NextDesk 的 Mihomo/Clash 端口、配置漂移、SOCKS 连通、节点 delay 和日志问题。

## 本地运行

在 Windows PowerShell 中进入脚本所在目录：

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\nextdesk-win-diag-panel.ps1
```

脚本会打印一个本地链接：

```text
http://127.0.0.1:48765/?token=...
```

把这个链接在该 Windows 机器浏览器里打开即可。

## 使用 trycloudflare.com 临时暴露

如果机器上已经有 `cloudflared.exe`：

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\nextdesk-win-diag-panel.ps1 -Expose
```

如果没有 `cloudflared.exe`，让脚本自动下载 Cloudflare 官方 release：

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\nextdesk-win-diag-panel.ps1 -Expose -DownloadCloudflared
```

运行后会打印：

```text
Remote: https://xxxx.trycloudflare.com/?token=...
```

把完整 `Remote` 链接发给排查人员。窗口不要关闭，关闭窗口后面板和隧道都会停止。

## 安全边界

- 面板只监听 `127.0.0.1`，公网访问依赖 cloudflared 反向隧道。
- 所有 API 都需要随机 token。
- 面板不提供远程 PowerShell，不允许远程执行任意命令。
- “建议临时修复命令”只显示文本，需要 Windows 用户自己复制到 PowerShell 执行。

## 面板会检查什么

- `nextdesk` / `nextdesk-core` 进程
- `nextdesk-core` 实际监听端口
- `%APPDATA%\NextDesk\runtime_clash.yaml`
- Mihomo REST API `/configs` 和 `/proxies`
- SOCKS5 代理访问 `http://www.gstatic.com/generate_204`
- `*Server Only*` 节点 delay
- `%APPDATA%\NextDesk\log\clash.log`
- `%TEMP%\nextdesk_debug.log`
