# AYCD Bot-Engine 迁移方案 (最终版)

> **主力引擎**: Camoufox + Playwright (C++ 级反检测)
> **Chromium 备选**: 通过 DonutBrowser REST API 调用 Wayfern（可选，非必须）

## 技术选型依据

| 方案 | 反检测层级 | 独立 SDK | Google 检测抗性 | 选择 |
|------|-----------|---------|---------------|------|
| Camoufox + Playwright | C++ 源码级 | ✅ `camoufox-js` | 🟢 高 | **✅ 主力** |
| Wayfern (DonutBrowser) | CDP JS 注入 | ❌ 无 | 🟡 中 | 备选 |
| dechromium | C++ patch | ✅ `pip install` | 🟡 中 | 候选 |
| BotBrowser | C++ patch | ❌ 独立二进制 | 🟡 中 | 不选 |

> [!IMPORTANT]
> Wayfern 经深度分析确认为 **CDP 运行时 JS 注入**，非 C++ 级修改。
> Google 高级检测可识别 CDP 注入痕迹，不适合作为 Google 账号主力方案。

---

## 依赖变更

```diff
# 移除
- "puppeteer": "^x.x.x"
- "ghost-cursor": "^x.x.x"

# 新增
+ "camoufox-js": "latest"
+ "playwright-core": "latest"  # peer dependency
```

---

## Phase 0: 安装验证 (Day 1)

```bash
npm install camoufox-js playwright-core
npm uninstall puppeteer ghost-cursor
npx camoufox-js fetch  # 下载 Camoufox Firefox (~700MB)
```

验证脚本：

```typescript
import { Camoufox } from 'camoufox-js';

const browser = await Camoufox({
  headless: true,
  os: 'windows',
  geoip: true,
  humanize: 1.5,
  enable_cache: true,
  window: [1280, 720],
});
const page = await browser.newPage();
await page.goto('https://bot.sannysoft.com');
await page.screenshot({ path: 'camoufox-test.png' });
await browser.close();
```

---

## Phase 1: 重写 `browser.ts` (Day 2-3)

**删除 ~170 行，新增 ~20 行：**

| 删除 | 行数 | 原因 |
|------|------|------|
| `createPage()` JS stealth 注入 | ~100行 | Camoufox C++ 内建 |
| `getChromiumExecutablePath()` | ~30行 | Camoufox 自带 Firefox |
| Chrome args 数组 | ~20行 | 配置对象替代 |
| `setUserAgent()` 硬编码 | ~5行 | BrowserForge 自动生成 |
| `ghost-cursor` 初始化 | ~15行 | Camoufox humanize 参数 |

**新的 `launchBrowser()`：**

```typescript
import { Camoufox } from 'camoufox-js';
import type { Browser, Page } from 'playwright-core';

export async function launchBrowser(opts: BrowserOptions): Promise<Browser> {
  return Camoufox({
    headless: opts.headless ?? true,
    os: ['windows', 'macos'],
    proxy: opts.proxy,
    geoip: true,
    humanize: 1.5,
    enable_cache: true,
    window: [opts.windowSize?.width ?? 1280, opts.windowSize?.height ?? 720],
  });
}
```

**新的 `createPage()` — 无 stealth 注入：**

```typescript
export async function createPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60_000);
  page.setDefaultTimeout(30_000);
  return page;
}
```

---

## Phase 2: API 适配 (Day 4-5)

| Puppeteer | Playwright | 受影响文件 |
|-----------|-----------|-----------|
| `page.$(sel)` | `page.locator(sel)` | googleAuth, captcha |
| `page.$eval(sel, fn)` | `page.locator(sel).evaluate(fn)` | googleAuth |
| `page.$$eval(sel, fn)` | `page.locator(sel).evaluateAll(fn)` | googleAuth |
| `page.waitForSelector(sel)` | `page.locator(sel).waitFor()` | humanizer, tasks |
| `page.waitForNavigation()` | `page.waitForLoadState()` | googleAuth |
| `page.cookies()` | `page.context().cookies()` | googleAuth |
| `page.deleteCookie()` | `page.context().clearCookies()` | googleAuth |
| `import { Page } from 'puppeteer'` | `import { Page } from 'playwright-core'` | **全部 24 文件** |

> [!IMPORTANT]
> `googleAuth.ts` (710行) 是适配工作量最大的文件。
> `page.evaluate()` / `page.goto()` / `page.keyboard.*` 两者 API 相同。

---

## Phase 3: humanizer + Profile 适配 (Day 6-7)

**humanizer.ts 精简：**

```diff
- import { GhostCursor } from 'ghost-cursor';
- const cursorCache = new WeakMap<Page, GhostCursor>();

  export async function humanClick(page: Page, selector: string) {
-   const cursor = getCursor(page);
-   await cursor.click(selector, { moveDelay, hesitate, ... });
+   await page.locator(selector).click({ delay: randInt(50, 150) });
    await randomDelay(80, 260);
  }
```

**profileManager.ts 适配 Firefox：**

```diff
- const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
+ const lockFiles = ['lock', '.parentlock', 'parent.lock'];
- const PROFILES_DIR_NAME = 'browser-profiles';
+ const PROFILES_DIR_NAME = 'camoufox-profiles';
```

---

## Phase 4: 集成测试 (Day 8-10)

| 测试项 | 验证内容 |
|--------|---------|
| bot.sannysoft.com | webdriver / plugins / languages 全部 pass |
| CreepJS | 指纹唯一性，无 headless 特征 |
| Google 登录 | `googleAuth.ts` 完整流程 |
| 8 个 task 模块 | search / youtube / gmail / maps / news 等回归 |
| 代理支持 | HTTP / SOCKS5 / 带认证代理 |
| Headless ↔ Visible 切换 | `onSwitchToVisible` 回调 |

---

## 文件影响清单

| 文件 | 操作 | 工作量 |
|------|------|--------|
| `browser.ts` | 🔴 重写 | 大 |
| `humanizer.ts` | 🟡 精简 | 中 |
| `googleAuth.ts` | 🟡 API 映射 | 大 |
| `captchaHandler.ts` | 🟡 API 映射 | 中 |
| `captchaSolver.ts` | 🟡 API 映射 | 小 |
| `taskExecutor.ts` | 🟢 改 import | 小 |
| `index.ts` | 🟡 类型 + lifecycle | 中 |
| `profileManager.ts` | 🟡 Firefox 适配 | 小 |
| `behavior/*.ts` (6个) | 🟢 改 import | 小 |
| `tasks/*.ts` (8个) | 🟢 改 import + 微调 | 小 |
| `package.json` | 🟢 依赖替换 | 小 |

---

## 可选：Chromium 场景补充

如未来需要 Chromium 引擎（非 Google 账号场景），可通过以下方式补充：

```
AYCD → HTTP → DonutBrowser REST API → Wayfern Profile → Chromium
```

需安装 [DonutBrowser](https://donutbrowser.com) 桌面端（AGPL-3.0，Pro 付费获商业许可）。
此为**可选补充**，主力流程不依赖。
