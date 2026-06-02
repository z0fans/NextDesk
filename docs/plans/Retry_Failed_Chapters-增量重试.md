# Retry Failed Chapters：增量重试

## 目标

点击 "Retry Failed Chapters" 只从**第一个失败步骤**开始重新执行，跳过已成功的步骤。

## 数据依赖分析

| 步骤 | 需要的数据 | 可从 DB 获取？ |
|------|----------|:---:|
| 6 auto-provision | `recoveryPair` (id/domain) | ✅ 从 `select-candidate` trace 的 detail 或 DB pairs 表 |
| 7 switch-active | `recoveryPair.id` | ✅ |
| 8 publish-runtime | `profileId` | ✅ |

> [!NOTE]
> 最常见的失败场景是步骤 6（provisioning 失败），此时步骤 1-5 的检测结果不需要重跑。

## 方案

### 服务端

#### [MODIFY] [domain-guard.ts](file:///Users/yuu/Downloads/vibe_coding/dashboard/src/app/actions/domain-guard.ts)

1. `runDomainGuardActivePairCheck` 添加 `resumeFromStepId?: DomainGuardDetectionStepId` 参数
2. 添加 `previousRunId?: number` 参数，用于从上次 run 中恢复 trace 数据
3. 当 `resumeFromStepId` 指定时：
   - 从 DB 加载 `previousRunId` 的 `detection_trace_json`
   - 对 `resumeFromStepId` 之前的步骤，直接复制上次 trace 并标记 `(resumed)`
   - 从 `resumeFromStepId` 开始正常执行
   - `activePair`、`recoveryPair` 等数据从 DB 重新查询（而非依赖上次 check 结果）

### 客户端

#### [MODIFY] [page.tsx](file:///Users/yuu/Downloads/vibe_coding/dashboard/src/app/domain-guard/page.tsx)

1. `handleRetryFailedDetectionChapters` 传入 `resumeFromStepId` = 第一个失败步骤的 id
2. 传入 `previousRunId` = 当前 latestDetectionTrace 的 runId

## Verification

- 制造 step 6 失败场景 → 点击 Retry → 确认只从 step 6 开始执行
- 步骤 1-5 应显示 "(resumed)" 标记，不重新执行
