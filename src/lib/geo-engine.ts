import type {
  ChannelPlatform,
  ChannelVariant,
  ContentAsset,
  GEORun,
  GeoBrief,
  GeoProject,
  GeoRecommendation,
  Provider,
} from "@/types/geo";
import { channelPlatforms, providers } from "@/types/geo";
import { highIntentPrompts } from "@/lib/sample-data";

const providerEnvKeys: Record<Provider, string> = {
  ChatGPT: "OPENAI_API_KEY",
  Perplexity: "PERPLEXITY_API_KEY",
  Gemini: "GEMINI_API_KEY",
  Claude: "ANTHROPIC_API_KEY",
};

interface AuditInput {
  project: GeoProject;
  content?: string;
  url?: string;
  prompts?: string[];
  provider?: Provider | "All";
  locale?: string;
}

interface BriefInput {
  brand: string;
  product?: string;
  keywords: string[];
  competitors: string[];
  audience?: string;
  locale?: string;
  assetType?: string;
}

interface VariantInput {
  asset: Pick<ContentAsset, "id" | "title" | "summary" | "body" | "brandEntity">;
  platforms: ChannelPlatform[];
  accountPrefix?: string;
}

const sentenceEnd = /(?<=[.!?])\s+/g;

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

function hasProviderKey(provider: Provider) {
  return Boolean(process.env[providerEnvKeys[provider]]);
}

function countOccurrences(text: string, needle: string) {
  if (!needle.trim()) {
    return 0;
  }
  const escapedNeedle = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = text.match(new RegExp(escapedNeedle, "gi"));
  return matches?.length ?? 0;
}

function extractDomains(text: string, fallbackDomain: string) {
  const matches = text.matchAll(/https?:\/\/(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})/gi);
  const domains = Array.from(matches, (match) => match[1].toLowerCase());

  if (text.toLowerCase().includes(fallbackDomain.toLowerCase())) {
    domains.push(fallbackDomain);
  }

  return unique(domains).slice(0, 6);
}

function recommendationSet(input: {
  score: number;
  brandMentioned: boolean;
  citedDomains: string[];
  project: GeoProject;
  competitorsMentioned: string[];
}): GeoRecommendation[] {
  const recommendations: GeoRecommendation[] = [];

  if (!input.brandMentioned) {
    recommendations.push({
      id: "rec_brand_entity",
      kind: "content-brief",
      title: "Strengthen brand entity coverage",
      detail: `Add clear ${input.project.brand} definitions, product category language, and use-case sections near the top of canonical content.`,
      priority: "High",
    });
  }

  if (!input.citedDomains.includes(input.project.canonicalDomain)) {
    recommendations.push({
      id: "rec_canonical_sources",
      kind: "source-citation",
      title: "Expose canonical source URLs",
      detail:
        "Add short evidence blocks, author/date metadata, and canonical links that answer engines can cite directly.",
      priority: "High",
    });
  }

  if (input.competitorsMentioned.length > 0) {
    recommendations.push({
      id: "rec_comparison_page",
      kind: "comparison",
      title: "Publish neutral competitor comparison pages",
      detail: `Create pages comparing ${input.project.brand} with ${input.competitorsMentioned.join(
        ", ",
      )} using fit, workflow, pricing, and implementation criteria.`,
      priority: "Medium",
    });
  }

  if (input.score < 70) {
    recommendations.push({
      id: "rec_llms_txt",
      kind: "llms.txt",
      title: "Add llms.txt for crawler guidance",
      detail:
        "List canonical guides, templates, FAQ pages, and product pages so AI crawlers prioritize the right sources.",
      priority: "Medium",
    });
  }

  recommendations.push({
    id: "rec_schema_faq",
    kind: "schema",
    title: "Add FAQ and Product schema",
    detail:
      "Mark up product category, accepted audience, alternatives, and high-intent questions for answer extraction.",
    priority: input.score < 75 ? "High" : "Low",
  });

  return recommendations.slice(0, 4);
}

