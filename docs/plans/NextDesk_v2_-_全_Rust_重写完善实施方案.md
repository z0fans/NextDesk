# NextDesk v2 — 全 Rust 重写完善实施方案

> **核心决策**：Tauri 2 (桌面容器) + Rust 后端 + 现有 React 前端保留
> **RDP 引擎**：IronRDP crate 直接引入（原生 Rust，支持 NLA/CredSSP）
> **网络引擎**：Clash/Mihomo 进程管理 + HTTP API 调用（用 reqwest）

---

## 📐 新架构总览

```
┌─────────────────────────────────────────────────────┐
│  NextDesk v2                                        │
├─────────────────┬───────────────────────────────────┤
│  前端 (保留)     │  React 19 + Vite 7 + Tailwind 4  │
│                 │  + shadcn/ui + lucide-react       │
│                 │  API: @tauri-apps/api invoke()    │
├─────────────────┼───────────────────────────────────┤
│  Tauri IPC      │  invoke() ↔ #[tauri::command]     │
├─────────────────┼───────────────────────────────────┤
│  Rust 后端       │  src-tauri/src/                   │
│  ├── rdp.rs     │  ironrdp-connector + ironrdp-     │
│  │              │  session + ironrdp-tokio           │
│  │              │  (CredSSP/NLA 内置, 原生 TCP+TLS) │
│  ├── clash.rs   │  reqwest → mihomo HTTP API        │
│  │              │  + Command 进程管理               │
│  ├── config.rs  │  serde_json + serde_yaml          │
│  ├── sub.rs     │  reqwest + base64 订阅解析        │
│  └── update.rs  │  self_update / tauri-plugin-      │
│                 │  updater                          │
└─────────────────┴───────────────────────────────────┘
```

---

## 🔧 IronRDP Crate 选型 (基于 DeepWiki 调研)

IronRDP 是 Cargo workspace，提供 `ironrdp` 元 crate，通过 feature flag 包含子模块：

| Crate | Feature Flag | 用途 | 我们是否需要 |
|-------|-------------|------|-------------|
| `ironrdp-connector` | `connector` | **连接状态机** (含 CredSSP/NLA/License) | ✅ 必须 |
| `ironrdp-session` | `session` | **活跃会话管理** (FastPath, 画面处理) | ✅ 必须 |
| `ironrdp-tokio` | `tokio` | Tokio 异步 IO 适配器 | ✅ 必须 |
| `ironrdp-input` | `input` | 键鼠输入 PDU 构造 | ✅ 必须 |
| `ironrdp-graphics` | `graphics` | 图像解码 (RemoteFX, Bitmap) | ✅ 必须 |
| `ironrdp-cliprdr` | `cliprdr` | 剪贴板重定向 | 🟡 Phase 2 |
| `ironrdp-tls` | `tls` | TLS 升级 (rustls/native-tls) | ✅ 自动依赖 |
| `ironrdp-pdu` | `pdu` | 协议数据单元 (默认启用) | ✅ 自动依赖 |

**Cargo.toml 依赖写法：**
```toml
[dependencies]
ironrdp = { version = "0.5", features = ["connector", "session", "tokio", "input", "graphics"] }
sspi = { version = "0.13", features = ["network_client"] }  # NLA/NTLM 支持
tokio = { version = "1", features = ["full"] }
```

> [!IMPORTANT]
> 官方 `ironrdp-client` crate 就是一个完整的原生桌面客户端参考实现（使用 winit + softbuffer 渲染）。我们可以直接参考其连接逻辑，但渲染部分替换为通过 Tauri WebSocket 事件推送到前端 Canvas。

---

## 🚀 分阶段执行计划

### Phase 0: Tauri 脚手架搭建 (0.5 天)

**目标**：在现有项目里初始化 Tauri 2，将 React 前端挂载进去。

```bash
# 1. 安装 Rust 工具链 (如果没有)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2. 在 NextDesk 项目根目录执行
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk
npm install -D @tauri-apps/cli@^2

# 3. 初始化 Tauri 后端 (会创建 src-tauri/ 目录)
npx tauri init
# 交互式回答：
#   App Name: NextDesk
#   Window Title: NextDesk
#   Web Assets: ../frontend/dist
#   Dev URL: http://localhost:5173
#   Dev Command: npm run dev --prefix frontend
#   Build Command: npm run build --prefix frontend
```

**产物**：
```
NextDesk/
├── frontend/          # 现有 React (不变)
├── src-tauri/         # 新增 Rust 后端
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── src/
│   │   └── main.rs
│   └── icons/
└── backend/           # 旧 Python 后端 (保留参考, 后续删除)
```

---

### Phase 1: API 桥接迁移 (2 天)

**目标**：用 Rust Tauri Command 重写 Python `api.py` 的所有方法。

#### Rust 后端文件结构
```
src-tauri/src/
├── main.rs          # Tauri 入口 + Command 注册
├── state.rs         # AppState 共享状态 (替代 Python Api 类)
├── clash.rs         # Clash 进程管理 + HTTP API
├── config.rs        # JSON/YAML 配置读写
├── subscription.rs  # 订阅链接解析
├── updater.rs       # 自动更新
└── rdp.rs           # IronRDP 连接管理 (Phase 3)
```

#### Python → Rust API 映射表

