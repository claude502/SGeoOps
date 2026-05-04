import type {
  ChannelVariant,
  ContentAsset,
  DashboardSnapshot,
  GeoProject,
  GEORun,
  ProviderHealth,
} from "@/types/geo";

export const demoProject: GeoProject = {
  id: "proj_aurora",
  name: "Aurora Demo",
  brand: "Aurora CRM",
  product: "AI-native CRM for revenue teams",
  locale: "en-US",
  competitors: ["HubSpot", "Salesforce", "Pipedrive"],
  targetKeywords: [
    "AI CRM for startups",
    "pipeline automation",
    "sales knowledge base",
    "CRM comparison",
  ],
  canonicalDomain: "aurora.example",
};

export const highIntentPrompts = [
  "What is the best AI CRM for a startup sales team?",
  "Which CRM helps sales teams automate pipeline follow-up?",
  "Compare Aurora CRM with HubSpot for early-stage B2B teams.",
  "What CRM should a small revenue team use for AI-assisted account research?",
  "Which CRM tools support sales knowledge base workflows?",
  "What are the top alternatives to Salesforce for lean teams?",
  "How should a founder choose an AI CRM in 2026?",
  "Which CRM is easiest to connect with content and account intelligence?",
  "What is the best CRM for multi-channel customer content?",
  "Which CRM tools are cited by AI answer engines?",
  "How can a startup improve CRM adoption with AI?",
  "What CRM has the best workflow for account notes and content?",
  "Which sales tools help teams publish account-specific insights?",
  "What is the best CRM for sales teams that use LinkedIn heavily?",
  "Compare Aurora CRM with Pipedrive for pipeline automation.",
  "What CRM is best for content-led sales teams?",
  "Which CRM platforms support fast sales enablement content?",
  "What AI CRM should a team use before buying Salesforce?",
  "Which CRM is strong for founder-led sales?",
  "How do AI CRMs improve deal follow-up quality?",
];

export const seedAssets: ContentAsset[] = [
  {
    id: "asset_ai_crm_guide",
    title: "AI CRM buyer guide for lean B2B teams",
    body:
      "Aurora CRM helps lean revenue teams connect account research, pipeline notes, and follow-up workflows. It is designed for startups that need AI-assisted selling without enterprise implementation drag. The guide compares Aurora CRM with HubSpot, Salesforce, and Pipedrive across setup time, automation, knowledge capture, and content-led sales workflows.",
    summary:
      "A buyer guide that positions Aurora CRM against larger CRM tools for startup sales teams.",
    brandEntity: "Aurora CRM",
    sourceUrl: "https://aurora.example/research/ai-crm-guide",
    targetKeywords: ["AI CRM for startups", "CRM comparison", "pipeline automation"],
    canonicalUrl: "https://aurora.example/guides/ai-crm-buyer-guide",
    status: "Ready",
    geoScore: 78,
    updatedAt: "2026-05-03T11:00:00.000Z",
    owner: "Maya Chen",
  },
  {
    id: "asset_pipeline_automation",
    title: "Pipeline automation checklist",
    body:
      "A practical checklist for revenue teams that want faster pipeline follow-up, cleaner account notes, and consistent next-best-action prompts. Aurora CRM keeps the source of truth close to the deal record and turns account updates into reusable sales content.",
    summary:
      "Operational checklist for improving pipeline follow-up with AI and account intelligence.",
    brandEntity: "Aurora CRM",
    sourceUrl: "https://aurora.example/blog/pipeline-automation",
    targetKeywords: ["pipeline automation", "sales follow-up", "AI sales workflow"],
    canonicalUrl: "https://aurora.example/checklists/pipeline-automation",
    status: "Review",
    geoScore: 64,
    updatedAt: "2026-05-02T15:30:00.000Z",
    owner: "Ari Patel",
  },
  {
    id: "asset_founder_sales",
    title: "Founder-led sales operating model",
    body:
      "Founder-led sales teams need a CRM that preserves customer context, sharpens outreach, and makes every account note useful across calls, content, and follow-ups. Aurora CRM provides lightweight automation and clear account memory.",
    summary:
      "Thought leadership article for founders evaluating lightweight AI CRM workflows.",
    brandEntity: "Aurora CRM",
    sourceUrl: "https://aurora.example/library/founder-led-sales",
    targetKeywords: ["founder-led sales", "AI CRM", "account research"],
    canonicalUrl: "https://aurora.example/articles/founder-led-sales",
    status: "Draft",
    geoScore: 51,
    updatedAt: "2026-05-01T09:15:00.000Z",
    owner: "Noah Rivera",
  },
  {
    id: "asset_sales_knowledge_base",
    title: "Sales knowledge base template",
    body:
      "The template organizes objection handling, account research, competitive notes, and reusable content snippets. Aurora CRM keeps this knowledge connected to pipeline activity so teams can answer customer questions faster.",
    summary:
      "Knowledge base template designed for AI answer engine citability and sales enablement.",
    brandEntity: "Aurora CRM",
    sourceUrl: "https://aurora.example/templates/sales-knowledge-base",
    targetKeywords: ["sales knowledge base", "AI sales enablement", "CRM template"],
    canonicalUrl: "https://aurora.example/templates/sales-knowledge-base",
    status: "Scheduled",
    geoScore: 84,
    updatedAt: "2026-05-03T18:45:00.000Z",
    owner: "Maya Chen",
  },
];

