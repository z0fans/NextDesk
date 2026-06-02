# 支持独立 Embedding 配置 + 搭建本地环境

用户代理 `127.0.0.1:8317` 只有 gpt-5.4 聊天模型，没有 embedding 模型。当前代码 LLM 和 Embedding 共用 `OPENAI_API_KEY/OPENAI_BASE_URL`，需要支持分开配置。

## Proposed Changes

### 后端代码修改

#### [MODIFY] [zep_graphiti_impl.py](file:///Users/yuu/Downloads/vibe_coding/MiroFish/backend/app/services/zep_graphiti_impl.py)

修改 `_build_default_embedder` 方法（~第290行），增加对独立环境变量的支持：
- 新增 `GRAPHITI_EMBEDDING_API_KEY`：Embedding 服务的 API Key
- 新增 `GRAPHITI_EMBEDDING_BASE_URL`：Embedding 服务的 Base URL
- 优先使用独立变量，回退到 `OPENAI_*` 变量

---

#### [MODIFY] [.env](file:///Users/yuu/Downloads/vibe_coding/MiroFish/.env)

更新完整配置：

```env
# LLM — 用户代理
LLM_API_KEY=sk-DHYERzuh6vQ9478zw
LLM_BASE_URL=http://127.0.0.1:8317/v1
LLM_MODEL_NAME=gpt-5.4

# 后端模式 — 本地 graphiti
ZEP_BACKEND=graphiti

# Neo4j — 默认值
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=password

# Graphiti Embedding — 用阿里百炼 DashScope（免费额度）
GRAPHITI_EMBEDDING_API_KEY=<用户的 DashScope API Key>
GRAPHITI_EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
GRAPHITI_EMBEDDING_MODEL=text-embedding-v4
```

### 环境搭建

1. 启动 Neo4j Docker
2. 安装依赖 `npm run setup:all`
3. 创建模拟环境
4. 启动服务 `npm run dev`

## Verification Plan

### Manual Verification
1. 启动服务后访问 `http://localhost:3000` 确认前端加载
2. 查看后端日志确认 Graphiti 初始化无报错
