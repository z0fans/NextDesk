# NextDesk 版本发布流程

## 发布前检查

- [ ] 所有功能已完成并测试
- [ ] 前端代码无 TypeScript 错误
- [ ] 后端代码可正常运行

## 发布步骤

### 1. 确定新版本号

查看当前最新 tag：
```bash
git tag --sort=-v:refname | head -5
```

新版本号 = 最新版本号 + 1（如 v1.0.67 → v1.0.68）

### 2. 更新版本号常量

编辑 `backend/core/updater.py`，修改 `CURRENT_VERSION`：

```python
CURRENT_VERSION = "1.0.68"  # 改为新版本号
```

### 3. 构建前端

```bash
cd frontend && npm run build
```

确认构建成功，无报错。

### 4. 提交代码

```bash
git add -A
git commit -m "release: v1.0.68"
```

提交信息格式：`release: vX.X.X`

### 5. 推送代码和 Tag

```bash
git push origin main
git tag v1.0.68
git push origin v1.0.68
```

### 6. 验证发布

1. 访问 GitHub Releases 页面确认 Action 触发
2. 等待构建完成，下载安装包测试
3. 检查应用内版本号显示正确
4. 检查更新检测功能正常

## 快速命令（一键发布）

替换 `X.X.X` 为新版本号：

```bash
# 完整流程
cd frontend && npm run build && cd .. && \
git add -A && \
git commit -m "release: vX.X.X" && \
git push origin main && \
git tag vX.X.X && \
git push origin vX.X.X
```

## 常见问题

### 更新后仍提示有新版本

**原因：** `CURRENT_VERSION` 未更新

**解决：** 重新发布，确保步骤 2 已执行

### 需要重新发布同一版本

删除并重建 tag：
```bash
git tag -d vX.X.X
git push origin :refs/tags/vX.X.X
git tag vX.X.X
git push origin vX.X.X
```

### GitHub Action 构建失败

1. 检查 GitHub Actions 日志
2. 本地测试 `pyinstaller build.spec`
3. 确认所有依赖已在 `requirements.txt` 中

## 版本号规范

格式：`v主版本.次版本.修订号`

- **主版本**：重大架构变更
- **次版本**：新功能
- **修订号**：Bug 修复、小改动（日常迭代）

当前阶段建议只递增修订号。
