# Security 页面重设计方案

## 问题分析

| 问题 | 当前状态 | 原因 |
|------|---------|------|
| Firewall Tab 松散空旷 | Deploy 按钮孤立右上，Port Blocking 和 Status Table 纵向堆叠 | 缺乏分层，全局/单机混在一起 |
| 语义不清 | Port Blocking Rules 看似可以 per-VM 操作 | 实际是**集群级安全组**，应与 VM 表区分 |
| Traffic Tab 空洞 | ntopng 未配置时只显示一行文字 | 空状态无引导 |
| 整体稀疏 | 每个 Tab 内容不够充实 | 布局没利用好横向空间 |

## 设计方案

### Firewall Tab — 全局/单机分层

```
┌─ 全局策略区域 (Global Policy) ──────────────────────────────┐
│ ┌─ Deploy Card ─────────┐ ┌─ Port Blocking Rules ──────────┐ │
│ │ 🛡 Anti-Abuse Policy  │ │ 🔒 Port Blocking Rules        │ │
│ │                       │ │                                │ │
│ │  [部署进度环形图或     │ │  EMAIL/SPAM  DNS/NTP  AMPLIF  │ │
│ │   已部署/总数指标]     │ │  :25 SMTP ✅  :53 DNS ✅      │ │
│ │                       │ │  :465 SMTPS   :123 NTP        │ │
│ │  [Deploy All] 按钮    │ │  ...                          │ │
│ └───────────────────────┘ └────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘

┌─ 单机防火墙状态 (Per-VM Firewall Status) ───────────────────┐
│  🖥 Firewall Status  [XX VMs]                               │
│  ┌───────────────────────────────────────────────────┐      │
│  │ VMID │ Name │ Status │ Firewall │ Anti-Abuse │ ...│      │
│  └───────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

**关键设计要点**：
- 全局区域用 `grid-cols-1 lg:grid-cols-3`，左 1/3 = Deploy Card，右 2/3 = Port Blocking
- Deploy Card 展示**部署进度**（X/Y VMs deployed），视觉上更充实
- 全局区域有明确的**分组标题 "Global Policy"**
- Status Table 有明确标题 **"Per-VM Firewall Status"**

### Traffic Tab — 增强空状态

未配置 ntopng 时，显示配置引导卡片而非简单文字：
- 显示 ntopng 的说明和配置方法提示
- 展示该功能预期的效果示意（图标+说明）

### IP Reputation Tab — 增强空状态

未扫描时展示更丰富的引导：
- 明确的 CTA（Call to Action）引导用户扫描
- 说明 AbuseIPDB API Key 配置状态

## 修改文件

### [MODIFY] [SecurityPage.tsx](file:///Users/yuu/Downloads/vibe_coding/server-management-system/src/pages/SecurityPage.tsx)

1. **Firewall Tab 区域** (L864-898)：
   - 添加 "Global Policy" 分组，内部 grid 布局
   - 左侧新建 `DeployCard` 组件（部署进度 + Deploy All 按钮）
   - 右侧保留 `PortBlockingPanel`（不变）
   - 下方 `FirewallStatusTable` 添加分组标题 "Per-VM Status"

2. **Traffic Tab** (L901-925)：增强空状态展示

3. **IP Reputation Tab** (L928-930)：增强空状态展示

## 验证

- 浏览器打开 `http://localhost:3001/security`，三个 Tab 逐个检查
- 确认全局/单机层次清晰，页面不再空旷
- 确认响应式布局：桌面两栏 → 移动端单栏
