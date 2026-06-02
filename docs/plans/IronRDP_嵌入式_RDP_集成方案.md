# IronRDP 嵌入式 RDP 集成方案

## 核心原则

**直接使用 IronRDP 本体**（`web-client/` 目录），不依赖第三方分支包。

## 架构

```
┌─────────────────────────────────────────────────┐
│                  Tauri App                       │
│  ┌───────────────────────┐  ┌─────────────────┐ │
│  │   前端 WebView          │  │  Rust 后端       │ │
│  │                        │  │                 │ │
│  │  ironrdp-web (WASM)    │  │  WS→TCP 代理     │ │
│  │  ┌────────────────┐   │  │  ┌───────────┐  │ │
│  │  │ SessionBuilder │───│──│─▶│ WS Server  │  │ │
│  │  │ Canvas 渲染     │   │  │  │    ↓       │  │ │
│  │  │ 键鼠输入        │   │  │  │ SOCKS5代理  │  │ │
│  │  └────────────────┘   │  │  │    ↓       │  │ │
│  │                        │  │  │ TCP→RDP    │  │ │
│  └───────────────────────┘  │  └───────────┘  │ │
│                              └─────────────────┘ │
└─────────────────────────────────────────────────┘
                                      │
                              ┌───────▼───────┐
                              │  RDP 服务器     │
                              │ (远程 Windows)  │
                              └───────────────┘
```

### 数据流

```
用户操作 → WASM 编码 → WebSocket → Rust WS Server → SOCKS5(Clash) → TCP:3389 → RDP Server
RDP Server → TCP → Rust 转发 → WebSocket → WASM 解码 → Canvas 渲染
```

## 技术选型

| 组件 | 技术 | 来源 |
|------|------|------|
| RDP WASM | `ironrdp-web` | IronRDP 本体 `web-client/` |
| WASM 构建 | `wasm-pack --target web` | 自编译 |
| WS Server | `tokio-tungstenite` | crates.io |
| SOCKS5 代理 | `tokio-socks` → Clash 端口 | crates.io |
| Canvas 渲染 | HTML5 Canvas 2D | 浏览器原生 |
| 输入处理 | `ironrdp-input` (含在 WASM) | IronRDP 本体 |

## 为什么用官方 web-client 而不是第三方包？

- `electerm/ironrdp-wasm` 只是把官方 `web-client/` 编译发了 npm
- 直接用本体可随时同步最新版本、自定义编译选项
- IronRDP 官方已有 **Tauri hackathon 演示视频**，证明可行

---

## ⚠️ 已知问题与风险 (调研发现)

> [!CAUTION]
> 以下问题来自并行搜索 IronRDP GitHub Issues、HN 讨论、Cloudflare RDP 博客等多方来源。

### 1. XRDP 不兼容 (Issue #314) — 中风险

