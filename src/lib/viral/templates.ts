export type ViralPlatform =
  | "xiaohongshu"
  | "weibo"
  | "linkedin"
  | "reddit"
  | "zhihu"
  | "tiktok"
  | "x"
  | "instagram";

export type ViralFormat = "short" | "long" | "thread" | "video_script";

export type ViralTemplate = {
  id: string;
  name: string;
  platforms: ViralPlatform[];
  format: ViralFormat;
  hook: string;
  structure: string[];
  cta: string;
};

export const VIRAL_TEMPLATES: ViralTemplate[] = [
  {
    id: "contrast-reveal",
    name: "对比揭秘",
    platforms: ["xiaohongshu", "weibo", "linkedin"],
    format: "short",
    hook: "以'99%的人不知道…'或'我以为X，结果发现Y'开头，制造认知落差",
    structure: [
      "痛点场景（2句话，读者能立刻认出自己）",
      "反直觉结论（1句，出乎意料）",
      "原因拆解（3点，每点一句）",
      "产品切入（自然带出，非硬广，1-2句）",
    ],
    cta: "以问题结尾引发评论，例如'你们遇到过这个问题吗？'",
  },
  {
    id: "listicle-authority",
    name: "权威列举",
    platforms: ["linkedin", "reddit", "zhihu"],
    format: "long",
    hook: "数字开头：'做了X件事之后，我终于搞清楚了…'，建立权威感",
    structure: [
      "背景铺垫（问题严重性，2-3句）",
      "N个核心点（每点：加粗标题 + 2句解释）",
      "总结归纳（1句提炼）",
    ],
    cta: "呼吁收藏或转发：'收藏备用，下次选型时用得上'",
  },
  {
    id: "story-arc",
    name: "故事弧",
    platforms: ["xiaohongshu", "tiktok", "instagram"],
    format: "short",
    hook: "第一句是结局，制造悬念：'我差点因为这件事损失XX万'",
    structure: [
      "现状（困境，读者能代入）",
      "转折点（发现了什么）",
      "解决过程（简短，不要细节堆砌）",
      "结果 + 产品自然露出",
    ],
    cta: "情感共鸣收尾：'希望这个经历能帮到你们'",
  },
  {
    id: "question-answer",
    name: "问答式",
    platforms: ["zhihu", "reddit", "x"],
    format: "thread",
    hook: "以高频搜索问题开头，直接作为标题或第一行",
    structure: [
      "直接回答（BLUF: 第一段给答案）",
      "展开解释（分点，每点有依据）",
      "补充场景（什么情况下例外）",
    ],
    cta: "邀请追问：'还有其他问题欢迎评论'",
  },
];

export function getTemplate(id: string): ViralTemplate | undefined {
  return VIRAL_TEMPLATES.find((template) => template.id === id);
}

export function buildTemplatePrompt(
  template: ViralTemplate,
  context: { productName: string; keyword: string; platform: string },
): string {
  return `
你是一位在 ${context.platform} 上写爆款内容的创作者。

产品：${context.productName}
话题关键词：${context.keyword}
内容模板：${template.name}

开头要求：${template.hook}

内容结构（按顺序展开）：
${template.structure.map((section, index) => `${index + 1}. ${section}`).join("\n")}

结尾要求：${template.cta}

约束：产品自然带出，不能是硬广；不得强行拉踩竞品；与"${context.keyword}"有实质关联。
`.trim();
}
