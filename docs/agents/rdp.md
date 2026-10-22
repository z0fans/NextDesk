# RDP 约束与运行入口

用于 RDP 输入、剪贴板、显示、会话和引擎构建相关工作；不作为每次修改的预读清单。

## 开发与依赖

- 当前 KKTerm 开发入口是 `npm run tauri:dev:kkterm`，构建入口是 `npm run tauri:build:kkterm`。脚本默认 `kkterm-copy` 引擎与 `remote-scancode` 键盘模式；调整输入或显示时先确认实际引擎和平台。
- `scripts/dev-kkterm-rdp.sh` 会备份并临时替换 `src-tauri/Cargo.toml`、`Cargo.lock`，退出时恢复，并保存 KKTerm lockfile。它运行时不要并行编辑这些文件或启动另一套使用它们的 Cargo 构建。
- 当前 KKTerm manifest 使用发布的 IronRDP 依赖；旧的“所有构建都引用 90+ 个本地 crate”不是通用前提。CI 仍准备同级 patched IronRDP，按所选构建路径检查需要。
- 修改或升级同级 IronRDP 时先保存未提交补丁，再按实际分支集成上游。保护剪贴板、连接握手、DVC、音频以及 `iron-remote-desktop` / `ironrdp-web` 的 NextDesk 修改；`patches/ironrdp-nextdesk.patch` 和 `.github/workflows/build.yml` 记录发布基线。
- WASM 构建按 IronRDP 当前工具链配置执行，将产物放在 `frontend/src/wasm/`，以便 Vite 从源码目录导入。用命令级工具链选择，不为此修改全机 `rustup default`。
- RDP 调试日志通常在 `/tmp/nextdesk_debug.log` 和 `/tmp/nextdesk_rdp_debug.log`；只记录必要且脱敏的证据。

## 输入与剪贴板

- CLIPRDR 的 `FormatList` 随剪贴板内容变化同步；Ctrl+C / Ctrl+V 的键盘 handler 只发送按键，不从粘贴动作重新发布格式列表或调用 `onClipboardPaste()`。
- focus 同步与 `lastSyncedText` 去重用于避免重复通知；保留各引擎自己的剪贴板同步入口。
- macOS KKTerm 默认保持 `remote-scancode`；`kkterm-text` 是显式选择的本地文本 / IME 路径。
- WASM 滚轮入口接收 DOM 的 `deltaY`、`deltaMode`；不要预先除以 120 或强制为 ±1。原生引擎沿用自己的输入适配。

## 分辨率与会话

- 分辨率按引擎处理：KKTerm macOS 当前使用重连；Windows KKTerm 使用原生显示更新并保留失败恢复；native 和 official-web 已有动态 resize 及重连回退。不能把早期 `session.resize()` 不工作的结论套用到所有引擎。
- 沿用 `frontend/src/components/RdpManager.tsx` 的分辨率策略和 `reconnectWithSize()`；保留防抖、尺寸阈值、冷却、用户主动断开与文件传输保护。具体数值以代码常量为准。
- 切换标签或工作区时保持已有会话组件与 canvas 挂载，用可见性控制展示，避免因条件渲染断连。
- canvas 填满容器，保持现有缩放与坐标映射；不要用 `object-contain` 引入黑边或指针偏移。

## 验证范围

输入、焦点、剪贴板和显示变化应覆盖对应平台与引擎的受影响行为。前端单测、Rust 检查或浏览器预览不能代替 macOS 原生窗口 / Windows ActiveX 的真实运行证据。完整发布验收按 [发布流程](../../RELEASE.md) 执行。
