# RDP 断连诊断报告 - 完整版

> 诊断时间：2026-03-23 22:55 ~ 23:15 | 方式：SSH + route-monitor

## 结论：**XrayR 后端问题，链路健康**

---

## 一、route-monitor 面板数据

![route-monitor 面板截图](file:///Users/yuu/.gemini/antigravity/brain/6dcc1f49-e986-4b3c-b187-d4bc39ce95c2/dashboard_full_view_1774279086139.png)

| 指标 | 值 |
|------|-----|
| 总目标 | **64** |
| RDP 目标 | **28** |
| SSH 目标 | **0** |
| US-WEST 延迟 | **36ms** Active ✅ |
| US-EAST 延迟 | **92ms** Active ✅ |
| Target 健康 | **全部 ok** ✅ |
| 68.64.138.254:3389 | 22/0 (成功率100%) |

> 面板确认：所有目标可达，中转节点在线，链路无故障。

---

## 二、tools.sh 优化效果

| 指标 | 优化前 | 优化后 | 结论 |
|------|--------|--------|------|
| ulimit -n | 默认(1024) | **1,000,000** | ✅ 已解决 |
| TCP 缓冲区 | 系统默认 | **32MB** | ✅ 已解决 |
| BBR + fq | 已开启 | 已开启 | ✅ 无变化 |
| CLOSE-WAIT | **108** | **30** | ⬇️ 下降 |

> [!WARNING]
> tools.sh 解决了系统层面瓶颈，但 **XrayR 应用层问题仍在**：

---

## 三、仍存在的 3 个问题 ❌

### ❌ FD = 1162（仍然过高）

XrayR 运行 10 天，FD 仍在泄漏。ulimit 提高只是把天花板抬高了，**没有修洞**。

### ❌ 10 分钟 540 次 IO timeout

```
ConnIdle = 300s (5分钟)  ← 太短！
UplinkOnly = 30s         ← 太短！
DownlinkOnly = 30s       ← 太短！
```

RDP 用户 5 分钟不操作 → 连接被 XrayR 主动断掉。

### ❌ 562 FIN-WAIT-2 堆积 + 重传 27202

Observatory 每 30s 并发探测 2 中转节点 → 短连接风暴 → FD泄漏/FIN-WAIT-2

---

## 四、剩余修复（需重启 XrayR）

### 步骤 1：改 config.yml

```yaml
ConnectionConfig:
  Handshake: 8
  ConnIdle: 900       # 300→900
  UplinkOnly: 60      # 30→60
  DownlinkOnly: 60    # 30→60
  BufferSize: 1024    # 512→1024
```

### 步骤 2：改 observatory.json

```json
{
  "subjectSelector": ["US-"],
  "probeURL": "http://cp.cloudflare.com",
  "probeInterval": "300s",
  "enableConcurrency": false
}
```

### 步骤 3：中转 keepalive + 重启

```bash
# 中转 104.245.12.51
cat > /etc/sysctl.d/99-transit.conf << 'EOF'
net.ipv4.tcp_keepalive_time = 30
net.ipv4.tcp_keepalive_intvl = 10
net.ipv4.tcp_keepalive_probes = 6
EOF
sysctl -p /etc/sysctl.d/99-transit.conf

# 入口节点
systemctl restart XrayR   # 清理 1162 FD + 562 FIN-WAIT-2
```
