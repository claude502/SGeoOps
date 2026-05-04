import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

if (process.env.SEED_DEMO_DATA !== "true") {
  console.log("SEED_DEMO_DATA is not true; no demo content assets were seeded.");
  process.exit(0);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  }),
});

const assets = [
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
    owner: "Maya Chen",
  },
];

try {
  for (const asset of assets) {
    await prisma.contentAsset.upsert({
      where: { id: asset.id },
      create: asset,
      update: asset,
    });
  }
  console.log(`Seeded ${assets.length} content assets.`);
} finally {
  await prisma.$disconnect();
}
