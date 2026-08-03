import { createHash } from "node:crypto";
import { z } from "zod";

import { parseSearchConsoleProperty } from "@/lib/search-console/property";
import {
  priority,
  SEO_FORMULA_VERSION,
  type SeoAnalysisRunInput,
  type SeoOwnershipScope,
  type SeoPriorityInputs,
} from "./metrics";

export type SeoRecommendationKind =
  | "technical_fix"
  | "existing_page_improvement"
  | "new_content"
  | "measurement_repair";

export interface SeoRecommendationDraft {
  idempotencyKey: string;
  clientId: string;
  brandId: string;
  siteId: string;
  siteMarketId: string | null;
  kind: SeoRecommendationKind;
  subject: string;
  title: string;
  detail: string;
  observationIds: string[];
  signals: string[];
  formulaVersion: typeof SEO_FORMULA_VERSION;
  priorityInputs: SeoPriorityInputs;
  calculatedPriority: number;
  operatorOverride: number | null;
}

export interface SeoOperatorOverrideInput {
  siteId: string;
  kind: SeoRecommendationKind;
  subject: string;
  value: number;
}

export interface SeoRecommendationDetectorInput {
  scope: SeoOwnershipScope;
  runs: readonly SeoAnalysisRunInput[];
  operatorOverrides?: readonly SeoOperatorOverrideInput[];
}

export class SeoDetectorInputError extends Error {
  constructor() {
    super("SEO recommendation detector input is invalid.");
    this.name = "SeoDetectorInputError";
  }
}

const identifierSchema = z.string().trim().min(1).max(200);
const ownershipSchema = z.object({
  clientId: identifierSchema,
  brandId: identifierSchema,
  siteId: identifierSchema,
  siteMarketId: identifierSchema.nullable(),
}).strict();
const dateTimeSchema = z.union([
  z.string().refine((value) => Number.isFinite(Date.parse(value))),
  z.date().refine((value) => Number.isFinite(value.getTime())),
]);
const observationSchema = z.object({
  id: identifierSchema,
  kind: z.string().trim().min(1).max(128),
  subject: z.string().min(1).max(8_192),
  value: z.unknown(),
  observedAt: dateTimeSchema,
}).strict();
const runSchema = ownershipSchema.extend({
  id: identifierSchema,
  source: z.string().trim().min(1).max(128),
  status: z.enum([
    "queued",
    "running",
    "succeeded",
    "partial",
    "retrying",
    "failed",
    "cancelled",
  ]),
  startedAt: dateTimeSchema.nullable(),
  finishedAt: dateTimeSchema.nullable(),
  observations: z.array(observationSchema).max(100_000),
}).strict();
const detectorInputSchema = z.object({
  scope: ownershipSchema,
  runs: z.array(runSchema).max(10_000),
  operatorOverrides: z.array(z.unknown()).max(10_000).optional().default([]),
}).strict();
const recommendationKindSchema = z.enum([
  "technical_fix",
  "existing_page_improvement",
  "new_content",
  "measurement_repair",
]);
const overrideSchema = z.object({
  siteId: identifierSchema,
  kind: recommendationKindSchema,
  subject: z.string().min(1).max(8_192),
  value: z.number().finite().min(0).max(125),
}).strict();

const httpStatusSchema = z.object({ statusCode: z.number().int().min(400).max(599) });
const nonIndexableSchema = z.object({ indexable: z.literal(false) });
const canonicalMismatchSchema = z.object({ count: z.number().finite().int().min(1) });
const titleSchema = z.object({ text: z.string().max(8_192) });
const headingIssueSchema = z.object({
  count: z.number().finite().int().min(0),
  errorCount: z.number().finite().int().min(0),
}).refine(({ count, errorCount }) => errorCount <= count && (count === 0 || errorCount > 0));
const brokenLinkSchema = z.object({
  sourceUrl: z.string().max(8_192),
  statusCode: z.number().int().min(400).max(599),
});
const scoreIssueSchema = z.object({ score: z.number().finite().min(0).max(1) });
const searchSignalSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  query: z.string().max(2_048),
  page: z.string().max(8_192),
  country: z.string().max(64),
  device: z.string().max(64),
  clicks: z.number().finite().int().min(0),
  impressions: z.number().finite().int().min(0),
  ctr: z.number().finite().min(0).max(1),
  position: z.number().finite().min(0),
  dataState: z.literal("final"),
  scope: z.literal("top_rows"),
  pagination: z.object({ truncated: z.literal(false) }).passthrough(),
}).refine(({ clicks, impressions }) => clicks <= impressions);
const truncatedSummarySchema = z.object({
  scope: z.literal("top_rows"),
  dataState: z.literal("final"),
  rowsFetched: z.number().finite().int().min(0),
  rowsIncluded: z.number().finite().int().min(0),
  pagination: z.object({ truncated: z.literal(true) }).passthrough(),
});
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const searchConsoleSnapshotSummarySchema = z.object({
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  property: z.string().min(1).max(2_048),
  scope: z.literal("top_rows"),
  dataState: z.literal("final"),
  rowsFetched: z.number().finite().int().min(0),
  rowsIncluded: z.number().finite().int().min(0),
  pagination: z.object({ truncated: z.boolean() }).passthrough(),
}).refine(({ startDate, endDate, rowsFetched, rowsIncluded }) =>
  startDate <= endDate && rowsIncluded <= rowsFetched
);