| Python 方法 | Tauri Command | Rust 实现要点 |
|-------------|--------------|--------------|
| `start_engine()` | `start_engine` | `Command::new("mihomo").arg("-f").arg(config_path).spawn()` |
| `stop_engine()` | `stop_engine` | `child.kill()` |
| `get_status()` | `get_status` | 检查子进程 PID 存活 |
| `load_subscription(url)` | `load_subscription` | `reqwest::get(url)` + base64 decode + serde_yaml |
| `get_servers()` | `get_servers` | `State<AppState>` 读取 |
| `get_proxy_groups()` | `get_proxy_groups` | `reqwest::get(clash_api/proxies)` |
| `switch_proxy(g, p)` | `switch_proxy` | `reqwest::put(clash_api/proxies/{})` |
| `test_group_delays(g)` | `test_group_delays` | 并发 `reqwest::get(delay)` via `tokio::spawn` |
| `test_servers_connectivity()` | `test_connectivity` | `TcpStream::connect_timeout()` |
| `get_system_language()` | `get_system_language` | `sys_locale::get_locale()` |

#### 前端迁移 (改动极小)

当前前端 `api.ts` 通过 `window.pywebview.api.xxx()` 调用 Python。只需改为：

```typescript
// 旧: window.pywebview.api.start_engine()
// 新:
import { invoke } from '@tauri-apps/api/core';
const result = await invoke<boolean>('start_engine');
```

**前端需要安装的包：**
```bash
cd frontend && npm install @tauri-apps/api
```

---

### Phase 2: Clash 管理重写 (1 天)

**目标**：Rust 版 Clash 进程守护与 API 交互。

核心 Rust 代码结构 (`clash.rs`)：
- 进程启动：`std::process::Command` / `tokio::process::Command`
- API 通信：`reqwest::Client` 调用 mihomo RESTful API
- 外部 Clash 检测：顺序探测 `[9090, 9097, 7891, 7890]` 端口
- 配置生成：`serde_yaml` 写入 `runtime_clash.yaml`

**关键 Cargo 依赖：**
```toml
reqwest = { version = "0.12", features = ["json"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_yaml = "0.9"
tokio = { version = "1", features = ["process", "net", "time"] }
```

---

### Phase 3: IronRDP 集成 (2-3 天) ⭐

**目标**：用 IronRDP crate 实现完整的原生 RDP 连接（含 NLA），替代 MultiDesk。

#### 技术路线决策

两条路可选，两条都行：

**路线 A (推荐)：嵌入式网关 Sidecar**
- 从 IronRDP 源码编译 `devolutions-gateway` 为独立可执行文件
- Tauri 配置为 [Sidecar](https://v2.tauri.app/develop/sidecar/)，随应用启动/停止
- 前端 WASM 通过 WebSocket 连接本地 Sidecar
- 沿用我们之前的 PoC 前端 Canvas 渲染代码

**路线 B：纯后端 RDP + WebSocket 画面推送**
- Rust 后端直接用 `ironrdp-connector` + `ironrdp-session` + `ironrdp-tokio`
- 后端完成 RDP 连接、画面解码，通过 Tauri Event 或 WebSocket 推送位图到前端
- 前端只渲染 Canvas + 捕获键鼠回传

**RDP 连接核心逻辑参考 (`rdp.rs`)：**
```rust
use ironrdp::connector::ClientConnector;
use ironrdp::session::ActiveStage;

// 1. 建立 TCP + TLS 连接
let stream = TcpStream::connect(format!("{}:{}", host, port)).await?;

// 2. ironrdp-connector 驱动完整握手 (自动处理 NLA/CredSSP)
let connector = ClientConnector::new(config);
// connector 内部状态机自动推进: X.224 → MCS → Security → License → ...

// 3. 进入 ActiveStage 画面循环
let active_stage = ActiveStage::new(/*...*/);
loop {
    let output = active_stage.process(frame).await?;
    // 将解码后的位图通过 WebSocket/Event 推送给前端
}
```

---

### Phase 4: 打包发布 (1 天)

**目标**：跨平台编译 + 安装包制作。

```bash
# macOS
npx tauri build --target universal-apple-darwin

# Windows
npx tauri build --target x86_64-pc-windows-msvc
```

Tauri 2 自带：
- macOS: `.dmg` / `.app`
- Windows: `.msi` / `.exe` (NSIS)
- 自动更新: `tauri-plugin-updater`

---

## 📊 工时估算汇总

| Phase | 内容 | 关键技术 | 工时 |
|-------|------|---------|------|
| 0 | Tauri 脚手架 | `npx tauri init` | 0.5 天 |
| 1 | API 桥接重写 | Tauri Command + reqwest | 2 天 |
| 2 | Clash 管理 | tokio::process + reqwest | 1 天 |
| 3 | IronRDP 集成 | ironrdp crate + NLA | 2-3 天 |
| 4 | 打包发布 | tauri build | 1 天 |
| **合计** | | | **~7 天** |

---

## ✅ 验证计划

### 每个 Phase 的验收标准

| Phase | 验收条件 |
|-------|---------|
| 0 | `npx tauri dev` 能打开窗口显示 React UI |
| 1 | 前端调用 `invoke('get_servers')` 成功返回数据 |
| 2 | Clash 进程被 Rust 拉起，API 延迟测试正常 |
| 3 | 输入 RDP 目标 IP + 凭据 → Canvas 渲染出 Windows 桌面 |
| 4 | `tauri build` 成功生成 macOS .dmg 和 Windows .msi |

### 浏览器自动化测试
- Phase 1/2：通过 Playwright 测试 UI 交互
- Phase 3：手动验证 RDP 连接（需真实 Windows 服务器）

你想从 **Phase 0** 开始动手吗？
