# AGENTS.md — NextDesk

> 本文档供 AI 编码助手阅读，提供项目上下文、架构约束和编码规范。

## 项目概述

NextDesk 是一款 **跨平台加速远程桌面客户端**，集成了 RDP 远程桌面（IronRDP WASM）与 Clash 网络加速引擎，基于 **Tauri 2 + React 19** 构建。

- **仓库**: `z0fans/NextDesk`
- **当前版本**: `1.0.99`
- **目标平台**: macOS (主要), Windows

---

## ⚠️ 关键前置依赖：IronRDP 仓库

NextDesk **必须配合一个修改过的 IronRDP 仓库**才能编译。Cargo.toml 通过相对路径 `../../IronRDP/crates/*` 引用 90+ 个 ironrdp-* crate。

### 目录结构要求

```
<父目录>/
├── IronRDP/        ← 必须存在！与 NextDesk 同级
│   └── crates/
│       ├── ironrdp/
│       ├── ironrdp-cliprdr/
│       ├── ironrdp-web/
│       └── ...
└── NextDesk/       ← 主项目（本仓库）
```

### IronRDP 来源

- **上游**: `https://github.com/Devolutions/IronRDP.git`
- **基础 commit**: `bf694c8a23` 或更新
- **本地修改**: 包含 NextDesk 专用补丁（见下文），不能直接用上游 master

### 本地修改的 crate（不可删除/不可被上游覆盖）

以下 crate 包含 NextDesk 必需的本地修改：

| Crate | 修改内容 | 用途 |
|:---|:---|:---|
| `ironrdp-cliprdr` | `pdu/format_data/file_list.rs` | CLIPRDR 文件列表 PDU 解析增强 |
| `ironrdp-connector` | `connection.rs` / `connection_activation.rs` | 连接握手补丁 |
| `ironrdp-dvc` | `client.rs` | DVC 客户端 |
| `ironrdp-rdpsnd-native` | `cpal.rs` | macOS 音频后端适配 |
| `ironrdp-rdpsnd` | `client.rs` | 音频客户端 |
| `iron-remote-desktop` | `lib.rs` / `session.rs` | WASM 高层 session API |
| `ironrdp-web` | `Cargo.toml` + `canvas.rs` / `clipboard.rs` / `image.rs` / `lib.rs` / `session.rs` + 新增 `gfx.rs` / `rdpdr.rs` / `rdpsnd.rs` | WASM 模式核心 |

### 升级上游的注意事项

如果将来要升级到上游 IronRDP 新版本：
1. 在 IronRDP 工作目录创建保护 branch：`git checkout -b nextdesk-patches`
2. 拉上游：`git fetch upstream && git checkout master && git merge upstream/master`
3. 把 `nextdesk-patches` 的修改 cherry-pick 或 rebase 到新 master
4. 重新编译 NextDesk + WASM 验证

### 新机器初次 setup

```bash
# 在父目录
cd ~/your-projects-dir/

# 1. clone 上游 IronRDP（或从你的 fork 拉取已含补丁的版本）
git clone https://github.com/Devolutions/IronRDP.git

# 2. clone NextDesk
git clone https://github.com/z0fans/NextDesk.git

# 3. 应用 NextDesk 的 IronRDP 补丁（如果有 patch 文件）
#    或直接 clone 你 fork 的 IronRDP（含补丁）

# 4. 编译
cd NextDesk && npx tauri dev
```

---

## 技术栈

| 层级 | 技术 | 版本 |
|:---|:---|:---|
| **Desktop Shell** | Tauri 2 (Rust) | `tauri = "2"` |
| **前端框架** | React 19 + TypeScript | `react@^19.2.0` |
| **构建工具** | Vite 7 | `vite@^7.2.4` |
| **样式** | Tailwind CSS v4 + ShadcnUI | `tailwindcss@^4.1.18` |
| **RDP 引擎** | IronRDP → WASM (WebGL2 + WebCodecs H.264) | 本地编译 |
| **网络引擎** | Clash Meta (Mihomo) | 外部二进制 |
| **国际化** | 自研 i18n (Context + useTranslation) | — |
| **包管理** | npm (前端), cargo (Rust) | — |