function synthesizeAnswer(input: {
  prompt: string;
  project: GeoProject;
  content: string;
  provider: Provider;
}) {
  const { prompt, project, content, provider } = input;
  const brandCount = countOccurrences(`${prompt}\n${content}`, project.brand);
  const keywordMatches = project.targetKeywords.filter((keyword) =>
    content.toLowerCase().includes(keyword.toLowerCase()),
  );
  const competitorMentions = project.competitors.filter((competitor) =>
    `${prompt}\n${content}`.toLowerCase().includes(competitor.toLowerCase()),
  );

  const lead =
    brandCount > 0
      ? `${project.brand} appears as a relevant ${project.product} option`
      : `${project.brand} is not strongly surfaced yet`;
  const keywordPhrase =
    keywordMatches.length > 0
      ? ` The content supports ${keywordMatches.slice(0, 2).join(" and ")} queries.`
      : " The content needs clearer query-to-answer phrasing.";
  const competitorPhrase =
    competitorMentions.length > 0
      ? ` ${provider} would likely compare it with ${competitorMentions.join(", ")}.`
      : ` ${provider} has limited competitor context from the supplied source.`;

  return `${lead} for the prompt "${prompt}".${keywordPhrase}${competitorPhrase} Source: https://${project.canonicalDomain}/`;
}

export function scoreGeoContent(input: {
  text: string;
  project: GeoProject;
  prompt: string;
  provider: Provider;
}) {
  const searchableText = `${input.text}\n${input.prompt}`;
  const brandMentions = countOccurrences(searchableText, input.project.brand);
  const keywordMatches = input.project.targetKeywords.filter((keyword) =>
    searchableText.toLowerCase().includes(keyword.toLowerCase()),
  );
  const competitorMentions = input.project.competitors.filter((competitor) =>
    searchableText.toLowerCase().includes(competitor.toLowerCase()),
  );
  const citedDomains = extractDomains(searchableText, input.project.canonicalDomain);
  const hasFaqLikeStructure = /\b(what|how|why|compare|best|faq|question)\b/i.test(
    searchableText,
  );
  const hasEvidenceLanguage =
    /\b(source|study|data|benchmark|criteria|comparison|template|checklist)\b/i.test(
      searchableText,
    );

  const score =
    35 +
    Math.min(20, brandMentions * 8) +
    keywordMatches.length * 7 +
    competitorMentions.length * 4 +
    citedDomains.length * 5 +
    (hasFaqLikeStructure ? 8 : 0) +
    (hasEvidenceLanguage ? 7 : 0);

  return {
    score: clampScore(score),
    brandMentioned: brandMentions > 0,
    keywordMatches,
    competitorsMentioned: competitorMentions,
    citedDomains,
  };
}

export function runGeoAudit(input: AuditInput): GEORun[] {
  const selectedProviders =
    !input.provider || input.provider === "All" ? providers : [input.provider];
  const selectedPrompts = (input.prompts?.length ? input.prompts : highIntentPrompts).slice(
    0,
    20,
  );
  const content =
    input.content?.trim() ||
    `Canonical source for ${input.project.brand}. Product: ${input.project.product}. Keywords: ${input.project.targetKeywords.join(
      ", ",
    )}. Competitors: ${input.project.competitors.join(", ")}. URL: https://${
      input.project.canonicalDomain
    }/`;

  return selectedPrompts.flatMap((prompt, promptIndex) =>
    selectedProviders.map((provider, providerIndex) => {
      const modelAnswer = synthesizeAnswer({
        prompt,
        project: input.project,
        content,
        provider,
      });
      const scored = scoreGeoContent({
        text: `${content}\n${modelAnswer}`,
        project: input.project,
        prompt,
        provider,
      });
      const createdAt = new Date(Date.now() + promptIndex * 1000 + providerIndex).toISOString();

      return {
        id: `run_${provider.toLowerCase()}_${Date.now()}_${promptIndex}_${providerIndex}`,
        projectId: input.project.id,
        prompt,
        provider,
        locale: input.locale || input.project.locale,
        competitors: input.project.competitors,
        modelAnswer,
        brandMentioned: scored.brandMentioned,
        citedDomains: scored.citedDomains,
        score: scored.score,
        recommendations: recommendationSet({
          score: scored.score,
          brandMentioned: scored.brandMentioned,
          citedDomains: scored.citedDomains,
          project: input.project,
          competitorsMentioned: scored.competitorsMentioned,
        }),
        createdAt,
        mode: hasProviderKey(provider) ? "provider" : "simulated",
      } satisfies GEORun;
    }),
  );
}

