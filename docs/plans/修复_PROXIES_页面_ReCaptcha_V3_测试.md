# 修复 PROXIES 页面 ReCaptcha V3 测试

## 架构澄清

| 页面 | 功能 | Site Key |
|------|------|----------|
| **PROXIES** | 测代理 IP 的 V3 分数 | 不需要自己的 key，用 demo 页面的 |
| **ACCOUNTS** | 测账号的 V2 OneClick / V3 Score | 使用账号 profile |

## 根因

导航到 `recaptcha-demo.appspot.com` 后，**又注入一个 `api.js?render=` 脚本**导致多脚本冲突 → `grecaptcha.execute is not a function`。

## 修复方案：AYCD 方式

**AYCD OneClick 的做法**：导航到 demo 页面 → ⏳ 等待页面自己完成 execute → 📊 读取页面返回的分数。

### 具体实现

修改 `getRecaptchaV3Score()` 中 PROXIES 调用路径：

1. **不注入任何额外 reCAPTCHA 脚本**
2. **拦截 demo 页面的 `siteverify` 后端响应**来获取分数
3. **移除对 `.env` 中 `RECAPTCHA_V3_SITE_KEY` / `SECRET` 的依赖**（PROXIES 测试不需要）

### [MODIFY] [recaptcha.ts](file:///Users/yuu/Downloads/vibe_coding/aycd/aycd-project/src/ipc/recaptcha.ts)

#### 新增函数 `getProxyRecaptchaV3Score()`

```typescript
// PROXIES 页面专用：测代理 IP 的 V3 分数（AYCD 方式）
export async function getProxyRecaptchaV3Score(
  params: ProxyTestParams | undefined,
  timeoutMs = 30_000,
): Promise<RecaptchaV3Result> {
  // 1. 启动浏览器（配置代理）
  // 2. 导航到 demo 页面，不注入任何脚本
  // 3. 拦截 page response：
  //    监听 /recaptcha-v3-verify.php 的响应
  //    该响应包含 JSON { success, score, action, ... }
  // 4. 返回 { ok, score, action, hostname }
}
```

#### 关键逻辑：通过 response 拦截获取分数

```typescript
// 拦截 demo 页面发给自己后端的验证请求
let verifyResult: RecaptchaVerifyResponse | null = null;
page.on('response', async (response) => {
  if (response.url().includes('recaptcha-v3-verify.php')) {
    try {
      const json = await response.json();
      verifyResult = json;
    } catch { /* ignore */ }
  }
});

// 导航到 demo 页面，等待完成
await page.goto(demoUrl, { waitUntil: 'networkidle', timeout: timeoutMs });

// 等待验证完成
await page.waitForFunction(
  () => document.body.innerText.includes('score'),
  { timeout: timeoutMs }
);
```

#### 保留原有 `getRecaptchaV3Score()`

ACCOUNTS 页面的 V3 Score 测试仍使用原函数（但修复本地服务器方式的竞态问题）。

### [MODIFY] [proxy.ts](file:///Users/yuu/Downloads/vibe_coding/aycd/aycd-project/src/ipc/proxy.ts)

第298行：将调用改为新的 `getProxyRecaptchaV3Score()`。

## 优势

- ✅ 完全消除多脚本冲突
- ✅ 与 AYCD OneClick 行为一致
- ✅ 无需 `.env` 配置 reCAPTCHA key
- ✅ 不影响 ACCOUNTS 测试

## 验证

1. 运行 `npm start`，PROXIES 页面选代理 → Test → ReCaptcha V3
2. 控制台应无 `grecaptcha.execute is not a function` 错误
3. 应返回 0.1~0.9 的分数
