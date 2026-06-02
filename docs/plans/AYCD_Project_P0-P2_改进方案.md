# AYCD Project P0-P2 改进方案

全面改进方案，按优先级分阶段实施。每个问题都给出**具体修改方式、影响范围和代码示例**。

---

## 🔴 P0 — 严重问题（安全 + 架构）

### P0-1: 拆分巨型 `src/index.ts`（1480行）

**现状**: 所有 IPC handler、代理测试、reCAPTCHA 逻辑混在一个文件。
**方案**: 按功能域拆分为独立模块。

```
src/
├── index.ts              # 精简为 ~80 行：app 生命周期 + 注册 IPC
├── ipc/
│   ├── register.ts       # 统一注册所有 IPC handlers
│   ├── bot.ts            # bot-start-task, bot-stop-task, bot-verify-login 等
│   ├── proxy.ts          # test-proxy, detect-proxy-protocol
│   ├── captcha.ts        # account-captcha-test, reCAPTCHA v3/v2 逻辑
│   ├── settings.ts       # settings-update, task-event
│   └── license.ts        # validate-license, get-hwid
└── utils/
    ├── proxy.ts           # buildProxyUrl, loadProxyChain, normalizeProxyUrl
    └── profile.ts         # isProfileInUse, forceCleanupProfile
```

**改动量**: ~1400行代码移动（不改逻辑），创建 8 个新文件
**风险**: 低 — 只是搬运代码，所有导入路径需更新

---

### P0-2: 消除类型定义三重重复

**现状**: `AppSettings`, `ProxyTestParams`, `FullAccountParams` 等在 3 个文件中各定义一次
**方案**: 统一到 `src/types/` 目录

```diff
# src/types/settings.ts   ← 新建，集中定义 AppSettings
# src/types/proxy.ts      ← 新建，集中定义 ProxyTestParams, ProxyTestResult 等
# src/types/account.ts    ← 新建，集中定义 FullAccountParams
# src/types/electron.d.ts ← 保留，仅做 window.electronAPI 声明，import 上面的类型
# src/preload.ts          ← 改为 import { AppSettings } from './types/settings'
# src/index.ts            ← 改为 import { ProxyTestParams } from './types/proxy'
```

**改动量**: 创建 3 个类型文件，修改 3 个现有文件的 import
**风险**: 极低

---

### P0-3: 消除重复函数

**现状**: `loadProxyChain()`, `isProfileInUse()`, `forceCleanupProfile()`, `buildProxyUrl()` 在 `index.ts` 和 `browser.ts` 中各有一份

**方案**: 提取到共享工具模块

```typescript
// src/utils/proxy.ts
export async function loadProxyChain(): Promise<ProxyChainModule> { ... }
export function buildProxyUrl(params: ProxyTestParams): string { ... }
export function normalizeProxyUrl(proxy: string): URL { ... }

// src/utils/profile.ts
export function isProfileInUse(userDataDir: string): boolean { ... }
export function forceCleanupProfile(userDataDir: string): void { ... }
```

然后 `index.ts` 和 `browser.ts` 都改为 `import { loadProxyChain } from '../utils/proxy'`

**改动量**: 创建 2 个文件，修改 2 个文件
**风险**: 极低

---

### P0-4: 加密存储账户密码 ⚡最重要

**现状**: `AccountContext.tsx:74` 用 `localStorage.setItem` 明文存密码
**方案**: 使用 Electron `safeStorage` + 主进程文件存储

```
架构变更：
Renderer (读写加密数据) ←→ IPC ←→ Main (safeStorage 加密/解密 + 文件存储)
```

**具体步骤**:

1. 主进程新增 IPC：
   - `accounts-save(accounts)` — 用 `safeStorage.encryptString()` 加密后写入文件
   - `accounts-load()` — 读取文件 → `safeStorage.decryptString()` 解密后返回

2. `AccountContext.tsx` 改为：
   - 初始化时调用 `window.electronAPI.loadAccounts()`
   - 保存时调用 `window.electronAPI.saveAccounts(accounts)`
   - 移除所有 `localStorage` 相关代码

