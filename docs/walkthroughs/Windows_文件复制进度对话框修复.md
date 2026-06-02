# Windows 文件复制进度对话框修复

## 问题

NextDesk 在 RDP 会话中复制大文件到 Windows 时，Windows 不显示文件复制进度对话框（Jump Desktop 可以正常显示）。

## 根因

根据 [MS-RDPECLIP 规范](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpeclip/) 和 [FILEDESCRIPTOR 结构体](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/ns-shlobj_core-filedescriptora)：

- `FD_PROGRESSUI` (0x4000) 标志位告知 Windows Explorer 在拖放/粘贴操作期间显示进度指示器
- ironrdp 的 `ClipboardFileFlags` 缺少此标志位定义
- `FileDescriptor` 结构体无法设置额外 flags

## 修改内容

### 1. [file_list.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-cliprdr/src/pdu/format_data/file_list.rs)

- 在 `ClipboardFileFlags` bitflags 中添加 `PROGRESS_UI` (0x4000) 和 `LINK_UI` (0x8000)
- 在 `FileDescriptor` 中添加 `extra_flags: ClipboardFileFlags` 字段
- 更新 `Encode`/`Decode` 实现

### 2. [clipboard.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-web/src/clipboard.rs)

- 构建 `FileDescriptor` 时设置 `extra_flags: ClipboardFileFlags::PROGRESS_UI`

### 3. [mod.rs](file:///Users/yuu/Downloads/vibe_coding/rdp_project/IronRDP/crates/ironrdp-testsuite-core/tests/clipboard/mod.rs)

- 更新测试期望值以包含新的 `extra_flags` 字段

## 验证

- ✅ `cargo check` 通过（Tauri app + 所有依赖 crate）
- ⏳ 需要手动测试：运行 `npx tauri dev`，连接 RDP，复制大文件验证进度对话框
