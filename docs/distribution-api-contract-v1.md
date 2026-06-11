# Distribution API 契约 v1

Last updated: 2026-06-11

## 1. 目标

这份文档定义当前系统与外部分发系统之间的接口契约。

边界非常明确：

- 当前系统负责生成主内容、源站链接、渠道版本和导出包
- 外部分发系统负责账号、平台、排期、发布和回传结果

这份 API 契约的目标是：

- 让外部分发系统可以稳定地拉取内容
- 让状态回传标准化
- 让双方幂等、可重试、可追踪

## 2. 契约原则

### 2.1 源站优先

所有导出包都应该尽量包含：

- `canonicalUrl`
- `publishedPath`
- `sourceUrl`

外部分发系统不是内容主存储，只是下游投放执行者。

### 2.2 幂等优先

所有写接口都要支持：

- 幂等键
- 重试
- 重复回调安全

### 2.3 当前只定义“系统对系统”接口

不定义：

- OAuth
- 平台账号连接
- 平台发帖 API 细节

这些属于外部分发系统自己的责任。

## 3. 统一对象

## 3.1 ExportPackage

外部分发系统看到的核心对象应是 `ExportPackage`。

建议响应结构：

```json
{
  "id": "pkg_123",
  "contentAssetId": "asset_123",
  "version": 1,
  "language": "zh-CN",
  "status": "ready",
  "packageType": "guide",
  "title": "Malaysia e-Invoice deadline | Txpuro trend response",
  "summary": "Trend-driven content draft...",
  "body": "Full article body...",
  "canonicalUrl": "https://txpuro.com/guides/trend/topic_123",
  "publishedPath": "/guides/trend/topic_123",
  "sourceUrl": "https://txpuro.com/guides/trend/topic_123",
  "geoScore": 78,
  "seoScore": 74,
  "targetKeywords": ["Malaysia e-Invoice", "LHDN e-Invoice deadline"],
  "tags": ["einvoice", "sme", "malaysia"],
  "recommendedPlatforms": ["LinkedIn", "WeChat", "Xiaohongshu"],
  "variants": {
    "LinkedIn": {
      "copy": "....",
      "mediaAssets": []
    },
    "WeChat": {
      "copy": "....",
      "mediaAssets": []
    }
  },
  "videoScript": null,
  "faq": [],
  "riskNotes": [],
  "sourceCitations": [],
  "createdAt": "2026-06-11T10:00:00.000Z",
  "updatedAt": "2026-06-11T10:05:00.000Z"
}
```

## 4. API 列表

### 4.1 `GET /api/export-packages`

用途：

- 拉取可分发内容包列表

请求参数：

- `status`：可选，默认 `ready`
- `platform`：可选
- `language`：可选
- `cursor`：可选
- `limit`：可选，默认 `20`，最大 `100`

响应：

```json
{
  "items": [
    {
      "id": "pkg_123",
      "contentAssetId": "asset_123",
      "title": "....",
      "summary": "....",
      "status": "ready",
      "canonicalUrl": "https://txpuro.com/guides/trend/topic_123",
      "recommendedPlatforms": ["LinkedIn", "WeChat"],
      "updatedAt": "2026-06-11T10:05:00.000Z"
    }
  ],
  "nextCursor": "pkg_456",
  "hasMore": true
}
```

状态码：

- `200`
- `503`：数据库或服务暂不可用

### 4.2 `GET /api/export-packages/:id`

用途：

- 获取单个导出包完整内容

响应：

- `200`
- `404`
- `503`

### 4.3 `POST /api/export-packages/:id/claim`

用途：

- 外部分发系统声明“我已接收这个包，准备处理”

请求头：

- `x-idempotency-key: <uuid>`

请求体：

```json
{
  "consumer": "distribution-core",
  "platforms": ["LinkedIn", "WeChat"],
  "note": "claimed for morning batch"
}
```

响应：

```json
{
  "id": "pkg_123",
  "status": "claimed",
  "claimedAt": "2026-06-11T10:10:00.000Z"
}
```

说明：