const kindOrder: readonly SeoRecommendationKind[] = [
  "technical_fix",
  "existing_page_improvement",
  "new_content",
  "measurement_repair",
];

const priorityByKind: Record<SeoRecommendationKind, SeoPriorityInputs> = {
  technical_fix: {
    businessValue: 5,
    expectedImpact: 5,
    confidence: 4,
    estimatedEffort: 2,
  },
  existing_page_improvement: {
    businessValue: 4,
    expectedImpact: 4,
    confidence: 3,
    estimatedEffort: 2,
  },
  new_content: {
    businessValue: 4,
    expectedImpact: 5,
    confidence: 3,
    estimatedEffort: 3,
  },
  measurement_repair: {
    businessValue: 5,
    expectedImpact: 4,
    confidence: 5,
    estimatedEffort: 1,
  },
};

interface Signal {
  kind: SeoRecommendationKind;
  subject: string;
  observationId: string;
  code: string;
}

interface Group {
  kind: SeoRecommendationKind;
  subject: string;
  observationIds: Set<string>;
  signals: Set<string>;
}

function containsControl(value: string) {
  return /[\p{Cc}\p{Cf}]/u.test(value);
}

function normalizedPath(pathname: string) {
  const path = pathname.replace(/\/{2,}/g, "/");
  if (path === "/") return path;
  return path.replace(/\/+$/, "") || "/";
}

function safeQuery(url: URL) {
  const entries = [...url.searchParams.entries()];
  if (entries.some(([key, value]) => containsControl(key) || containsControl(value))) {
    return null;
  }
  entries.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
  );
  const search = new URLSearchParams(entries).toString();
  return search.length === 0 ? "" : `?${search}`;
}

export function normalizeSeoSubject(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    containsControl(trimmed) ||
    /%(?:0[0-9a-f]|7f)/i.test(trimmed)
  ) return null;

  const urlLike = trimmed.startsWith("/") || trimmed.includes("://");
  if (urlLike) {
    let parsed: URL;
    try {
      parsed = trimmed.startsWith("/")
        ? new URL(trimmed, "https://scope.invalid")
        : new URL(trimmed);
    } catch {
      return null;
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) return null;
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
    if (containsControl(decodedPath)) return null;
    const query = safeQuery(parsed);
    if (query === null) return null;
    return `${normalizedPath(parsed.pathname)}${query}`.slice(0, 240);
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || /[<>{}]/.test(trimmed)) return null;
  const plain = trimmed.replace(/\s+/g, " ");
  return plain.length > 0 ? plain.slice(0, 240) : null;
}

function normalizedQuerySubject(value: string) {
  if (
    value.length === 0 ||
    value.length > 2_048 ||
    containsControl(value) ||
    /[<>{}]/.test(value)
  ) return null;
  const query = value.trim().replace(/\s+/g, " ").slice(0, 220);
  return query.length > 0 ? `query:${query}` : null;
}

function exactScope(left: SeoOwnershipScope, right: SeoOwnershipScope) {
  return left.clientId === right.clientId &&
    left.brandId === right.brandId &&
    left.siteId === right.siteId &&
    left.siteMarketId === right.siteMarketId;
}

function sourceAllowsKind(source: string, kind: string) {
  if (source === "siteone") return kind.startsWith("siteone.");
  if (source === "unlighthouse") return kind.startsWith("unlighthouse.");
  if (source === "search-console") return kind.startsWith("search_console.");
  return false;
}

