# RDP 原生音频后端 (cpal) 跨平台升级 Implementation Plan

> **For Antigravity:** REQUIRED WORKFLOW: Use `.agent/workflows/execute-plan.md` to execute this plan in single-flow mode.

**Goal:** 将 RDP 音频从 WebAudio 前端播放迁移到 Rust cpal 原生后端，支持 macOS 和 Windows 双平台。

**Architecture:** 采用方案 A — WASM rdpsnd 仍在前端解码，通过 `invoke('rdp_audio_push')` 将 PCM 数据发到 Rust 后端，由 `ironrdp-rdpsnd-native` 的 cpal 引擎直接输出到系统音频设备。

**Tech Stack:** cpal 0.17 · ironrdp-rdpsnd-native · Tauri 2 invoke · tokio channels

---

## 方案分析：跨平台兼容性评估

### ✅ cpal 0.17 平台支持

| 平台 | 音频后端 | 状态 |
|:---|:---|:---|
| **macOS** | CoreAudio | ✅ 原生支持 |
| **Windows** | WASAPI | ✅ 原生支持 |
| **Linux** | ALSA/PulseAudio/JACK | ✅ 支持（非目标） |

> [!NOTE]
> `cpal` 是 Rust 生态最成熟的跨平台音频库，macOS 用 CoreAudio、Windows 用 WASAPI，编译时自动选择后端，无需条件编译。

### ✅ opus2 平台支持

`opus2 = "0.3"` 带 `bundled` feature 会自动编译 libopus C 源码，macOS/Windows 均可编译。

### ⚠️ 当前方案的限制

原方案评估中已指出：**RDP 会话仍在 WASM 中运行**，音频数据必须经过前端中转：

```
WASM rdpsnd.wave() → JS callback → Tauri invoke → Rust cpal
```

这有约 5-15ms IPC 延迟，但相比 WebAudio 的节流/自动播放问题，已是显著改善。

---

## User Review Required

> [!IMPORTANT]
> **方案选择**：本计划实施 **方案 A（WASM→invoke→cpal）**，保持 WASM RDP 会话不变，仅替换音频播放端。
> 方案 C（整个 RDP 会话迁移到 Rust）是更理想的长期目标，但工作量极大，不在本计划范围。

> [!WARNING]
> **依赖引入**：需在 `Cargo.toml` 新增 `cpal = "0.17"` 和 `opus2 = "0.3"`。
> macOS 无额外系统依赖；Windows 需要 WASAPI（Win7+ 自带）。
> 编译时间会因 opus2 bundled 编译增加约 30-60s。

---

## Proposed Changes

### Task 1: Rust 后端 — 音频管理模块

新建 `src-tauri/src/rdp_audio.rs`，封装 per-session 的 cpal 音频播放器。

#### [NEW] [rdp_audio.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri/src/rdp_audio.rs)

核心结构：

```rust
// 每个 RDP 会话的音频播放实例
pub struct SessionAudioPlayer {
    tx: mpsc::Sender<AudioCommand>,
    _thread: JoinHandle<()>,
}

enum AudioCommand {
    SetFormat { channels: u16, sample_rate: u32, bits_per_sample: u16, format_tag: String },
    PushPcm(Vec<u8>),
    SetVolume { left: u32, right: u32 },
    Close,
}
```

- 内部启动独立线程，持有 `cpal::Stream`
- `SetFormat` 时创建/重建 `cpal::Stream`
- `PushPcm` 时通过 mpsc channel 将 PCM 数据送入 cpal 回调
- 支持 PCM 8/16bit + ALAW/MULAW（预解码为 PCM 后入队）
- **不依赖** `ironrdp-rdpsnd-native`（避免引入整个 crate，仅复用其 cpal+RxBuffer 模式）

**Files:**
- Create: `src-tauri/src/rdp_audio.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod rdp_audio;`)

---

### Task 2: Tauri 命令注册 — 音频 IPC 接口

在 `lib.rs` 中添加 3 个新 Tauri command + 全局 AudioManager 状态。

#### [MODIFY] [lib.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri/src/lib.rs)

```rust
// AppState 新增字段
pub audio_manager: Mutex<HashMap<String, rdp_audio::SessionAudioPlayer>>,
```

新增 3 个 Tauri command：

```rust
#[tauri::command]
fn rdp_audio_set_format(tab_id: String, channels: u16, sample_rate: u32,
    bits_per_sample: u16, format_tag: String, app_state: State<'_, AppState>)
    -> Result<(), String>

#[tauri::command]
fn rdp_audio_push(tab_id: String, pcm: Vec<u8>,
    app_state: State<'_, AppState>) -> Result<(), String>

#[tauri::command]
fn rdp_audio_close(tab_id: String,
    app_state: State<'_, AppState>) -> Result<(), String>
```

