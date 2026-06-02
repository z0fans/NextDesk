# SSL 证书自动续签功能 - 完成报告

## 功能概览

实现了 Let's Encrypt IP 证书的自动申请和续签功能，证书内容保存在面板数据库中，随时可复制粘贴。

## 修改/新建文件

### 新建文件

| 文件 | 说明 |
|------|------|
| [acme.ts](file:///Users/yuu/Downloads/vibe_coding/dashboard/src/lib/acme.ts) | ACME 核心逻辑：HTTP-01 挑战管理、证书申请 |
| [route.ts](file:///Users/yuu/Downloads/vibe_coding/dashboard/src/app/api/ssl-certs/challenge/%5B...token%5D/route.ts) | HTTP-01 验证端点 |
| [ssl-certs.ts](file:///Users/yuu/Downloads/vibe_coding/dashboard/src/app/actions/ssl-certs.ts) | Server Actions：增删改查、证书申请/续签 |
| [page.tsx](file:///Users/yuu/Downloads/vibe_coding/dashboard/src/app/ssl-certs/page.tsx) | SSL 证书管理 UI 页面 |

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| [db.ts](file:///Users/yuu/Downloads/vibe_coding/dashboard/src/lib/db.ts) | 新增 `ssl_acme_accounts` 和 `ssl_certificates` 表 |
| [sidebar.tsx](file:///Users/yuu/Downloads/vibe_coding/dashboard/src/components/sidebar.tsx) | 添加 SSL Certs 导航项（KeyRound 图标） |
| [server.ts](file:///Users/yuu/Downloads/vibe_coding/dashboard/server.ts) | 新增 SSL 证书续签调度器（每4小时检查） |

## 功能详情

### UI 页面 (`/ssl-certs`)
- **添加 IP 证书**：输入 IP 地址、ACME 邮箱、续签间隔
- **证书列表**：状态标签、到期倒计时、上次续签时间
- **证书查看**：展开查看 PEM 内容，支持**复制到剪贴板**和**下载文件**
- **四种证书格式**：证书文件、私钥文件、证书链、完整证书链
- **自动续签开关**：每个 IP 可独立控制

### 自动续签调度器
- 每 **4 小时** 检查一次所有开启自动续签的证书
- 达到续签间隔阈值时自动调用 ACME 申请新证书
- 默认 **5 天**续签一次（可调整为 1-6 天）
- 服务启动 30 秒后首次检查

## 验证结果

- ✅ TypeScript 编译通过（`tsc --noEmit` 无错误）
- ✅ 页面正常加载（需登录认证后访问）
- ✅ Sidebar 导航项显示正确

## ⚠️ 使用注意

> [!IMPORTANT]
> **端口 80 必须可用**：Let's Encrypt 的 HTTP-01 验证需要通过端口 80 访问 `http://<IP>/.well-known/acme-challenge/<token>`。如果你的 Dashboard 运行在 3000 端口，需要配置端口 80 反向代理到 3000，或用 iptables/nginx 转发 `.well-known` 路径。