- IronRDP **仅支持 TLS + NLA (CredSSP)**，不支持 "Standard RDP Security" (RC4)
- XRDP 在旧版本 [不支持 NLA](https://github.com/neutrinolabs/xrdp/issues/256)
- **影响**: 连接 Linux XRDP 服务器可能失败 (`InvalidContentType` 错误)
- **缓解**: 我们的目标是 Windows RDP，XRDP 非主要用例；XRDP 新版已支持 NLA

### 2. Canvas 高频刷新无响应 (Issue #790) — 中风险

- 当远程帧缓冲区快速更新时，`ironrdp-web` 可能变得 **无响应**
- **影响**: 远程桌面操作密集场景 (如视频播放) 可能卡顿
- **缓解**: Phase 1 MVP 可用 requestAnimationFrame 节流渲染；后期优化使用 OffscreenCanvas

### 3. 键盘映射问题 (Issue #535, #667) — 低风险

- 左 Shift 和方向键在某些浏览器引擎不工作
- Blink (Chrome/Tauri WebView) 的 Scancode 映射异常
- **缓解**: Tauri 使用 WebView2/WKWebView，需测试并 patch keymap

### 4. WS→TCP 代理需自建 — 确定

- 没有现成的 "IronRDP WS→TCP proxy" Rust crate
- **参考**: [`sile/wstcp`](https://github.com/sile/wstcp) (58⭐) 提供基础 WS↔TCP 双向 relay 模板
- **方案**: 基于 `tokio-tungstenite` 自建，核心代码约 100-200 行

### 5. TLS/CredSSP 在 WASM 中的处理 — 重要

- WASM 环境中 **无法直接做 TLS 握手** (没有 socket 访问)
- TLS + NLA 认证 **必须在 Rust 后端完成**，WASM 端只处理已解密的 RDP 数据流
- 这是 Cloudflare 和 Devolutions 自身的做法 — 符合我们的架构设计

---

## 实现分期

### Phase 1: MVP — 基础 RDP 连接 (3-5天)

- [ ] Clone IronRDP repo，编译 `web-client/ironrdp-web` → WASM
- [ ] Tauri Rust 后端：`tokio-tungstenite` WS→TCP 代理 (参考 `wstcp`)
- [ ] 后端处理 TLS/NLA 认证，转发解密后的 RDP 流给前端 WASM
- [ ] 前端：加载 WASM，Canvas 渲染 + 基础键鼠输入
- [ ] 服务器列表页：增加 "RDP 连接" 按钮 → 打开 RDP 标签页
- [ ] 移除旧 MultiDesk 相关 UI 代码
- [ ] Canvas 渲染节流 (requestAnimationFrame) 防止 #790

### Phase 2: 代理加速 + 体验优化 (1-2周)

- [ ] SOCKS5 代理集成（WS→TCP 经由 Clash 加速）
- [ ] 多会话标签页管理
- [ ] 分辨率自适应 + 全屏模式
- [ ] 连接状态 UI（连接中/已连接/断开）
- [ ] 凭据保存/管理
- [ ] 键盘映射修复 (Shift/方向键/Scancode)

### Phase 3: 高级功能 (可选)

- [ ] 剪贴板共享 (`ironrdp-cliprdr`) — Teleport 已验证可用
- [ ] 文件传输 (`ironrdp-rdpdr`)
- [ ] 音频重定向 (`ironrdp-rdpsnd`)
- [ ] RemoteFX 硬件加速
- [ ] OffscreenCanvas + Web Worker 优化渲染性能

---

## 参考资源

| 资源 | 链接 |
|------|------|
| IronRDP 官方 | [github.com/Devolutions/IronRDP](https://github.com/Devolutions/IronRDP) (2.9k ⭐) |
| 官方 web-client | [web-client/](https://github.com/Devolutions/IronRDP/tree/master/web-client) |
| Tauri 演示视频 | README 中 `ironrdp-tauri-client-hackaton-result.mp4` |
| Cloudflare RDP 博客 | [browser-based-rdp](https://blog.cloudflare.com/browser-based-rdp) — 相同架构 |
| Teleport 集成 PR | [gravitational/teleport#33335](https://github.com/gravitational/teleport/pull/33335) |
| WS→TCP 参考 | [sile/wstcp](https://github.com/sile/wstcp) |
| Issue: XRDP | [#314](https://github.com/Devolutions/IronRDP/issues/314) |
| Issue: Canvas 卡顿 | [#790](https://github.com/Devolutions/IronRDP/issues/790) |
| Issue: 键盘 | [#535](https://github.com/Devolutions/IronRDP/issues/535), [#667](https://github.com/Devolutions/IronRDP/issues/667) |

## IronRDP Crate 模块对照

```
ironrdp (meta)
├── ironrdp-connector    # 连接握手 + NLA/CredSSP
├── ironrdp-session      # 会话管理
├── ironrdp-graphics     # 图像解码 (RFX/RLE/ZGFX)
├── ironrdp-input        # 键鼠输入编码
├── ironrdp-cliprdr      # 剪贴板 (Teleport 已验证)
├── ironrdp-rdpdr        # 设备/文件重定向
├── ironrdp-rdpsnd       # 音频
├── ironrdp-web          # WASM 桥接层 (web-client/)
└── ironrdp-tokio        # Async TCP 传输
```