注册到 `.invoke_handler(tauri::generate_handler![...])` 中。

---

### Task 3: Cargo.toml — 新增 cpal 依赖

#### [MODIFY] [Cargo.toml](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri/Cargo.toml)

```diff
+cpal = "0.17"
```

> [!NOTE]
> **暂不引入 opus2**。当前 WASM rdpsnd 只通告 PCM/ALAW/MULAW 格式（不含 Opus），
> 服务端会选择 PCM。后续如需 Opus 支持，可通过 feature flag 添加。

---

### Task 4: 前端改造 — invoke 替代 WebAudio

修改 WASM rdpsnd 回调，将音频数据通过 Tauri invoke 转发到 Rust 后端。

#### [MODIFY] [RdpManager.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpManager.tsx)

替换 L1156-1165 的音频初始化代码：

```typescript
// 旧代码: WebAudio 播放
const audioPlayer = new RdpAudioPlayer();
audioPlayersRef.current.set(tabId, audioPlayer);
const rawCb = audioPlayer.createCallback();
builder.extension(new wasm.Extension('audio_callback', wrappedAudioCb));

// 新代码: Tauri invoke 转发
const audioCallback = (type: string, data: any) => {
  switch (type) {
    case 'format':
      invoke('rdp_audio_set_format', {
        tabId, channels: data.channels,
        sampleRate: data.sampleRate,
        bitsPerSample: data.bitsPerSample,
        formatTag: data.formatTag,
      }).catch(e => rdpLog.error('audio', 'set_format failed', e));
      break;
    case 'wave':
      // data is Uint8Array, invoke will serialize as Vec<u8>
      invoke('rdp_audio_push', {
        tabId, pcm: Array.from(data),
      }).catch(() => {}); // fire-and-forget for low latency
      break;
    case 'close':
      invoke('rdp_audio_close', { tabId }).catch(() => {});
      break;
  }
};
builder.extension(new wasm.Extension('audio_callback', audioCallback));
```

同时修改断连清理代码（L1411-1415），改为调用 `invoke('rdp_audio_close')` 替代 `audioPlayer.destroy()`。

#### [MODIFY] [api.ts](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/api.ts)

添加新的 API 函数（可选，也可直接在 RdpManager 中 invoke）：

```typescript
rdpAudioSetFormat: (tabId: string, ...) => invoke('rdp_audio_set_format', {...}),
rdpAudioPush: (tabId: string, pcm: number[]) => invoke('rdp_audio_push', {tabId, pcm}),
rdpAudioClose: (tabId: string) => invoke('rdp_audio_close', {tabId}),
```

---

### Task 5: 清理遗留 WebAudio 代码

完成方案 A 验证后，清理不再需要的前端代码。

#### [DELETE] `frontend/src/lib/rdp-audio.ts`（231行 WebAudio 播放器）
#### [DELETE] `frontend/src/test/rdp-audio.test.ts`（351行测试）
#### [DELETE] `frontend/src/test/mocks/web-audio-mock.ts`

#### [MODIFY] [RdpManager.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpManager.tsx)

- 移除 `import { RdpAudioPlayer }` (L15)
- 移除 `audioPlayersRef` (L397)

---

## Verification Plan

### 自动化测试

1. **Rust 编译验证（macOS + Windows）**
   ```bash
   cd NextDesk && cargo build 2>&1 | tail -20
   ```
   - macOS: 验证 CoreAudio 后端编译通过
   - Windows: 验证 WASAPI 后端编译通过（需在 Windows 机器执行）

2. **前端构建验证**
   ```bash
   cd frontend && npm run build 2>&1 | tail -10
   ```

### 手动验证

3. **端到端音频测试**
   - 启动 `npx tauri dev`
   - 连接一台 Windows RDP 服务器
   - 在远程桌面打开浏览器播放 YouTube 视频
   - **预期**: 本地听到远程音频，无明显延迟（< 100ms 可感知），无爆音
   - **观察 Rust 日志**: 终端应出现 cpal stream 创建日志

4. **多会话隔离测试**
   - 同时连接 2 个 RDP 会话
   - 分别在两个远程桌面播放不同音频
   - **预期**: 两路音频独立播放，断开一个不影响另一个

5. **Windows 平台测试**
   - 在 Windows 开发机上 `cargo tauri dev`
   - 同样连接 RDP 并播放音频
   - **预期**: WASAPI 后端正常工作，音频正常输出

> [!TIP]
> 如果你没有 Windows 开发环境，Task 1-4 可在 macOS 完成开发和验证。
> Windows 编译验证可通过 CI 或借助远程 Windows 机器（如 192.168.3.249）。
