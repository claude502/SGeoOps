const KEYWORD_BLACKLIST = [
  "政变",
  "暴动",
  "恐袭",
  "群体事件",
  "政治",
  "选举舞弊",
  "种族冲突",
];

export function isSafeKeyword(keyword: string): boolean {
  const lower = keyword.toLowerCase();
  return !KEYWORD_BLACKLIST.some((blocked) => lower.includes(blocked.toLowerCase()));
}

interface LeveragePromptInput {
  keyword: string;
  productName: string;
  brand: string;
  platform: string;
  audience?: string;
}

export function buildLeveragePrompt(input: LeveragePromptInput): string {
  return `
热搜话题：${input.keyword}
目标平台：${input.platform}
产品：${input.productName}（品牌：${input.brand}）
目标受众：${input.audience ?? "中小企业主、财务负责人"}

任务：生成3个借势角度。每个角度包含：
1. 一句话说明如何将热点话题与产品自然关联
2. 核心传播钩子（一句话）
3. 适合的细分受众

约束：关联自然，不得硬广；不拉踩竞品；与"${input.keyword}"有实质关联。

输出格式：
角度1：[关联] | 钩子：[一句话] | 受众：[描述]
角度2：[关联] | 钩子：[一句话] | 受众：[描述]
角度3：[关联] | 钩子：[一句话] | 受众：[描述]
`.trim();
}
