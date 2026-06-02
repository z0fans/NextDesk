# Tube Mode 部署与设置指南

> **Tube Mode** 是 NextDesk 的多链路聚合加速功能。通过 Aggligator 协议，同时使用多条代理链路传输 RDP 数据，实现带宽叠加和链路冗余。当某条链路中断时，RDP 不会断连。

---

## 架构概览

```
NextDesk 客户端                    VPS (调度器)               RDP 服务器
┌──────────────┐                ┌──────────────┐          ┌──────────┐
│  rdp_proxy   │ ──Link1(代理A)──▶│              │          │          │
│  (tube.rs)   │ ──Link2(代理B)──▶│ tube-server  │──TCP────▶│  RDP:3389│
│  Aggligator  │ ──Link3(代理C)──▶│  :9000       │          │          │
└──────────────┘                └──────────────┘          └──────────┘
      ↑ 每条 Link 走不同的 Clash SOCKS5 出口节点
```

---

## 第一步：部署 VPS 调度器 (tube-server)

### 前置要求

| 项目 | 要求 |
|:---|:---|
| **VPS** | 1 核 512MB+, Ubuntu 22.04 / Debian 12 |
| **位置** | 与 RDP 服务器同区域 (低延迟) |
| **端口** | TCP 9000 开放 |
| **域名** | 可选，建议绑定 (如 `tube.yourdomain.com`) |

### 安装与编译

```bash
# 1. 安装 Rust (如果还没有)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# 2. 上传 tube-server 源码到 VPS
# 方法 A: 从 NextDesk 仓库复制 tube-server/ 目录
scp -r tube-server/ user@vps-ip:~/tube-server/

# 方法 B: 直接在 VPS 上 clone (如果仓库有权限)
# git clone ... && cd NextDesk/tube-server

# 3. 编译
cd ~/tube-server
cargo build --release
```

### 启动

```bash
# 手动测试
./target/release/tube-server --listen 0.0.0.0:9000

# 生产环境: 使用 systemd
sudo cp target/release/tube-server /usr/local/bin/
sudo tee /etc/systemd/system/tube-server.service << 'EOF'
[Unit]
Description=Tube Mode Dispatcher
After=network.target

[Service]
ExecStart=/usr/local/bin/tube-server --listen 0.0.0.0:9000
Restart=always
RestartSec=5
Environment=RUST_LOG=info

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now tube-server
```

### 验证

```bash
# 检查是否在监听
ss -tlnp | grep 9000

# 查看日志
journalctl -u tube-server -f
```

> [!NOTE]
> `tube-server` 支持**动态目标** — 客户端连接时发送 RDP 地址，一台 VPS 可转发到任意 RDP 服务器。无需为每个 RDP 目标配置不同端口。

---

## 第二步：配置 NextDesk 客户端

### 2.1 修改调度器域名

编辑 `src-tauri/src/tube.rs`，将内置域名改为你的 VPS 地址：

```rust
// 第 11-14 行
const TUBE_DISPATCHERS: &[(&str, &str)] = &[
    ("us",   "tube-us.yourdomain.com:9000"),  // ← 改为你的 VPS
    ("asia", "tube-asia.yourdomain.com:9000"), // ← 改为你的 VPS
];
```

> 如果只有一台 VPS，两个都填同一个地址即可。

### 2.2 (可选) 下载 GeoIP 数据库

GeoIP 用于根据 RDP 服务器 IP 自动选择最近的调度器。如果不需要自动选择，可以跳过。

```bash
# 下载 MaxMind Country.mmdb (需要注册免费 License)
# 放到 NextDesk 配置目录:
# macOS: ~/Library/Application Support/NextDesk/Country.mmdb
# Windows: %APPDATA%/NextDesk/Country.mmdb
```

### 2.3 开启 Tube Mode

在 NextDesk 应用中：
1. **设置页面** → 找到 **Tube 模式加速** 开关
2. 打开开关
3. 连接 RDP — 系统自动通过多链路聚合连接

---

## 第三步：验证 Tube Mode 工作

### 查看日志

Rust 后端日志 (`npx tauri dev` 控制台):
```
[tube] Link 0 connected
[tube] Link 1 connected
[tube] Link 2 connected
[tube] 3/3 links up
[rdp_proxy] [TUBE] Response sent, relay
```

VPS 端日志:
```bash
journalctl -u tube-server -f
# 预期:
# link from 1.2.3.4:54321
# link from 1.2.3.4:54322
# link from 1.2.3.4:54323
# connecting to RDP target: 10.0.0.5:3389
```

### 容错测试

1. 连接 RDP (Tube Mode 已开启)
2. 在 Clash 中手动断开一个代理节点
3. **预期**: RDP 不断连，画面可能卡顿 1-2 秒后恢复

---

## 故障排查

| 症状 | 可能原因 | 解决方案 |
|:---|:---|:---|
| "No links connected" | Clash 未启动 / SOCKS5 端口不对 | 检查 Clash 的 SOCKS5 端口 (默认 17897) |
| "aggligator connect" 错误 | 调度器不可达 | 检查 VPS 防火墙，确认 9000 端口开放 |
| 连接成功但无画面 | TLS 握手失败 | 检查 VPS 到 RDP 服务器的网络连通性 |
| GeoIP 失效 (回退默认) | Country.mmdb 文件缺失 | 下载 GeoIP 数据库到配置目录 |

---

## 相关文件

| 文件 | 说明 |
|:---|:---|
| `src-tauri/src/tube.rs` | 客户端 Aggligator 聚合逻辑 |
| `src-tauri/src/rdp_proxy.rs` | RDP 代理，集成 Tube Mode 分支 |
| `tube-server/src/main.rs` | VPS 调度器 |
| `tube-server/Cargo.toml` | 调度器依赖 |
| `docs/plans/2026-03-28-tube-mode.md` | 详细实施计划 |
