# Let's Encrypt IP 证书自动续签功能

## 背景

Let's Encrypt 已于 2026年1月 正式支持 IP 地址证书（General Availability）。IP 证书是短期证书（6天有效期），需要频繁续签。用户希望在 Dashboard 中增加一个功能来自动管理这些证书。

## User Review Required

> [!IMPORTANT]
> **关键问题需要用户确认：**
> 1. **验证方式**：Let's Encrypt IP 证书仅支持 `http-01` 和 `tls-alpn-01` 验证（不支持 dns-01）。这意味着需要在目标 IP 的服务器上临时响应 HTTP 验证请求（端口 80）。你的服务器上是否有 80 端口可用？还是需要通过其他方式（如 SSH 到远程服务器放置验证文件）？
> 2. **证书用途**：证书生成后，你希望证书文件保存在哪里？是存在 dashboard 本地，还是需要自动部署到远程服务器？
> 3. **多 IP 支持**：是否需要管理多个 IP 的证书，还是只需要一个 IP？
> 4. **续签间隔**：6天有效期的证书，建议每 4 天续签一次。你可以接受这个频率吗？

## 预期方案

### 核心架构

- **ACME 库**：使用 `acme-client` v5.4.0（最成熟的 Node.js ACME 客户端，支持 http-01 验证）
- **存储**：在现有 `ops.db` SQLite 数据库中新增表来管理证书配置和历史
- **调度器**：在现有 `server.ts` 中新增定时器（类似 Domain Guard Scheduler 模式），定期检查证书是否需要续签
- **UI 页面**：新增 `/ssl-certs` 页面，在 Sidebar 中为新页面添加导航入口

### 新增文件概览

| 文件 | 说明 |
|------|------|
| `src/app/ssl-certs/page.tsx` | SSL 证书管理页面 |
| `src/app/actions/ssl-certs.ts` | Server Actions（增删改查、手动申请/续签） |
| `src/app/api/ssl-certs/challenge/route.ts` | HTTP-01 验证端点 |
| `src/lib/acme.ts` | ACME 核心逻辑封装 |

### 需修改的文件

| 文件 | 修改内容 |
|------|----------|
| `src/lib/db.ts` | 新增 `ssl_certificates` 和 `ssl_acme_accounts` 表 |
| `src/components/sidebar.tsx` | 添加 SSL Certs 导航项 |
| `server.ts` | 新增 SSL 证书续签调度器 |
| `package.json` | 添加 `acme-client` 依赖 |

### 数据库设计

```sql
-- ACME 账户（每个 email 一个）
CREATE TABLE IF NOT EXISTS ssl_acme_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  account_key TEXT NOT NULL,         -- PEM 私钥
  account_url TEXT,                  -- ACME 账户 URL
  directory_url TEXT NOT NULL,       -- production/staging
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 证书记录
CREATE TABLE IF NOT EXISTS ssl_certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_address TEXT NOT NULL,
  acme_account_id INTEGER REFERENCES ssl_acme_accounts(id),
  certificate_pem TEXT,              -- 证书内容(BEGIN CERTIFICATE)
  private_key_pem TEXT,              -- 私钥内容(BEGIN RSA PRIVATE KEY)
  chain_pem TEXT,                    -- 证书链
  issued_at DATETIME,
  expires_at DATETIME,
  last_renewal_at DATETIME,
  auto_renew INTEGER DEFAULT 1,
  status TEXT DEFAULT 'pending',     -- pending/active/expired/error
  last_error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### UI 功能

1. **IP 列表管理**：添加/删除需要管理证书的 IP 地址
2. **证书状态展示**：显示每个 IP 的证书状态、到期时间、上次续签时间
3. **手动操作**：手动申请/续签证书按钮
4. **证书下载**：下载证书文件（.pem）和私钥文件（.key），格式如用户要求
5. **自动续签开关**：每个 IP 可独立控制是否自动续签
6. **ACME 账户管理**：配置 Let's Encrypt 邮箱

### 自动续签流程

```
server.ts 定时器 (每4小时检查一次)
  ↓
检查 ssl_certificates 表中 auto_renew=1 的记录
  ↓
如果 expires_at - now < 2天 → 触发续签
  ↓
调用 acme-client 的 auto() 申请新证书
  ↓
更新数据库中的证书和私钥
```

## Verification Plan

### 自动化验证
- 本项目无现有测试框架，不适合添加单元测试

### 手动验证
1. **启动验证**：`npm run dev`，确认无编译错误
2. **Sidebar 导航**：确认侧边栏出现 "SSL Certs" 入口
3. **页面加载**：点击 "SSL Certs"，确认页面正常渲染
4. **添加 IP**：在页面输入 IP 地址和邮箱，点击添加，确认出现在列表中
5. **证书申请**：点击"申请证书"按钮，确认流程启动（实际能否成功取决于网络环境和 IP 可达性）
6. **证书下载**：证书申请成功后，点击下载按钮，确认下载的文件包含正确的 PEM 格式
