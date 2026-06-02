# MITI 页面精简：低频设置移入 Settings 弹窗

将 MITM Console 主页聚焦于 Configurations 列表操作（增删启停/Quick Update），把 Runtime Paths、Service Templates、Runtime Summary 三个低频区块收进一个 Settings Dialog。

## Proposed Changes

### MITI Page

#### [MODIFY] [page.tsx](file:///Users/yuu/Downloads/vibe_coding/dashboard/src/app/miti/page.tsx)

1. **页头**：在 "New Config" 按钮左侧新增齿轮图标按钮，点击打开 Settings Dialog
2. **删除主页 3 个区块**：Runtime Paths (L577-648)、Runtime Summary 卡片 (L650-668)、Service Templates (L670-764)
3. **新增 Settings Dialog**：包含 Runtime Paths 表单 + Service Templates 编辑器（原样搬入），所有状态和 handler 保持不变

## Verification Plan

### Manual Verification
1. 打开 `http://localhost:3000/miti`，确认主页只显示 Configurations 列表 + 页头按钮
2. 点击齿轮按钮，确认 Settings 弹窗正常打开
3. 在弹窗内修改路径 → 保存，确认反馈正常
4. 切换 Netflix/Disney+ 模板 → 编辑 → 保存，确认正常
