# RDP 键盘快捷键双平台修复 — Walkthrough

## 修改的文件

| 文件 | 改动 |
|:---|:---|
| [RdpManager.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpManager.tsx) | Critical bug fix + Ctrl+X + Win/CtrlAltDel refs |
| [RdpTabBar.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpTabBar.tsx) | SessionControls 接口扩展 + 菜单按钮 UI |
| [translations.ts](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/i18n/translations.ts) | 中英双语翻译 |

---

## 改动详情

### 🔴 Critical Fix: macOS Cmd+字母通用路径

**问题：** macOS 上按 Cmd+A/Z/S/F 等，远程桌面只收到裸字母键（没有 Ctrl），因为 Cmd 键的 keyDown 被 `return` 吞掉了。

**修复：** 在通用 scancode 路径前增加 macOS Cmd+key 拦截，使用 `sendCtrlShortcut()` 正确发送 Ctrl+字母组合。

render_diffs(file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpManager.tsx)

### Ctrl+X 快捷键

添加了与 Ctrl+C 相同模式的专属处理分支（`sendCtrlShortcut(0x2D)` + `suppressedShortcutKeyups`）。

### Win 键 / Ctrl+Alt+Del 按钮

在 RDP 会话控制菜单（⋯ 按钮）中新增两个虚拟按键按钮，通过 ref 回调触发 scancode 发送。

render_diffs(file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpTabBar.tsx)

---

## 验证结果

- ✅ `npx tsc --noEmit` — 零错误通过
- ⏳ 手动测试需用户确认：连接 RDP 测试 Cmd+A/Z/S/F 和虚拟按键按钮
