# ReCaptcha V3 Proxy Score — 调试 Walkthrough

## 问题

使用 Camoufox 通过某些代理访问 reCAPTCHA demo 页面时，`grecaptcha.execute is not a function` 导致无法获取 V3 分数。

## 根因

Google 根据代理 IP 信誉决定加载**标准 v3 API**（`api2/`）还是 **Enterprise API**（`enterprise/`）：
- 标准 API → `grecaptcha.execute()` 存在 → ✅ 正常
- Enterprise API → 只有 `grecaptcha.enterprise.execute()` → ❌ 在 Firefox/Camoufox 上报错

Chrome 内置了 Enterprise→标准的兼容层，但 Firefox/Camoufox 没有。

## 解决方案

用 `page.route()` 在**网络层**拦截 Enterprise API URL，重定向到标准 v3 API：

```typescript
// enterprise.js → api.js
await page.route('**/recaptcha/enterprise.js**', (route) => {
  const url = route.request().url().replace('/recaptcha/enterprise.js', '/recaptcha/api.js');
  route.continue({ url });
});
// enterprise/anchor → api2/anchor
await page.route('**/recaptcha/enterprise/**', (route) => {
  const url = route.request().url().replace('/recaptcha/enterprise/', '/recaptcha/api2/');
  route.continue({ url });
});
```

## 尝试过但失败的方案

| 方案 | 失败原因 |
|------|----------|
| DOM 文本检测错误 | `grecaptcha.execute` 错误在 JS 运行时而非 DOM |
| `page.on('pageerror')` + 重试 | 重试后 Google 仍路由到 Enterprise |
| `addInitScript` + `Object.defineProperty` shim | Firefox Playwright 的 `addInitScript` 时序/上下文问题 |

## 修改文件

- [recaptcha.ts](file:///Users/yuu/Downloads/vibe_coding/aycd/aycd-project/src/ipc/recaptcha.ts#L149-L161)

## 验证

- ✅ `tsc --noEmit` 编译通过
- ✅ 之前失败的 SOCKS 代理现在能成功获取 V3 Score
- ✅ 标准代理仍然正常工作（route 只匹配 enterprise URL）