3. 存储位置：`app.getPath('userData')/accounts.enc`

**改动量**: 新增 `ipc/accounts.ts`，修改 `AccountContext.tsx`, `preload.ts`, `electron.d.ts`
**风险**: 中 — 需要数据迁移（首次启动时从 localStorage 读取 → 加密保存 → 清除 localStorage）

---

### P0-5: 生产环境关闭 DevTools + Debug Port

**方案**:

```typescript
// src/index.ts — createWindow 中：
if (!app.isPackaged) {
  mainWindow.webContents.openDevTools();
}

// src/index.ts — 顶层：
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}
```

**改动量**: 2 行条件判断
**风险**: 极低

---

## 🟡 P1 — 重要改进

### P1-6: Camoufox + Playwright 引擎迁移（10 天）

> [!IMPORTANT]
> 研究确认：JS 注入级反检测已无法通过 Google/CreepJS 检测。
> 需要 **C++ 源码级** 方案。Wayfern (CDP JS 注入) 已排除，Camoufox 为唯一可行方案。
> 详细研究见 [anti_detection_research.md](file:///Users/yuu/.gemini/antigravity/brain/d6a4a882-f737-4e2d-b29f-ec4d8d9845b9/anti_detection_research.md)

**架构变更**:
```
旧: Electron → Puppeteer → Chrome + JS stealth (可被检测)
新: Electron → camoufox-js (Playwright) → Camoufox Firefox (C++ 级)
```

**依赖变更**:
```diff
- "puppeteer" / "ghost-cursor"
+ "camoufox-js" / "playwright-core"
```

**子阶段 ➊ 安装验证** (Day 1)
- `npm install camoufox-js playwright-core && npx camoufox-js fetch`
- 运行 bot.sannysoft.com 验证通过

**子阶段 ➋ 重写 `browser.ts`** (Day 2-3)
- 删除 ~170 行 stealth 注入 + Chrome 参数
- 新增 ~20 行 `Camoufox({ headless, os, proxy, geoip, humanize })` 配置

**子阶段 ➌ API 适配** (Day 4-7)
- Puppeteer → Playwright API 映射 (24 个文件)
- `googleAuth.ts` (710行) 为重点
- `humanizer.ts` 移除 ghost-cursor，用 Playwright `click({ delay })` 替代
- `profileManager.ts` 锁文件从 Chrome → Firefox 格式

**子阶段 ➍ 集成测试** (Day 8-10)
- Google 登录、8 个 task 模块回归、代理支持、Headless ↔ Visible

**文件影响**: `browser.ts`(重写) · `googleAuth.ts`(大) · `humanizer.ts`(中) · `captchaHandler.ts`(中) · `profileManager.ts`(小) · `tasks/*.ts`(import) · `behavior/*.ts`(import)

---

### P1-7: 许可证验证替换

**方案**: 取决于你的许可证服务（Gumroad, LemonSqueezy, 自建 API 等）

```typescript
// 示例：调用外部 API 验证
ipcMain.handle('validate-license', async (_event, key: string) => {
  const hwid = await machineId();
  const res = await fetch('https://api.yourservice.com/validate', {
    method: 'POST',
    body: JSON.stringify({ key, hwid }),
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  return data.valid === true;
});
```

> [!IMPORTANT]
> 需要你确认使用哪个许可证服务，我再写具体实现。

---

### P1-8: IPC 监听器清理

**方案**: 在 `preload.ts` 中返回 cleanup 函数

```typescript
// preload.ts 改为：
onTaskUpdate: (callback: (task: Task) => void) => {
  const handler = (_event: any, task: any) => callback(task as Task);
  ipcRenderer.on('task-update', handler);
  return () => ipcRenderer.removeListener('task-update', handler);
},
```

在 `AccountContext.tsx` 的 `useEffect` 中调用返回的 cleanup：

```typescript
useEffect(() => {
  const cleanup = window.electronAPI.onLoginStatus(handleLoginStatus);
  return cleanup; // 组件卸载时移除监听
}, []);
```

---

### P1-9: React ErrorBoundary

**方案**: 创建通用 ErrorBoundary 组件

```typescript
// src/renderer/components/ErrorBoundary.tsx
class ErrorBoundary extends React.Component<Props, State> {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return <ErrorFallback error={this.state.error} onReset={() => this.setState({ hasError: false })} />;
    }
    return this.props.children;
  }
}
```

包裹在 `App.tsx` 的 Provider 外层。

---

### P1-10: 添加测试基础设施

**方案**: 使用 Vitest（更快、对 TypeScript 友好）

```bash
npm install -D vitest @testing-library/react jsdom
```

优先为以下模块添加测试：
1. `humanizer.ts` — 纯函数，最容易测试
2. `taskQueue.ts` — 队列逻辑
3. `profileManager.ts` — 文件系统操作
4. `utils/proxy.ts` — URL 解析和构建

> [!NOTE]
> 建议从纯函数开始，逐步扩展到需要 mock 的模块。不建议一次性追求高覆盖率。

---

## 🟢 P2 — 建议优化

### P2-11: 升级 TypeScript 5.x

```bash
npm install -D typescript@~5.7
```

需要同时更新 `tsconfig.json` 中的 `target` 和 `module` 选项。TypeScript 5 向后兼容，风险很低。

### P2-12: ESLint 升级到 v9

建议等其他改动稳定后再做，因为 flat config 迁移涉及插件兼容性。

### P2-13: 添加 Prettier

```bash
npm install -D prettier eslint-config-prettier
echo '{"semi": true, "singleQuote": true, "printWidth": 120}' > .prettierrc
```

### P2-14: 启用 sandbox

```typescript
// 将 sandbox: false 改为 sandbox: true
// 需要确保 preload.ts 不依赖 Node.js API（现在已经是纯 IPC 调用，应该没问题）
webPreferences: {
  preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,  // ← 改为 true
},
```

### P2-15: 关闭 remote-debugging-port

已在 P0-5 中一并处理。

---

## 实施建议

| 阶段 | 内容 | 时间估算 | 依赖 |
|------|------|----------|------|
| **Phase 1** | P0-5 (DevTools) + P0-4 (密码加密) + P1-9 (ErrorBoundary) | 1-2h | 无 |
| **Phase 2** | P0-1 (拆分index.ts) + P0-2 (类型统一) + P0-3 (消除重复) | 2-3h | 无 |
| **Phase 3** | **P1-6 (Camoufox 引擎迁移)** | **10 天** | Phase 2 完成后 |
| **Phase 4** | P1-7 (许可证) + P1-8 (IPC清理) + P1-10 (测试) | 3-4h | 确认许可证服务 |
| **Phase 5** | P2 (TS/ESLint/Prettier/sandbox) | 2-3h | Phase 3 完成后 |

> [!TIP]
> Phase 1 和 Phase 2 可并行。**Phase 3 (Camoufox 迁移) 是最大工作量**，建议 Phase 1/2 完成后全力推进。

## 验证计划

### 自动化测试
- Phase 4 添加 Vitest 后，运行 `npx vitest run` 验证纯函数模块
- 现有项目无测试框架，暂无可运行的自动测试

### 手动验证
1. **P0-4 密码加密**: 启动应用 → 添加账户 → 关闭重开 → 验证账户数据恢复 → 打开 DevTools 确认 localStorage 无明文密码
2. **P0-5 DevTools**: `npm run package` 打包后启动 → 确认 DevTools 不自动打开
3. **P0-1/2/3 重构**: `npm start` 启动 → 验证所有功能页面正常（账户、代理、任务、设置）
4. **P1-8 IPC清理**: 在多个页面间快速切换 → 检查控制台无重复事件触发
5. **P1-9 ErrorBoundary**: 在代码中临时 `throw new Error()` → 确认显示错误回退 UI 而非白屏