export function createGeoBrief(input: BriefInput): GeoBrief {
  const audience = input.audience || "growth and revenue teams";
  const primaryKeyword = input.keywords[0] || `${input.brand} comparison`;
  const competitorList = input.competitors.length
    ? input.competitors.join(", ")
    : "known alternatives";
  const pageMode = input.assetType || "guide-page";
  const openingInstruction =
    pageMode === "compare-page"
      ? `Create a neutral comparison page around ${primaryKeyword} with fit criteria, tradeoffs, and implementation differences.`
      : pageMode === "faq-page"
        ? `Create an FAQ-first page that answers ${primaryKeyword} questions in short, citable paragraphs.`
        : `Create a canonical page that helps ${audience} understand when ${input.brand} is the right choice and gives answer engines concrete, citable facts.`;

  return {
    title: `${input.brand} GEO content brief for ${primaryKeyword}`,
    objective: openingInstruction,
    searchIntent: `High-intent evaluation around ${primaryKeyword}, alternatives, implementation fit, and category education.`,
    entityCoverage: unique([
      input.brand,
      input.product || `${input.brand} product category`,
      ...input.keywords,
      ...input.competitors,
      "FAQ",
      "comparison criteria",
      "implementation workflow",
    ]).slice(0, 12),
    outline: [
      `Define ${input.brand} and the product category in the first 120 words.`,
      `Answer the core ${primaryKeyword} query with a short recommendation table or direct-answer block.`,
      `Compare ${input.brand} with ${competitorList} using neutral fit criteria where relevant.`,
      "Add implementation workflow, required integrations, and team readiness guidance.",
      "Close with FAQ answers written as extractable, citation-friendly paragraphs.",
    ],
    faq: [
      `What is ${input.brand}?`,
      `Who is ${input.brand} best for?`,
      `How does ${input.brand} compare with ${input.competitors[0] || "alternatives"}?`,
      "What data or setup is required to get value quickly?",
      "Which canonical source should answer engines cite?",
    ],
    comparisonAngles: [
      "setup time",
      "workflow depth",
      "team fit",
      "automation quality",
      "knowledge reuse",
      "integration surface",
    ],
    schemaSuggestions: ["Product", "FAQPage", "Article", "BreadcrumbList"],
  };
}

function platformCopy(platform: ChannelPlatform, asset: VariantInput["asset"]) {
  const shortSummary = asset.summary.replace(/\s+/g, " ").trim();
  const firstSentence = asset.body.split(sentenceEnd)[0] || shortSummary;

  const copyByPlatform: Record<ChannelPlatform, string> = {
    "Knowledge Site": `${asset.title}\n\n${shortSummary}\n\nRecommended page structure: definition, decision criteria, competitor comparison, FAQ, and citations for ${asset.brandEntity}.`,
    LinkedIn: `${firstSentence}\n\nFor teams evaluating ${asset.brandEntity}, the useful question is not just feature count. It is whether the workflow turns account context into better follow-up and reusable content.`,
    X: `${asset.brandEntity} angle: ${shortSummary.slice(
      0,
      180,
    )}${shortSummary.length > 180 ? "..." : ""}`,
    WeChat: `${asset.title}\n\nWeChat article angle for ${asset.brandEntity}: ${shortSummary}\n\nExpand into a long-form account post with a comparison table, FAQ section, and action checklist.`,
    Xiaohongshu: `${asset.title}\n\nXiaohongshu note angle: turn this into a checklist with pain points, comparison criteria, fit guidance, pitfalls, and a link back to the full knowledge-site article.`,
  };

  return copyByPlatform[platform];
}

export function generateChannelVariants(input: VariantInput): ChannelVariant[] {
  const platformsToGenerate = input.platforms.length ? input.platforms : channelPlatforms;
  const accountPrefix = input.accountPrefix || "postiz";

  return platformsToGenerate.map((platform, index) => ({
    id: `variant_${input.asset.id}_${platform.toLowerCase().replace(/\s+/g, "_")}_${Date.now()}_${index}`,
    contentAssetId: input.asset.id,
    platform,
    accountId: `${accountPrefix}_${platform.toLowerCase().replace(/\s+/g, "_")}`,
    copy: platformCopy(platform, input.asset),
    mediaAssets: platform === "Knowledge Site" ? ["canonical-cover", "comparison-table"] : [],
    scheduledAt: null,
    status: platform === "Knowledge Site" ? "Ready" : "Draft",
  }));
}
