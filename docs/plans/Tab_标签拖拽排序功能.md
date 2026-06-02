# Tab 标签拖拽排序功能

用户希望顶部 Tab 栏中的服务器标签可以通过拖拽来自定义排序。

## 修改方案

### Store 层

#### [MODIFY] [useSessionStore.ts](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/lib/useSessionStore.ts)

- 新增 `reorderTabs(fromIndex, toIndex)` 方法，将 tab 从 `fromIndex` 移动到 `toIndex` 位置
- 导出该方法供组件使用

---

### 组件层

#### [MODIFY] [RdpTabBar.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/components/RdpTabBar.tsx)

- Props 中增加 `onReorderTabs: (fromIndex: number, toIndex: number) => void`
- 用 `useState` 记录 `dragIndex`（当前拖拽项）和 `hoverIndex`（悬停目标项）
- 给每个 tab div 添加原生 HTML5 拖拽属性：
  - `draggable`、`onDragStart`、`onDragOver`、`onDragEnd`、`onDrop`
- 拖拽时给 hoverIndex 所在 tab 添加视觉指示（左/右边框高亮）
- 拖拽中给源 tab 添加半透明效果

---

### 调用层

#### [MODIFY] [App.tsx](file:///Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend/src/App.tsx)

- 将 `store.reorderTabs` 传递给 `RdpTabBar` 组件的 `onReorderTabs` props

## 验证计划

### 手动验证
1. 运行 `npx tauri dev`
2. 添加 2-3 个服务器并连接，产生多个 tab
3. 拖拽一个 tab 到另一个位置，确认顺序改变
4. 确认拖拽时有视觉指示（高亮边框 + 源 tab 半透明）
5. 确认松开后 tab 顺序正确更新
6. 确认点击、关闭和视图切换功能不受影响