---

## 项目结构

```
NextDesk/
├── frontend/                    # React 前端 (Vite SPA)
│   ├── src/
│   │   ├── App.tsx              # 主界面 SPA (1342行, 6 个 Tab)
│   │   ├── api.ts               # Tauri invoke 桥接层
│   │   ├── main.tsx             # React 入口
│   │   ├── index.css            # 全局样式 (Tailwind v4)
│   │   ├── components/
│   │   │   ├── RdpManager.tsx   # RDP 核心组件 (107KB, 会话/输入/渲染)
│   │   │   ├── RdpSidebar.tsx   # RDP 侧边栏 (服务器列表/分组)
│   │   │   ├── RdpTabBar.tsx    # RDP 多标签栏
│   │   │   ├── RdpGridView.tsx  # RDP 网格视图
│   │   │   ├── NewConnectionDialog.tsx
│   │   │   ├── Logo.tsx
│   │   │   ├── ThemeToggle.tsx
│   │   │   ├── LanguageToggle.tsx
│   │   │   └── ui/              # ShadcnUI 基础组件
│   │   ├── i18n/                # 国际化 (中/英)
│   │   │   ├── translations.ts
│   │   │   ├── LanguageProvider.tsx
│   │   │   └── useTranslation.ts
│   │   ├── wasm/                # IronRDP WASM 产物 (wasm-pack 输出)
│   │   │   ├── ironrdp_web.js
│   │   │   ├── ironrdp_web.d.ts
│   │   │   ├── ironrdp_web_bg.js
│   │   │   ├── ironrdp_web_bg.wasm  # ~4.2MB
│   │   │   └── ironrdp_web_bg.wasm.d.ts
│   │   └── lib/
│   │       └── utils.ts         # cn() 等工具函数
│   ├── vite.config.ts
│   └── package.json
│
├── src-tauri/                   # Tauri Rust 后端
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs              # Tauri 入口
│       ├── lib.rs               # 命令注册 + Tauri setup
│       ├── rdp_proxy.rs         # RDCleanPath WebSocket 代理 (WS↔TCP)
│       ├── rdp_session.rs       # RDP 原生会话管理 (IronRDP native)
│       ├── rdp_audio.rs         # RDP 音频重定向 (RDPSND + cpal)
│       ├── frame_ws.rs          # 帧数据 WebSocket 传输
│       ├── relay.rs             # 连接中继
│       ├── tube.rs              # Tube 通道 (aggligator 多路复用)
│       ├── clash.rs             # Clash 引擎管理
│       ├── config.rs            # 配置持久化
│       ├── state.rs             # 全局状态
│       ├── subscription.rs      # 订阅解析 (多格式)
│       ├── updater.rs           # GitHub Release 自动更新
│       ├── rdpdr_backend.rs     # RDP 驱动重定向后端
│       ├── cliprdr_backend.rs   # 剪贴板重定向后端 (CLIPRDR)
│       ├── virtual_file_clipboard.rs
│       ├── virtual_clipboard_registry.rs
│       ├── windows_virtual_files.rs
│       ├── macos_file_promise.rs
│       ├── macos_item_provider.rs
│       ├── macos_pasteboard_promise.rs
│       └── macos_cursor_fix.rs  # macOS 光标显示修复
│
├── tube-server/                 # Tube 中继服务端
│
├── scripts/                     # 构建/部署脚本
├── .backend/                    # 旧版 Python 后端 (已废弃, 保留参考)
├── .assets/                     # 静态资源
├── .github/                     # GitHub Actions CI/CD
├── doc/                         # 文档
├── docs/                        # 额外文档
├── AGENTS.md                    # ← 本文件
└── RELEASE.md                   # 发布说明
```

---

## 核心架构

### 数据流