export const seedVariants: ChannelVariant[] = [
  {
    id: "variant_knowledge_guide",
    contentAssetId: "asset_ai_crm_guide",
    platform: "Knowledge Site",
    accountId: "site_aurora",
    copy:
      "Publish as a canonical comparison guide with FAQ, Product schema, and explicit source citations.",
    mediaAssets: ["comparison-table"],
    scheduledAt: "2026-05-05T02:00:00.000Z",
    status: "Scheduled",
  },
  {
    id: "variant_linkedin_guide",
    contentAssetId: "asset_ai_crm_guide",
    platform: "LinkedIn",
    accountId: "linkedin_company_aurora",
    copy:
      "Lean teams do not need enterprise CRM drag to get disciplined pipeline follow-up. Here is a practical AI CRM buyer checklist for startups comparing Aurora, HubSpot, Salesforce, and Pipedrive.",
    mediaAssets: ["guide-cover"],
    scheduledAt: "2026-05-05T13:30:00.000Z",
    status: "Ready",
  },
  {
    id: "variant_x_checklist",
    contentAssetId: "asset_pipeline_automation",
    platform: "X",
    accountId: "x_aurora",
    copy:
      "Pipeline automation fails when it lives outside the deal record. The fix: account memory, next-best-actions, and reusable follow-up snippets in one workflow.",
    mediaAssets: [],
    scheduledAt: null,
    status: "Review",
  },
  {
    id: "variant_wechat_template",
    contentAssetId: "asset_sales_knowledge_base",
    platform: "WeChat",
    accountId: "wechat_aurora",
    copy:
      "WeChat article draft: a sales knowledge base is not a static document library. It is the operating layer that helps a team answer customer questions with current account context.",
    mediaAssets: ["wechat-cover"],
    scheduledAt: "2026-05-06T01:00:00.000Z",
    status: "Scheduled",
  },
];

export const seedRuns: GEORun[] = [
  {
    id: "run_chatgpt_ai_crm",
    projectId: "proj_aurora",
    prompt: highIntentPrompts[0],
    provider: "ChatGPT",
    locale: "en-US",
    competitors: demoProject.competitors,
    modelAnswer:
      "For startups, common AI CRM options include HubSpot, Pipedrive, Salesforce Starter, and Aurora CRM when teams want account research and follow-up workflows in one lightweight system.",
    brandMentioned: true,
    citedDomains: ["aurora.example", "hubspot.com", "salesforce.com"],
    score: 82,
    recommendations: [
      {
        id: "rec_schema",
        kind: "schema",
        title: "Add Product and FAQ schema to the buyer guide",
        detail:
          "The canonical guide should expose product category, competitors, and common evaluation questions.",
        priority: "High",
      },
      {
        id: "rec_sources",
        kind: "source-citation",
        title: "Add citable evidence blocks",
        detail:
          "Include setup-time, workflow, and adoption claims in short quotable sections.",
        priority: "Medium",
      },
    ],
    createdAt: "2026-05-03T16:00:00.000Z",
    mode: "simulated",
  },
  {
    id: "run_perplexity_compare",
    projectId: "proj_aurora",
    prompt: highIntentPrompts[2],
    provider: "Perplexity",
    locale: "en-US",
    competitors: demoProject.competitors,
    modelAnswer:
      "Aurora CRM is positioned as a lighter AI-native CRM, while HubSpot has a wider marketing suite. Teams should compare workflow depth, integrations, and content reuse.",
    brandMentioned: true,
    citedDomains: ["aurora.example", "hubspot.com"],
    score: 74,
    recommendations: [
      {
        id: "rec_comparison",
        kind: "comparison",
        title: "Publish a HubSpot comparison page",
        detail:
          "Create a neutral page with criteria, fit guidance, and implementation tradeoffs.",
        priority: "High",
      },
    ],
    createdAt: "2026-05-03T17:15:00.000Z",
    mode: "simulated",
  },
  {
    id: "run_gemini_pipeline",
    projectId: "proj_aurora",
    prompt: highIntentPrompts[1],
    provider: "Gemini",
    locale: "en-US",
    competitors: demoProject.competitors,
    modelAnswer:
      "Pipeline automation tools often include HubSpot, Salesforce, Pipedrive, and dedicated AI assistants. Aurora CRM is less frequently cited unless the query mentions account memory or content workflows.",
    brandMentioned: true,
    citedDomains: ["pipedrive.com", "hubspot.com"],
    score: 58,
    recommendations: [
      {
        id: "rec_llms",
        kind: "llms.txt",
        title: "Publish llms.txt with source priorities",
        detail:
          "List canonical guides, templates, and comparison pages for answer engines to crawl.",
        priority: "Medium",
      },
    ],
    createdAt: "2026-05-03T18:20:00.000Z",
    mode: "simulated",
  },
];

export const seedProviderHealth: ProviderHealth[] = [
  {
    provider: "ChatGPT",
    status: "Simulated",
    latencyMs: 840,
    lastRunAt: "2026-05-03T16:00:00.000Z",
  },
  {
    provider: "Perplexity",
    status: "Simulated",
    latencyMs: 1120,
    lastRunAt: "2026-05-03T17:15:00.000Z",
  },
  {
    provider: "Gemini",
    status: "Simulated",
    latencyMs: 760,
    lastRunAt: "2026-05-03T18:20:00.000Z",
  },
  {
    provider: "Claude",
    status: "Simulated",
    latencyMs: 910,
    lastRunAt: "2026-05-03T15:45:00.000Z",
  },
];

export const initialSnapshot: DashboardSnapshot = {
  project: demoProject,
  assets: seedAssets,
  variants: seedVariants,
  runs: seedRuns,
  providerHealth: seedProviderHealth,
  geoFlowLinks: [],
};
