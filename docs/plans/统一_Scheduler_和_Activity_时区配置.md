# 统一 Scheduler 和 Activity 时区配置

## 问题

- **Scheduler** (`scheduler.ts`) 使用 `config.timezone`（默认 `'local'`），根据该时区取 hour 来匹配行为链
- **Activity** (`session.ts`) 硬编码调用 `getUSHour()` 取 US Pacific 时间，重新匹配行为链
- 结果：两个模块可能选择不同的行为链（日志中 `lunch-break` vs `evening-entertainment`）

## 方案

**将 timezone 从 Scheduler 传递到 SmartActivityExecutor，统一使用同一时区。**

## 修改文件

---

### Behavior 模块

#### [MODIFY] [session.ts](file:///Users/yuu/Downloads/vibe_coding/aycd/aycd-project/src/bot-engine/behavior/session.ts)

1. `SmartActivityConfig` 接口添加 `timezone?: AppTimezone` 字段
2. `generateActionSequence()` 方法：将 `getUSHour()` 替换为 `getHour(this.config.timezone)`
3. 日志输出：将 `formatUSTime()` 替换为 `formatTime(this.config.timezone)`
4. 导入 `AppTimezone`, `getHour`, `formatTime` 替换 `getUSHour`, `formatUSTime`

#### [MODIFY] [scheduler.ts](file:///Users/yuu/Downloads/vibe_coding/aycd/aycd-project/src/bot-engine/behavior/scheduler.ts)

1. `runSession()` 方法：构造 `SmartActivityConfig` 时传入 `timezone: this.config.timezone`

---

### 影响分析

- `timezone.ts` — **无需修改**，已有 `getHour(timezone)` 和 `formatTime(timezone)` 通用函数
- `index.ts` — **无需修改**，已通过 `ContinuousSchedulerConfig.timezone` 向 Scheduler 传递时区配置
- `chains.ts` / `profiles.ts` — **无需修改**

## 验证计划

### 构建验证

```bash
cd /Users/yuu/Downloads/vibe_coding/aycd/aycd-project && npx tsc --noEmit 2>&1 | head -30
```

### 现有单元测试

```bash
cd /Users/yuu/Downloads/vibe_coding/aycd/aycd-project && npx vitest run 2>&1 | head -30
```

### 日志验证（手动）

启动任务后观察日志，确认 Scheduler 和 Activity 引擎输出的时间和匹配的行为链**一致**：
- `[Scheduler] Found matching chain: xxx` 和 `Using time-based chain: xxx` 应相同
- `[Scheduler] Time:` 和 `Current ... time:` 应显示相同时区的时间