```
用户操作 → React UI (App.tsx)
  ├─ RDP 连接 (原生模式) → Tauri invoke → rdp_session.rs → IronRDP native
  │                          ↕                                    ↕
  │                    frame_ws.rs (LZ4帧)              TCP → RDP Server
  │                          ↕                          (可选 Tube 聚合)
  │                    Canvas (WebGL2)
  │
  ├─ RDP 连接 (WASM模式) → RdpManager.tsx → IronRDP WASM → WebSocket
  │                          ↕                                  ↕
  │                    Canvas (WebGL2)              rdp_proxy.rs (Tauri)
  │                                                      ↕
  │                                               TCP → RDP Server
  │
  └─ 网络加速 → Tauri invoke → clash.rs → Clash Meta 进程
                                  ↕
                          REST API (端口 17891)
```

### RDP 渲染管线

1. **原生 RDP 会话** — `rdp_session.rs` (IronRDP native, Rust 侧完整会话)
2. **帧传输** — `frame_ws.rs` (RGBA/LZ4 帧 → WebSocket → 前端)
3. **前端渲染** — Canvas WebGL2 纹理渲染 + `requestAnimationFrame`
4. **音频重定向** — `rdp_audio.rs` (RDPSND → cpal 本地播放)

### RDCleanPath 代理

`rdp_proxy.rs` 监听 **WebSocket 端口 8765**，实现：
- WASM WebSocket 请求 → 解码 RDCleanPath → TCP 连接 RDP 服务器
- X.224 握手 → TLS 握手获取证书 → 构建响应 → 原始双向转发
- 支持 SOCKS5 代理上游 (`tokio-socks`)

### Tube 多路复用

`tube.rs` + `tube-server/` 实现基于 `aggligator` 的连接聚合：
- 多条 TCP/WebSocket 链路聚合为单一逻辑连接
- 提升弱网环境下的 RDP 连接稳定性
- `tube-server/` 为独立部署的中继服务端

---

## 开发命令

```bash
# 启动开发模式 (前端 HMR + Tauri 热重载)
cd NextDesk && npx tauri dev

# 仅启动前端
cd frontend && npm run dev

# 构建生产包
npx tauri build

# 编译 IronRDP WASM (在 IronRDP 仓库中)
export PATH="$HOME/.cargo/bin:$PATH"
rustup default 1.89.0
wasm-pack build --target web crates/ironrdp-web
# 然后复制产物到 frontend/src/wasm/
```

### 端口约定

| 端口 | 用途 |
|:---|:---|
| 5173 | Vite 开发服务器 |
| 8765 | RDCleanPath WebSocket 代理 |
| 17891 | 内置 Clash API |
| 17897 | 内置 Clash SOCKS5 代理 |
| 9090/9097 | 外部 Clash 实例检测 (复用模式) |

---

## 编码规范

### 通用规则

- **语言**: 代码注释和变量命名用**英文**；用户可见文本必须经过 `i18n` (`t('key')`)
- **组件风格**: 函数式组件 + Hooks，不使用 class 组件
- **样式**: 使用 Tailwind CSS v4 工具类 + ShadcnUI 组件，通过 `cn()` 合并类名
- **路径别名**: `@/` 映射到 `frontend/src/`
- **状态管理**: 当前使用 `useState` + `useRef`，尚未引入全局状态管理

### 前端 (React + TypeScript)

- **框架**: React 19 函数式组件，严禁 class 组件
- **构建**: Vite 7, 配置于 `frontend/vite.config.ts`
- **样式**: Tailwind CSS v4 (通过 `@tailwindcss/vite` 插件)，不使用传统 `tailwind.config.js`
- **组件库**: ShadcnUI 组件位于 `frontend/src/components/ui/`
- **工具函数**: `cn()` 函数 (`frontend/src/lib/utils.ts`) 封装 `clsx` + `tailwind-merge`
- **路径别名**: `@/` → `frontend/src/` (在 `vite.config.ts` 和 `tsconfig.app.json` 中配置)
- **WASM 支持**: `vite-plugin-wasm` + `vite-plugin-top-level-await` (devDependencies 中可用，按需在 vite.config.ts 中启用)
- **国际化**: 所有用户可见文本必须走 `t('key')` (`useTranslation` hook)
  - 翻译文件: `frontend/src/i18n/translations.ts` (中/英双语)
  - 新增 UI 文本时必须同时添加中英两种翻译