function runCompletion(run: z.infer<typeof runSchema>) {
  const value = run.finishedAt ?? run.startedAt;
  if (value === null) return "";
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function latestSnapshotRunIds(
  runs: readonly z.infer<typeof runSchema>[],
  scope: SeoOwnershipScope,
) {
  const latest = new Map<string, z.infer<typeof runSchema>>();
  for (const run of runs) {
    if (
      run.status !== "succeeded" ||
      !exactScope(run, scope) ||
      (run.source !== "siteone" && run.source !== "unlighthouse")
    ) continue;
    const existing = latest.get(run.source);
    if (
      existing === undefined ||
      runCompletion(run) > runCompletion(existing) ||
      (runCompletion(run) === runCompletion(existing) && run.id < existing.id)
    ) latest.set(run.source, run);
  }
  return new Set([...latest.values()].map(({ id }) => id));
}

function searchConsoleSnapshotKey(run: z.infer<typeof runSchema>) {
  const summaries = run.observations.filter(
    (observation) => observation.kind === "search_console.sync_summary",
  );
  if (summaries.length !== 1) return null;
  const summary = searchConsoleSnapshotSummarySchema.safeParse(summaries[0]!.value);
  if (!summary.success) return null;
  const data = summary.data;
  const property = parseSearchConsoleProperty(data.property);
  if (property === null || property !== data.property) return null;
  return JSON.stringify([
    "search-console",
    property,
    data.startDate,
    data.endDate,
    data.scope,
    data.dataState,
    "date",
    "query",
    "page",
    "country",
    "device",
  ]);
}

function latestSearchConsoleSnapshotRuns(
  runs: readonly z.infer<typeof runSchema>[],
  scope: SeoOwnershipScope,
) {
  const latest = new Map<string, z.infer<typeof runSchema>>();
  for (const run of runs) {
    if (
      !exactScope(run, scope) ||
      run.source !== "search-console" ||
      (run.status !== "succeeded" && run.status !== "partial")
    ) continue;
    const key = searchConsoleSnapshotKey(run);
    if (key === null) continue;
    const existing = latest.get(key);
    if (
      existing === undefined ||
      runCompletion(run) > runCompletion(existing) ||
      (runCompletion(run) === runCompletion(existing) && run.id < existing.id)
    ) latest.set(key, run);
  }
  return new Set(latest.values());
}

function issueSignal(
  kind: SeoRecommendationKind,
  subject: unknown,
  observationId: string,
  code: string,
): Signal | null {
  const normalized = normalizeSeoSubject(subject);
  return normalized === null ? null : { kind, subject: normalized, observationId, code };
}

function successfulSignal(
  observation: z.infer<typeof observationSchema>,
): Signal | null {
  switch (observation.kind) {
    case "siteone.http_status":
      return httpStatusSchema.safeParse(observation.value).success
        ? issueSignal("technical_fix", observation.subject, observation.id, "http_error")
        : null;
    case "siteone.indexability":
      return nonIndexableSchema.safeParse(observation.value).success
        ? issueSignal("technical_fix", observation.subject, observation.id, "not_indexable")
        : null;
    case "siteone.canonical_mismatch":
      return canonicalMismatchSchema.safeParse(observation.value).success
        ? issueSignal("technical_fix", observation.subject, observation.id, "canonical_mismatch")
        : null;
    case "siteone.heading":
      return headingIssueSchema.safeParse(observation.value).success
        ? issueSignal("technical_fix", observation.subject, observation.id, "heading_error")
        : null;
    case "siteone.broken_link":
      return brokenLinkSchema.safeParse(observation.value).success
        ? issueSignal("technical_fix", observation.subject, observation.id, "broken_link")
        : null;
    case "siteone.title": {
      const parsed = titleSchema.safeParse(observation.value);
      return parsed.success && parsed.data.text.trim().length === 0
        ? issueSignal("existing_page_improvement", observation.subject, observation.id, "missing_title")
        : null;
    }
    case "unlighthouse.performance":
    case "unlighthouse.seo": {
      const parsed = scoreIssueSchema.safeParse(observation.value);
      const threshold = observation.kind === "unlighthouse.performance" ? 0.75 : 0.9;
      return parsed.success && parsed.data.score < threshold
        ? issueSignal("technical_fix", observation.subject, observation.id, "low_lighthouse_score")
        : null;
    }
    case "search_console.search_analytics": {
      const parsed = searchSignalSchema.safeParse(observation.value);
      if (!parsed.success) return null;
      const data = parsed.data;
      if (data.impressions >= 100 && data.position > 10) {
        const subject = normalizedQuerySubject(data.query);
        return subject === null
          ? null
          : {
              kind: "new_content",
              subject,
              observationId: observation.id,
              code: "high_demand_low_rank_query",
            };
      }
      if (data.impressions >= 50 && data.ctr < 0.02) {
        return issueSignal(
          "existing_page_improvement",
          observation.subject,
          observation.id,
          "high_impression_low_ctr",
        );
      }
      return null;
    }
    default:
      return null;
  }
}

function partialMeasurementSignal(
  observation: z.infer<typeof observationSchema>,
): Signal | null {
  if (
    observation.kind !== "search_console.sync_summary" ||
    !truncatedSummarySchema.safeParse(observation.value).success
  ) return null;
  return issueSignal(
    "measurement_repair",
    observation.subject,
    observation.id,
    "truncated_search_console_sync",
  );
}

function bounded(value: string, maximumLength: number) {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ")
    .trim().slice(0, maximumLength);
}

const copyByKind: Record<SeoRecommendationKind, { title: string; detail: string }> = {
  technical_fix: {
    title: "Resolve technical SEO signals",
    detail: "Resolve the grouped technical signals and verify the affected subject with a new audit.",
  },
  existing_page_improvement: {
    title: "Improve an existing page",
    detail: "Improve the existing page signal and verify its search presentation in a later run.",
  },
  new_content: {
    title: "Evaluate a new content opportunity",
    detail: "Evaluate content intent and brand fit before creating a new page for this query.",
  },
  measurement_repair: {
    title: "Repair SEO measurement coverage",
    detail: "Restore complete measurement coverage before using this source for site-level decisions.",
  },
};

function overrideMap(
  scope: SeoOwnershipScope,
  values: readonly unknown[],
) {
  const overrides = new Map<string, number>();
  for (const value of values) {
    const parsed = overrideSchema.safeParse(value);
    if (!parsed.success || parsed.data.siteId !== scope.siteId) continue;
    const subject = normalizeSeoSubject(parsed.data.subject);
    if (subject === null) continue;
    const key = `${parsed.data.kind}\u0000${subject}`;
    const existing = overrides.get(key);
    if (existing === undefined || parsed.data.value > existing) {
      overrides.set(key, parsed.data.value);
    }
  }
  return overrides;
}

function draftId(scope: SeoOwnershipScope, kind: SeoRecommendationKind, subject: string) {
  const hash = createHash("sha256")
    .update(JSON.stringify([SEO_FORMULA_VERSION, scope.clientId, scope.siteId, kind, subject]))
    .digest("hex");
  return `seo:${hash}`;
}

export function detectSeoRecommendations(value: unknown): SeoRecommendationDraft[] {
  const parsed = detectorInputSchema.safeParse(value);
  if (!parsed.success) throw new SeoDetectorInputError();
  const { scope } = parsed.data;
  const groups = new Map<string, Group>();
  const snapshotRunIds = latestSnapshotRunIds(parsed.data.runs, scope);
  const searchConsoleSnapshotRuns = latestSearchConsoleSnapshotRuns(parsed.data.runs, scope);
  for (const run of parsed.data.runs) {
    if (!exactScope(run, scope)) continue;
    if (
      (run.source === "siteone" || run.source === "unlighthouse") &&
      !snapshotRunIds.has(run.id)
    ) continue;
    if (run.source === "search-console" && !searchConsoleSnapshotRuns.has(run)) continue;
    for (const observation of run.observations) {
      if (!sourceAllowsKind(run.source, observation.kind)) continue;
      const signal = run.status === "succeeded"
        ? successfulSignal(observation)
        : run.status === "partial"
        ? partialMeasurementSignal(observation)
        : null;
      if (signal === null) continue;
      const key = `${signal.kind}\u0000${signal.subject}`;
      const group = groups.get(key) ?? {
        kind: signal.kind,
        subject: signal.subject,
        observationIds: new Set<string>(),
        signals: new Set<string>(),
      };
      group.observationIds.add(signal.observationId);
      group.signals.add(signal.code);
      groups.set(key, group);
    }
  }

  const overrides = overrideMap(scope, parsed.data.operatorOverrides);
  return [...groups.values()]
    .sort((left, right) =>
      kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind) ||
      left.subject.localeCompare(right.subject)
    )
    .map((group) => {
      const copy = copyByKind[group.kind];
      const inputs = { ...priorityByKind[group.kind] };
      const calculatedPriority = priority(inputs);
      if (calculatedPriority === null) {
        throw new SeoDetectorInputError();
      }
      const key = `${group.kind}\u0000${group.subject}`;
      return {
        idempotencyKey: draftId(scope, group.kind, group.subject),
        ...scope,
        kind: group.kind,
        subject: group.subject,
        title: bounded(`${copy.title}: ${group.subject}`, 160),
        detail: bounded(`${copy.detail} Subject: ${group.subject}.`, 512),
        observationIds: [...group.observationIds].sort(),
        signals: [...group.signals].sort(),
        formulaVersion: SEO_FORMULA_VERSION,
        priorityInputs: inputs,
        calculatedPriority,
        operatorOverride: overrides.get(key) ?? null,
      };
    });
}
