import { scoreGeoContent } from "@/lib/geo-engine";
import type { GeoProject, Provider } from "@/types/geo";

interface SeoScoreInput {
  title: string;
  body: string;
  targetKeywords: string[];
  locale: string;
}

export interface SeoScoreResult {
  score: number;
  keywordDensity: number;
  titleHasKeyword: boolean;
  suggestions: string[];
}

interface DualScoreInput {
  title: string;
  body: string;
  targetKeywords: string[];
  project: GeoProject;
  prompt: string;
  provider: Provider;
}

export interface DualScoreResult {
  geoScore: number;
  seoScore: number;
  suggestions: string[];
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countOccurrences(text: string, needle: string): number {
  if (!needle.trim()) {
    return 0;
  }

  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (text.match(new RegExp(escaped, "gi")) ?? []).length;
}

export function scoreSeoContent(input: SeoScoreInput): SeoScoreResult {
  const fullText = `${input.title} ${input.body}`;
  const words = wordCount(fullText);
  const suggestions: string[] = [];
  const primaryKeyword = input.targetKeywords[0] ?? "";

  const occurrences = countOccurrences(fullText, primaryKeyword);
  const keywordDensity = words > 0 ? (occurrences / words) * 100 : 0;
  const titleHasKeyword = primaryKeyword
    ? input.title.toLowerCase().includes(primaryKeyword.toLowerCase())
    : false;

  if (!titleHasKeyword && primaryKeyword) {
    suggestions.push(`Add "${primaryKeyword}" to the title`);
  }

  if (keywordDensity < 0.5 && primaryKeyword) {
    suggestions.push(`Increase keyword density (current: ${keywordDensity.toFixed(2)}%)`);
  }

  if (words < 300) {
    suggestions.push("Aim for 300+ words for better SEO coverage");
  }

  let score = 30;

  if (titleHasKeyword) {
    score += 25;
  }

  if (keywordDensity >= 0.5 && keywordDensity <= 3) {
    score += 20;
  }

  if (words >= 300) {
    score += 15;
  }

  score +=
    input.targetKeywords
      .slice(1)
      .filter((keyword) => fullText.toLowerCase().includes(keyword.toLowerCase())).length * 5;

  return {
    score: Math.min(100, score),
    keywordDensity,
    titleHasKeyword,
    suggestions,
  };
}

export function scoreDualContent(input: DualScoreInput): DualScoreResult {
  const geoResult = scoreGeoContent({
    text: `${input.title}\n${input.body}`,
    project: input.project,
    prompt: input.prompt,
    provider: input.provider,
  });

  const seoResult = scoreSeoContent({
    title: input.title,
    body: input.body,
    targetKeywords: input.targetKeywords,
    locale: input.project.locale,
  });

  return {
    geoScore: geoResult.score,
    seoScore: seoResult.score,
    suggestions: seoResult.suggestions,
  };
}