- 同一个幂等键重复提交，应返回同一语义结果
- claim 不代表已经发出，只代表“这个包被某个下游系统接单了”

### 4.4 `POST /api/distribution-status`

用途：

- 外部分发系统回传发布状态

请求头：

- `x-idempotency-key: <uuid>`

请求体：

```json
{
  "exportPackageId": "pkg_123",
  "contentAssetId": "asset_123",
  "platform": "LinkedIn",
  "accountId": "company-page-1",
  "status": "published",
  "publishedUrl": "https://www.linkedin.com/posts/....",
  "externalPostId": "ln_987",
  "publishedAt": "2026-06-11T10:20:00.000Z",
  "errorMessage": null,
  "metrics": {
    "impressions": 0,
    "clicks": 0,
    "shares": 0
  }
}
```

状态说明：

- `accepted`
- `scheduled`
- `published`
- `failed`
- `deleted`

响应：

```json
{
  "ok": true,
  "dispatchId": "dispatch_123"
}
```

### 4.5 `POST /api/content/variants/:id/metrics`

用途：

- 写入单个平台版本的最新表现指标

这条接口当前已经存在，建议继续保留，用于：

- 周期性指标回流
- 简单平台表现同步

## 5. 鉴权建议

外部分发系统不应该复用后台 Basic Auth。

建议为系统对系统接口单独使用：

- `Authorization: Bearer <distribution-api-token>`

或：

- HMAC 签名

建议环境变量：

- `DISTRIBUTION_API_TOKEN`

下一阶段建议：

- 为 `GET /api/export-packages*`
- `POST /api/export-packages/:id/claim`
- `POST /api/distribution-status`

统一加 token 鉴权。

## 6. 幂等要求

## 6.1 读取接口

- GET 接口天然幂等

## 6.2 写入接口

以下接口强制要求幂等键：

- `POST /api/export-packages/:id/claim`
- `POST /api/distribution-status`

建议规则：

- 同一个 `x-idempotency-key` 重试时不重复创建记录
- 如果 body 不一致，应返回 `409`

## 7. 错误模型

统一错误结构建议：

```json
{
  "error": "Human-readable error message",
  "code": "EXPORT_PACKAGE_NOT_FOUND",
  "detail": null,
  "requestId": "req_123"
}
```

常见错误码：

- `BAD_REQUEST`
- `UNAUTHORIZED`
- `FORBIDDEN`
- `EXPORT_PACKAGE_NOT_FOUND`
- `CONTENT_ASSET_NOT_FOUND`
- `IDEMPOTENCY_CONFLICT`
- `DEPENDENCY_UNAVAILABLE`
- `INTERNAL_ERROR`

## 8. 与当前现有接口的关系

当前系统已经有：

- `GET /api/content/packages`
- `GET /api/content/packages/:id`
- `POST /api/content/variants/:id/metrics`

建议关系如下：

- `content/packages` 视为当前内部过渡接口
- `export-packages` 作为下一阶段正式对外接口

换句话说：

- 当前可继续使用 `content/packages`
- 下一阶段开始新接口标准化时，外部分发系统优先对接 `export-packages`

## 9. 版本策略

建议第一阶段先不做 `/v1/` 路径分版，而是：

- 用文档版本管理契约
- 重大 breaking change 再引入 `/api/v1/...`

当满足以下任一条件时，升级为真正 API versioning：

- 有多个下游系统并行接入
- 字段结构要发生 breaking change
- 多语言、多品牌、多租户需要稳定兼容

## 10. 推荐实现顺序

### 第一步

基于现有 `content/packages` 完成内部打包结构统一。

### 第二步

新增正式 `ExportPackage` 模型与 `/api/export-packages*`。

### 第三步

新增 `DistributionDispatch` 与 `/api/distribution-status`。

### 第四步

补 token 鉴权、幂等键、审计日志。

## 11. 一句话结论

Distribution API v1 的核心不是“帮你发出去”，而是：

> 让外部分发系统拿到稳定、可追踪、可重试、带 canonical URL 的标准内容包。