- **Tauri API 桥接**: 所有后端调用通过 `frontend/src/api.ts` 中的 `api` 对象，封装 `@tauri-apps/api` 的 `invoke()`

### 后端 (Rust / Tauri 2)

- **异步运行时**: Tauri 内置 tokio，禁止在 Tauri 上下文中再创建 `tokio::runtime::Runtime`
- **后台任务**: 使用 `tauri::async_runtime::spawn()` 而非裸 `tokio::spawn()`
- **命令注册**: 所有 `#[tauri::command]` 在 `lib.rs` 中注册
- **配置持久化**: 通过 `config.rs`，存储于平台标准目录 (`dirs::config_dir()`)
- **外部进程**: Clash Meta 作为 sidecar 进程管理，通过 `clash.rs` 控制
- **跨平台**: macOS 特定代码使用 `#[cfg(target_os = "macos")]`，Windows 同理

### RDP 协议关键约束

> ⚠️ 以下约束经过反复调试验证，**严禁违反**。

1. **剪贴板 (CLIPRDR)**
   - `FormatList PDU` 只在剪贴板**内容变化时**发送，绝不在粘贴时发送
   - Ctrl+V/Ctrl+C handler 仅发 scancodes，不调用 `onClipboardPaste()`
   - 使用 focus 事件检测剪贴板变化，与 `lastSyncedText` 比较后才同步

2. **自适应分辨率**
   - `session.resize()` 不工作 — 必须 disconnect + reconnect 实现分辨率切换
   - 使用 `reconnectWithSize(w, h)` 封装断连-重连逻辑
   - ResizeObserver 防抖 800ms，最小变化阈值 20px，冷却期 2s

3. **鼠标滚轮**
   - 直接传递 DOM 的 `deltaY` + `deltaMode` 给 WASM
   - 不要转换为 notch (÷120)，不要固定 rotation=±1

4. **会话保持**
   - RDP 组件使用 CSS `hidden` 隐藏（非条件渲染），防止 Tab 切换时断连
   - Canvas 必须始终在 DOM 中

---

## 关键陷阱 & 常见错误

| 陷阱 | 正确做法 |
|:---|:---|
| Tauri 中 `tokio::runtime::Runtime::new().block_on()` 死锁 | 用 `std::net::TcpStream` 做同步探测，或 `tauri::async_runtime` |
| Clash API 路径中空格编码 | 使用 `urlencoding::encode()`，不用 `+` 编码 |
| WASM import 路径 | WASM 文件必须放在 `src/` 目录下，Vite 不允许 `import()` 引入 `/public` 中的 JS |
| Canvas 渲染黑边 | Canvas 使用 `w-full h-full`，不要用 `object-contain` |
| 前端 `onClipboardPaste()` 滥用 | 只在剪贴板**内容变化**时调用，Ctrl+V 时绝不调用 |
| `session.resize()` 不生效 | 必须 disconnect + reconnect 切换分辨率 |
| Adaptive resize 重连循环 | 使用 `resizeCooldownRef` 2s 冷却期 + `userDisconnectedRef` 标记 |

---

## IronRDP WASM 编译

```bash
# 前置条件
export PATH="$HOME/.cargo/bin:$PATH"
rustup default 1.89.0  # 必须用 rustup 管理的 rustc 1.89.0

# 在 IronRDP 仓库根目录执行
wasm-pack build --target web crates/ironrdp-web

# 复制产物到 NextDesk
cp -r pkg/* /path/to/NextDesk/frontend/src/wasm/
```

- **注意**: Homebrew 安装的 rustc 版本可能不够，必须用 rustup
- **WASM 大小**: `ironrdp_web_bg.wasm` 约 4.2MB
- **依赖本地 crate**: `Cargo.toml` 中 `ironrdp-rdcleanpath` 使用 `path` 引用

---

## 已废弃的组件

- `.backend/` — 旧版 Python + Pywebview 后端，已完全迁移到 Tauri 2 + Rust
- `.开发.md` — 旧版开发文档，描述的是 Python 后端时代的架构，已由本文件替代
