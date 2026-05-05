# Txpuro 主站导流入口方案

Last updated: 2026-05-05

这份文档配合当前已经上线的 `https://txpuro.com/guides` 使用，目标是：

- 主站继续承担产品介绍与转化
- `guides` 承接 GEO 长尾问题、政策解释、对比页与 FAQ
- 所有内容阅读最终回流到主站咨询、试用或 Demo

## 1. 建议放入口的位置

### 首页 Hero 区

- 主按钮：继续保留产品站原有 CTA
- 次按钮：新增 `查看实施指南`
- 跳转：`https://txpuro.com/guides`

建议文案：

- 中文：`查看实施指南`
- 英文：`Explore guides`

### 首页功能区下方

新增一个资源入口带，展示 3 个高意图页面：

- `https://txpuro.com/guides/what-is-myinvois`
- `https://txpuro.com/guides/malaysia-einvoice-implementation-timeline`
- `https://txpuro.com/guides/compare/txpuro-vs-myinvois-portal`

建议标题：

- 中文：`开始实施前，先看这三页`
- 英文：`Read these before rollout`

### 产品页 / 价格页

在 `pricing`、`features`、`contact` 页面下半部分增加“决策资料”入口：

- `Txpuro vs MyInvois Portal`
- `Txpuro vs 人工流程`
- `FAQ`

### 页脚

在 footer 新增 `Resources` / `指南中心`：

- 指南首页
- FAQ
- 时间线
- MyInvois 说明
- 比较页

## 2. 推荐的主站导流文案

### Hero 次按钮

- 中文：`查看实施指南`
- 英文：`Explore guides`

### 资源区标题

- 中文：`从政策理解到系统选型，一次看清`
- 英文：`From policy understanding to rollout decisions`

### 卡片文案

#### 什么是 MyInvois

- 中文：`先理解官方系统角色，再决定是否需要第三方系统。`
- 英文：`Understand the role of the official portal before choosing software.`

#### 实施时间线

- 中文：`快速判断你的企业何时需要完成电子发票准备。`
- 英文：`Check when your business needs to be ready.`

#### Txpuro vs MyInvois Portal

- 中文：`判断 portal 是否够用，还是已经需要业务系统支持。`
- 英文：`See whether the portal is enough or a business system is now required.`

## 3. 第一批优先导流的 10 个页面

1. `https://txpuro.com/guides`
2. `https://txpuro.com/guides/what-is-myinvois`
3. `https://txpuro.com/guides/malaysia-einvoice-implementation-timeline`
4. `https://txpuro.com/guides/how-to-start-einvoice-for-sme`
5. `https://txpuro.com/guides/features/myinvois-integration`
6. `https://txpuro.com/guides/features/api-integration`
7. `https://txpuro.com/guides/faq`
8. `https://txpuro.com/guides/compare/txpuro-vs-myinvois-portal`
9. `https://txpuro.com/guides/compare/txpuro-vs-manual-process`
10. `https://txpuro.com/guides/pricing`

## 4. 埋点建议

主站到 guides 的入口建议统一带参数，方便后续看导流：

```text
?utm_source=txpuro-main-site&utm_medium=internal&utm_campaign=guides-launch
```

示例：

```text
https://txpuro.com/guides?utm_source=txpuro-main-site&utm_medium=internal&utm_campaign=guides-launch
```

## 5. 当前状态

- `guides` 已由当前 GEO 系统承载
- `llms.txt` 已上线：`https://txpuro.com/llms.txt`
- `sitemap-guides.xml` 已上线：`https://txpuro.com/sitemap-guides.xml`
- 主站入口文案与组件还需要在你们现有主站系统中单独补上
