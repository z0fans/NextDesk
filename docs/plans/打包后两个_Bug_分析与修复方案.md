# 打包后两个 Bug 分析与修复方案

## Bug 1：黑夜模式下点击设置 → 自动变为白天模式

### 根因分析

`ThemeToggle` 组件仅在 **设置页** 中渲染（条件渲染 `activeTab === 'settings'`），不是全局挂载的。

关键代码 [ThemeToggle.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/ThemeToggle.tsx#L7-L18)：

```tsx
const [theme, setTheme] = useState<"light" | "dark">("dark"); // 初始值

useEffect(() => {
  const savedTheme = localStorage.getItem("nextdesk-theme");
  if (savedTheme) {
    setTheme(savedTheme);
    document.documentElement.classList.toggle("dark", savedTheme === "dark");
  } else {
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    setTheme(systemTheme);
    document.documentElement.classList.toggle("dark", systemTheme === "dark");
  }
}, []);
```

**问题**：`classList.toggle("dark", value)` 的行为是：
- 当 `value === true`：添加 `dark` class
- 当 `value === false`：**移除 `dark` class**

如果用户从未保存过主题（`localStorage` 中无 `nextdesk-theme`），走 `else` 分支读取系统偏好。如果 macOS 系统偏好设为浅色模式，`systemTheme` 就是 `light`，**导致 `dark` class 被移除**，即使 `index.html` 预设了 `class="dark"`。

这意味着：用户原本处于暗色模式 → 切换到设置 Tab → `ThemeToggle` 首次挂载 → `useEffect` 读取系统偏好为 `light` → 移除 `dark` class → **界面闪白**。

### 修复方案

将主题初始化逻辑提升到全局级别（在 `index.html` 中通过内联脚本完成），`ThemeToggle` 只负责切换和同步 state。

#### [MODIFY] [index.html](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/index.html)

在 `<head>` 中添加内联脚本，在 React 加载前根据 localStorage 设置正确的 `dark` class：

```html
<script>
  (function() {
    var theme = localStorage.getItem('nextdesk-theme');
    if (theme === 'light') {
      document.documentElement.classList.remove('dark');
    } else if (!theme) {
      // 无保存主题时默认 dark（与 HTML 预设一致）
    }
  })();
</script>
```

#### [MODIFY] [ThemeToggle.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/ThemeToggle.tsx)

修改 `useEffect`：只从 DOM 读取当前状态，不再执行 `classList.toggle`：

```tsx
useEffect(() => {
  const isDark = document.documentElement.classList.contains("dark");
  setTheme(isDark ? "dark" : "light");
}, []);
```

---

## Bug 2：Server 页白天模式背景 + 无法连接内网 RDP

### 2a：Server 页白天模式背景

从截图看，Server 页的深色背景是正确的（用户处于暗色模式）。如果用户指的是白天模式下 Server 页的背景色不正确，这可能与 Bug 1 相关：主题在切换 Tab 时被意外重置。**修复 Bug 1 后此问题应同步解决。**

### 2b：无法连接内网 RDP

> [!IMPORTANT]
> 需要更多信息来定位根因。

可能原因（需要逐一排查）：

**原因 1：RDP 代理端口不正确**

- 默认端口是 `18765`（[state.rs:71](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri/src/state.rs#L71)），但前端默认回退值是 `8765`（[RdpManager.tsx:375](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpManager.tsx#L375)）。
- 如果 `get_rdp_proxy_port` invoke 失败，前端会使用旧的默认值 `8765` 去连接，而后端监听的是 `18765`。

**原因 2：主机名导致走错代理**

- [rdp_proxy.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri/src/rdp_proxy.rs#L101-L133) 的 `is_private_ip` 函数只识别 IP 地址，不识别主机名。
- 如果用户用主机名（如 `mypc.local`）连接内网 RDP，会被判断为非私有 → 走 SOCKS5 代理 → 代理可能无法路由到内网。

**原因 3：Clash 引擎未启动**

- 如果 Clash 引擎未运行且不在 reuse 模式，SOCKS5 连接会失败。对于公网 RDP，这意味着 3 秒超时后回退直连。但对于需要代理才能访问的服务器，这会导致连接失败。

### 修复方案

#### [MODIFY] [RdpManager.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpManager.tsx#L375)

修正默认端口为 `18765`（与后端一致）：

```diff
-  const [proxyPort, setProxyPort] = useState(8765);
+  const [proxyPort, setProxyPort] = useState(18765);
```

> [!IMPORTANT]
> 请确认：你连接内网 RDP 时用的是 **IP 地址** 还是 **主机名**？如果是主机名，`is_private_ip` 无法识别，会导致走 SOCKS5 代理而非直连。

## 验证计划

### 手动验证

1. **Bug 1 验证**：
   - 构建后启动应用，确认默认是暗色模式
   - 切换到设置页，确认无白闪
   - 在设置页切换为浅色，再切换回其他 Tab，再回设置页，确认主题不变
   - 完全关闭应用后重启，确认主题保持

2. **Bug 2 验证**：
   - 打开应用控制台日志（`/tmp/nextdesk_clipboard.log` 或 Tauri devtools）
   - 连接内网 RDP，观察日志中 `[rdp_proxy]` 相关输出
   - 检查是否出现 `SOCKS5 error` 或 `Cannot bind port` 错误
