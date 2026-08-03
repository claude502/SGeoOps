import { z } from "zod";

export const SEO_FORMULA_VERSION = "seo-v1";

export const SEO_METRIC_NAMES = {
  CRAWL_SUCCESS_RATE: "seo.crawl_success_rate",
  INDEXABILITY_RATE: "seo.indexability_rate",
  CANONICAL_HEALTH_RATE: "seo.canonical_health_rate",
  TITLE_COMPLETENESS_RATE: "seo.title_completeness_rate",
  HEADING_COMPLETENESS_RATE: "seo.heading_completeness_rate",
  STRUCTURED_DATA_COVERAGE_RATE: "seo.structured_data_coverage_rate",
  BROKEN_LINK_RATE: "seo.broken_link_rate",
  LIGHTHOUSE_PERFORMANCE_SCORE: "seo.lighthouse.performance_score",
  LIGHTHOUSE_ACCESSIBILITY_SCORE: "seo.lighthouse.accessibility_score",
  LIGHTHOUSE_BEST_PRACTICES_SCORE: "seo.lighthouse.best_practices_score",
  LIGHTHOUSE_SEO_SCORE: "seo.lighthouse.seo_score",
  LIGHTHOUSE_LCP_MS: "seo.lighthouse.lcp_ms",
  LIGHTHOUSE_CLS_SCORE: "seo.lighthouse.cls_score",
  LIGHTHOUSE_INP_MS: "seo.lighthouse.inp_ms",
  SEARCH_CONSOLE_CLICKS: "seo.search_console.clicks",
  SEARCH_CONSOLE_IMPRESSIONS: "seo.search_console.impressions",
  SEARCH_CONSOLE_CTR: "seo.search_console.ctr",
  SEARCH_CONSOLE_AVERAGE_POSITION: "seo.search_console.average_position",
  ORGANIC_VISITS: "seo.analytics.organic_visits",
  CONVERSIONS: "seo.analytics.conversions",
} as const;

export type SeoMetricName =
  (typeof SEO_METRIC_NAMES)[keyof typeof SEO_METRIC_NAMES];

export interface SeoOwnershipScope {
  clientId: string;
  brandId: string;
  siteId: string;
  siteMarketId: string | null;
}

export interface SeoObservationInput {
  id: string;
  kind: string;
  subject: string;
  value: unknown;
  observedAt: string | Date;
}

export interface SeoAnalysisRunInput extends SeoOwnershipScope {
  id: string;
  source: string;
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "partial"
    | "retrying"
    | "failed"
    | "cancelled";
  startedAt: string | Date | null;
  finishedAt: string | Date | null;
  observations: readonly SeoObservationInput[];
}

export interface SeoMetricsInput {
  scope: SeoOwnershipScope;
  runs: readonly SeoAnalysisRunInput[];
}

export interface SeoPriorityInputs {
  businessValue: number;
  expectedImpact: number;
  confidence: number;
  estimatedEffort: number;
}

export interface SeoMetricDimensions {
  scope: SeoOwnershipScope;
  definition: string;
  aggregation: string;
  availability:
    | { status: "available" }
    | { status: "unavailable"; reason: string };
  sourceRunIds: string[];
  sourceDates: { start: string; end: string } | null;
  observedAt: { start: string; end: string } | null;
  dedupePolicy: string;
  inputs: Record<string, number | string | boolean | null>;
}

export interface SeoMetricResult {
  name: SeoMetricName;
  value: number | null;
  formulaVersion: typeof SEO_FORMULA_VERSION;
  evidenceObservationIds: string[];
  dimensions: SeoMetricDimensions;
}

export class SeoMetricsInputError extends Error {
  constructor() {
    super("SEO metrics input is invalid.");
    this.name = "SeoMetricsInputError";
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
const metricsInputSchema = z.object({
  scope: ownershipSchema,
  runs: z.array(runSchema).max(10_000),
}).strict();

const nonNegativeInteger = z.number().finite().int().min(0);
const percentage = z.number().finite().min(0).max(1);
const httpStatusSchema = z.object({ statusCode: z.number().int().min(100).max(599) });
const indexabilitySchema = z.object({ indexable: z.boolean() });
const canonicalSchema = z.object({ count: nonNegativeInteger });
const titleSchema = z.object({ text: z.string().max(8_192) });
const headingSchema = z.object({
  count: nonNegativeInteger,
  errorCount: nonNegativeInteger,
}).refine(({ count, errorCount }) => errorCount <= count);
const structuredDataSchema = z.object({
  count: z.number().finite().int().min(1),
  types: z.array(z.string().trim().min(1).max(256)).max(128),
});
const brokenLinkSchema = z.object({
  sourceUrl: z.string().max(8_192),
  statusCode: z.number().int().min(400).max(599),
});
const scoreSchema = z.object({ score: percentage });
const millisecondsSchema = z.object({ milliseconds: z.number().finite().min(0) });
const inpSchema = z.object({
  milliseconds: z.number().finite().min(0),
  metric: z.enum(["interaction-to-next-paint", "total-blocking-time"]),
  fallback: z.boolean(),
}).refine(({ metric, fallback }) =>
  fallback
    ? metric === "total-blocking-time"
    : metric === "interaction-to-next-paint"
);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const searchConsoleSchema = z.object({
  date: isoDateSchema,
  query: z.string().max(2_048),
  page: z.string().max(8_192),
  country: z.string().max(64),
  device: z.string().max(64),
  clicks: nonNegativeInteger,
  impressions: nonNegativeInteger,
  ctr: percentage,
  position: z.number().finite().min(0),
  dataState: z.literal("final"),
  scope: z.literal("top_rows"),
  pagination: z.object({ truncated: z.literal(false) }).passthrough(),
}).refine(({ clicks, impressions }) => clicks <= impressions);
const searchConsoleSummarySchema = z.object({
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  property: z.string().min(1).max(2_048).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  scope: z.literal("top_rows"),
  dataState: z.literal("final"),
  rowsFetched: nonNegativeInteger,
  rowsIncluded: nonNegativeInteger,
  pagination: z.object({ truncated: z.literal(false) }).passthrough(),
}).refine(({ startDate, endDate }) => startDate <= endDate);
const matomoBaseSchema = z.object({
  count: nonNegativeInteger,
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  idSite: z.number().int().min(1),
  segment: z.string().max(4_096),
  timezone: z.string().min(1).max(128),
  reportMethod: z.string().min(1).max(128),
}).refine(({ startDate, endDate }) => startDate <= endDate);
const organicVisitSchema = matomoBaseSchema.extend({
  metric: z.literal("nb_visits"),
});
const conversionSchema = matomoBaseSchema.extend({
  idGoal: z.number().int().min(1),
});
const matomoSummarySchema = z.object({
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  idSite: z.number().int().min(1),
  idGoal: z.number().int().min(1),
  segment: z.string().max(4_096),
  organicSegment: z.string().max(4_096).optional(),
  timezone: z.string().min(1).max(128),
}).refine(({ startDate, endDate }) => startDate <= endDate);

type ParsedValue =
  | { kind: "siteone.http_status"; statusCode: number }
  | { kind: "siteone.indexability"; indexable: boolean }
  | { kind: "siteone.canonical_mismatch"; count: number }
  | { kind: "siteone.title"; text: string }
  | { kind: "siteone.heading"; count: number; errorCount: number }
  | { kind: "siteone.structured_data"; count: number; types: string[] }
  | { kind: "siteone.broken_link"; sourceUrl: string; statusCode: number }
  | { kind: "unlighthouse.performance"; score: number }
  | { kind: "unlighthouse.accessibility"; score: number }
  | { kind: "unlighthouse.best_practices"; score: number }
  | { kind: "unlighthouse.seo"; score: number }
  | { kind: "unlighthouse.lcp"; milliseconds: number }
  | { kind: "unlighthouse.cls"; score: number }
  | {
    kind: "unlighthouse.inp";
    milliseconds: number;
    metric: "interaction-to-next-paint" | "total-blocking-time";
    fallback: boolean;
  }
  | {
    kind: "search_console.search_analytics";
    date: string;
    query: string;
    page: string;
    country: string;
    device: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }
  | {
    kind: "search_console.sync_summary";
    startDate: string;
    endDate: string;
    property: string;
  }
  | {
    kind: "organic_visit";
    count: number;
    startDate: string;
    endDate: string;
    idSite: number;
    segment: string;
  }
  | {
    kind: "matomo.sync_summary";
    startDate: string;
    endDate: string;
    idSite: number;
    idGoal: number;
    segment: string;
    organicSegment: string;
  }
  | {
    kind: "conversion";
    count: number;
    startDate: string;
    endDate: string;
    idSite: number;
    idGoal: number;
    segment: string;
  };

interface ParsedFact {
  id: string;
  runId: string;
  subject: string;
  observedAt: string;
  semanticKey: string;
  windowKeys: string[];
  sourceStartDate: string;
  sourceEndDate: string;
  value: ParsedValue;
}

const DEDUPE_POLICY =
  "latest complete SiteOne or Unlighthouse snapshot; latest succeeded Search Console or Matomo source-window snapshot, including zero-row summaries; otherwise latest observedAt per semantic key; lowest observation ID breaks ties";

function normalizedDate(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
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
  if (source === "matomo") {
    return kind === "page_view" ||
      kind === "organic_visit" ||
      kind === "conversion" ||
      kind === "matomo.sync_summary";
  }
  return false;
}

function runCompletion(run: z.infer<typeof runSchema>) {
  const value = run.finishedAt ?? run.startedAt;
  return value === null ? "" : normalizedDate(value);
}

function latestSnapshotRunIds(input: z.infer<typeof metricsInputSchema>) {
  const latest = new Map<string, z.infer<typeof runSchema>>();
  for (const run of input.runs) {
    if (
      run.status !== "succeeded" ||
      !exactScope(run, input.scope) ||
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

function keyed(parts: readonly (string | number)[]) {
  return JSON.stringify(parts);
}

function searchConsoleWindowKey(
  startDate: string,
  endDate: string,
  property: string,
) {
  return keyed(["search-console", startDate, endDate, property]);
}

function matomoOrganicWindowKey(
  startDate: string,
  endDate: string,
  idSite: number,
  segment: string,
) {
  return keyed(["matomo", "organic", startDate, endDate, idSite, segment]);
}

function matomoConversionWindowKey(
  startDate: string,
  endDate: string,
  idSite: number,
  idGoal: number,
  segment: string,
) {
  return keyed(["matomo", "conversion", startDate, endDate, idSite, idGoal, segment]);
}

function fact(
  observation: z.infer<typeof observationSchema>,
  runId: string,
  value: ParsedValue,
  keyParts: readonly (string | number)[],
  sourceStartDate?: string,
  sourceEndDate?: string,
  windowKeys: readonly string[] = [],
): ParsedFact {
  const observedAt = normalizedDate(observation.observedAt);
  const observedDate = observedAt.slice(0, 10);
  return {
    id: observation.id,
    runId,
    subject: observation.subject,
    observedAt,
    semanticKey: keyed([value.kind, ...keyParts]),
    windowKeys: [...new Set(windowKeys)].sort(),
    sourceStartDate: sourceStartDate ?? observedDate,
    sourceEndDate: sourceEndDate ?? observedDate,
    value,
  };
}

function parseFact(
  observation: z.infer<typeof observationSchema>,
  runId: string,
): ParsedFact | null {
  const value = observation.value;
  switch (observation.kind) {
    case "siteone.http_status": {
      const parsed = httpStatusSchema.safeParse(value);
      return parsed.success
        ? fact(observation, runId, { kind: observation.kind, ...parsed.data }, [observation.subject])
        : null;
    }
    case "siteone.indexability": {
      const parsed = indexabilitySchema.safeParse(value);
      return parsed.success
        ? fact(observation, runId, { kind: observation.kind, ...parsed.data }, [observation.subject])
        : null;
    }
    case "siteone.canonical_mismatch": {
      const parsed = canonicalSchema.safeParse(value);
      return parsed.success
        ? fact(observation, runId, { kind: observation.kind, ...parsed.data }, [observation.subject])
        : null;
    }
    case "siteone.title": {
      const parsed = titleSchema.safeParse(value);
      return parsed.success
        ? fact(observation, runId, { kind: observation.kind, ...parsed.data }, [observation.subject])
        : null;
    }
    case "siteone.heading": {
      const parsed = headingSchema.safeParse(value);
      return parsed.success
        ? fact(observation, runId, { kind: observation.kind, ...parsed.data }, [observation.subject])
        : null;
    }
    case "siteone.structured_data": {
      const parsed = structuredDataSchema.safeParse(value);
      return parsed.success
        ? fact(observation, runId, { kind: observation.kind, ...parsed.data }, [observation.subject])
        : null;
    }
    case "siteone.broken_link": {
      const parsed = brokenLinkSchema.safeParse(value);
      return parsed.success
        ? fact(observation, runId, { kind: observation.kind, ...parsed.data }, [observation.subject, parsed.data.sourceUrl])
        : null;
    }
    case "unlighthouse.performance":
    case "unlighthouse.accessibility":
    case "unlighthouse.best_practices":
    case "unlighthouse.seo":
    case "unlighthouse.cls": {
      const parsed = scoreSchema.safeParse(value);
      return parsed.success
        ? fact(observation, runId, { kind: observation.kind, ...parsed.data }, [observation.subject])
        : null;
    }
    case "unlighthouse.lcp": {
      const parsed = millisecondsSchema.safeParse(value);
      return parsed.success
        ? fact(observation, runId, { kind: observation.kind, ...parsed.data }, [observation.subject])
        : null;
    }
    case "unlighthouse.inp": {
      const parsed = inpSchema.safeParse(value);
      return parsed.success
        ? fact(observation, runId, { kind: observation.kind, ...parsed.data }, [observation.subject])
        : null;
    }
    case "search_console.search_analytics": {
      const parsed = searchConsoleSchema.safeParse(value);
      if (!parsed.success) return null;
      const data = parsed.data;
      return fact(observation, runId, {
        kind: observation.kind,
        date: data.date,
        query: data.query,
        page: data.page,
        country: data.country,
        device: data.device,
        clicks: data.clicks,
        impressions: data.impressions,
        ctr: data.ctr,
        position: data.position,
      }, [data.date, data.query, data.page, data.country, data.device], data.date, data.date);
    }
    case "search_console.sync_summary": {
      const parsed = searchConsoleSummarySchema.safeParse(value);
      if (!parsed.success) return null;
      const data = parsed.data;
      return fact(observation, runId, {
        kind: observation.kind,
        startDate: data.startDate,
        endDate: data.endDate,
        property: data.property,
      }, [data.startDate, data.endDate, data.property], data.startDate, data.endDate, [
        searchConsoleWindowKey(data.startDate, data.endDate, data.property),
      ]);
    }
    case "organic_visit": {
      const parsed = organicVisitSchema.safeParse(value);
      if (!parsed.success) return null;
      const data = parsed.data;
      return fact(observation, runId, {
        kind: observation.kind,
        count: data.count,
        startDate: data.startDate,
        endDate: data.endDate,
        idSite: data.idSite,
        segment: data.segment,
      }, [observation.subject, data.startDate, data.endDate, data.idSite, data.segment], data.startDate, data.endDate, [
        matomoOrganicWindowKey(data.startDate, data.endDate, data.idSite, data.segment),
      ]);
    }
    case "conversion": {
      const parsed = conversionSchema.safeParse(value);
      if (!parsed.success) return null;
      const data = parsed.data;
      return fact(observation, runId, {
        kind: observation.kind,
        count: data.count,
        startDate: data.startDate,
        endDate: data.endDate,
        idSite: data.idSite,
        idGoal: data.idGoal,
        segment: data.segment,
      }, [observation.subject, data.startDate, data.endDate, data.idSite, data.idGoal, data.segment], data.startDate, data.endDate, [
        matomoConversionWindowKey(
          data.startDate,
          data.endDate,
          data.idSite,
          data.idGoal,
          data.segment,
        ),
      ]);
    }
    case "matomo.sync_summary": {
      const parsed = matomoSummarySchema.safeParse(value);
      if (!parsed.success) return null;
      const data = parsed.data;
      const organicSegment = data.organicSegment ?? data.segment;
      return fact(observation, runId, {
        kind: observation.kind,
        startDate: data.startDate,
        endDate: data.endDate,
        idSite: data.idSite,
        idGoal: data.idGoal,
        segment: data.segment,
        organicSegment,
      }, [data.startDate, data.endDate, data.idSite, data.idGoal, data.segment], data.startDate, data.endDate, [
        matomoOrganicWindowKey(data.startDate, data.endDate, data.idSite, organicSegment),
        matomoConversionWindowKey(
          data.startDate,
          data.endDate,
          data.idSite,
          data.idGoal,
          data.segment,
        ),
      ]);
    }
    default:
      return null;
  }
}

function scopedFacts(input: z.infer<typeof metricsInputSchema>) {
  const parsedRuns: Array<{ run: z.infer<typeof runSchema>; facts: ParsedFact[] }> = [];
  const snapshotRunIds = latestSnapshotRunIds(input);
  for (const run of input.runs) {
    if (run.status !== "succeeded" || !exactScope(run, input.scope)) continue;
    if (
      (run.source === "siteone" || run.source === "unlighthouse") &&
      !snapshotRunIds.has(run.id)
    ) continue;
    const facts = run.observations.flatMap((observation) => {
      if (!sourceAllowsKind(run.source, observation.kind)) return [];
      const parsed = parseFact(observation, run.id);
      return parsed === null ? [] : [parsed];
    });
    const searchSummaries = facts.filter((fact): fact is ParsedFact & {
      value: Extract<ParsedValue, { kind: "search_console.sync_summary" }>;
    } => fact.value.kind === "search_console.sync_summary");
    if (searchSummaries.length === 1) {
      const [summary] = searchSummaries;
      for (const fact of facts) {
        if (fact.value.kind === "search_console.search_analytics") {
          fact.windowKeys = [...summary.windowKeys];
        }
      }
    }
    parsedRuns.push({ run, facts });
  }

  const latestWindowRuns = new Map<string, z.infer<typeof runSchema>>();
  for (const { run, facts } of parsedRuns) {
    for (const fact of facts) {
      for (const windowKey of fact.windowKeys) {
        const existing = latestWindowRuns.get(windowKey);
        if (
          existing === undefined ||
          runCompletion(run) > runCompletion(existing) ||
          (runCompletion(run) === runCompletion(existing) && run.id < existing.id)
        ) latestWindowRuns.set(windowKey, run);
      }
    }
  }

  const deduped = new Map<string, ParsedFact>();
  for (const { run, facts } of parsedRuns) {
    for (const fact of facts) {
      if (fact.windowKeys.some((windowKey) => latestWindowRuns.get(windowKey)?.id !== run.id)) {
        continue;
      }
      const existing = deduped.get(fact.semanticKey);
      if (
        existing === undefined ||
        fact.observedAt > existing.observedAt ||
        (fact.observedAt === existing.observedAt && fact.id < existing.id)
      ) {
        deduped.set(fact.semanticKey, fact);
      }
    }
  }
  return [...deduped.values()].sort((left, right) =>
    left.semanticKey.localeCompare(right.semanticKey) || left.id.localeCompare(right.id)
  );
}

function matomoWindowError(
  facts: readonly (ParsedFact & {
    value: Extract<ParsedValue, { kind: "organic_visit" | "conversion" }>;
  })[],
) {
  const definitions = new Set(facts.map(({ value }) =>
    value.kind === "conversion"
      ? keyed([value.idSite, value.idGoal, value.segment])
      : keyed([value.idSite, value.segment])
  ));
  if (definitions.size > 1) return "mixed_source_definitions";
  const windows = [...new Map(facts.map(({ value }) => [
    keyed([value.startDate, value.endDate]),
    { start: value.startDate, end: value.endDate },
  ])).values()].sort((left, right) =>
    left.start.localeCompare(right.start) || left.end.localeCompare(right.end)
  );
  for (let index = 1; index < windows.length; index += 1) {
    if (windows[index]!.start <= windows[index - 1]!.end) {
      return "overlapping_source_windows";
    }
  }
  return null;
}

export function calculateRate(numerator: number, denominator: number) {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator < 0 ||
    denominator <= 0 ||
    numerator > denominator
  ) return null;
  const result = numerator / denominator;
  return Number.isFinite(result) && result >= 0 && result <= 1 ? result : null;
}

export function priority(input: SeoPriorityInputs): number | null {
  const values = [
    input.businessValue,
    input.expectedImpact,
    input.confidence,
    input.estimatedEffort,
  ];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    input.businessValue < 0 || input.businessValue > 5 ||
    input.expectedImpact < 0 || input.expectedImpact > 5 ||
    input.confidence < 0 || input.confidence > 5 ||
    input.estimatedEffort <= 0 || input.estimatedEffort > 5
  ) return null;
  const result = input.businessValue * input.expectedImpact * input.confidence /
    input.estimatedEffort;
  return Number.isFinite(result) ? result : null;
}

function factsOfKind<K extends ParsedValue["kind"]>(
  facts: readonly ParsedFact[],
  kind: K,
): Array<ParsedFact & { value: Extract<ParsedValue, { kind: K }> }> {
  return facts.filter(
    (candidate): candidate is ParsedFact & { value: Extract<ParsedValue, { kind: K }> } =>
      candidate.value.kind === kind,
  );
}

function uniqueFacts(facts: readonly ParsedFact[]) {
  const byId = new Map(facts.map((item) => [item.id, item]));
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function range(values: readonly string[]) {
  if (values.length === 0) return null;
  const ordered = [...values].sort();
  return { start: ordered[0]!, end: ordered[ordered.length - 1]! };
}

function result(
  scope: SeoOwnershipScope,
  name: SeoMetricName,
  value: number | null,
  definition: string,
  aggregation: string,
  evidence: readonly ParsedFact[],
  inputs: Record<string, number | string | boolean | null>,
  unavailableReason = "no_valid_observations",
): SeoMetricResult {
  const facts = uniqueFacts(evidence);
  const safeValue = value !== null && Number.isFinite(value) ? value : null;
  return {
    name,
    value: safeValue,
    formulaVersion: SEO_FORMULA_VERSION,
    evidenceObservationIds: facts.map(({ id }) => id),
    dimensions: {
      scope: { ...scope },
      definition,
      aggregation,
      availability: safeValue === null
        ? { status: "unavailable", reason: unavailableReason }
        : { status: "available" },
      sourceRunIds: [...new Set(facts.map(({ runId }) => runId))].sort(),
      sourceDates: range(facts.flatMap(({ sourceStartDate, sourceEndDate }) => [
        sourceStartDate,
        sourceEndDate,
      ])),
      observedAt: range(facts.map(({ observedAt }) => observedAt)),
      dedupePolicy: DEDUPE_POLICY,
      inputs,
    },
  };
}

function mean(values: readonly number[]) {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  const average = total / values.length;
  return Number.isFinite(average) ? average : null;
}

function averageMetric<K extends ParsedValue["kind"]>(
  scope: SeoOwnershipScope,
  facts: readonly ParsedFact[],
  kind: K,
  name: SeoMetricName,
  definition: string,
  valueOf: (value: Extract<ParsedValue, { kind: K }>) => number,
) {
  const matching = factsOfKind(facts, kind);
  return result(
    scope,
    name,
    mean(matching.map(({ value }) => valueOf(value))),
    definition,
    "mean_per_sampled_template_url",
    matching,
    { samples: matching.length },
  );
}

export function calculateSeoMetrics(value: unknown): SeoMetricResult[] {
  const parsed = metricsInputSchema.safeParse(value);
  if (!parsed.success) throw new SeoMetricsInputError();
  const { scope } = parsed.data;
  const facts = scopedFacts(parsed.data);
  const http = factsOfKind(facts, "siteone.http_status");
  const indexability = factsOfKind(facts, "siteone.indexability");
  const canonical = factsOfKind(facts, "siteone.canonical_mismatch");
  const titles = factsOfKind(facts, "siteone.title");
  const headings = factsOfKind(facts, "siteone.heading");
  const structuredData = factsOfKind(facts, "siteone.structured_data");
  const brokenLinks = factsOfKind(facts, "siteone.broken_link");
  const indexableSubjects = new Set(indexability.map(({ subject }) => subject));
  const titleBySubject = new Map(titles.map((item) => [item.subject, item]));
  const headingBySubject = new Map(headings.map((item) => [item.subject, item]));
  const structuredSubjects = new Set(structuredData.map(({ subject }) => subject));

  const crawlNumerator = http.filter(({ value }) =>
    value.statusCode >= 200 && value.statusCode < 400
  ).length;
  const crawlRate = calculateRate(crawlNumerator, http.length);
  const indexNumerator = indexability.filter(({ value }) => value.indexable).length;
  const indexRate = calculateRate(indexNumerator, indexability.length);
  const canonicalMismatchCount = canonical.reduce((sum, item) => sum + item.value.count, 0);
  const canonicalMismatchRate = canonical.length === 0
    ? null
    : calculateRate(canonicalMismatchCount, http.length);
  const canonicalHealth = canonicalMismatchRate === null ? null : 1 - canonicalMismatchRate;
  const titleNumerator = [...indexableSubjects].filter((subject) =>
    (titleBySubject.get(subject)?.value.text.trim().length ?? 0) > 0
  ).length;
  const titleRate = calculateRate(titleNumerator, indexableSubjects.size);
  const headingNumerator = [...indexableSubjects].filter((subject) => {
    const heading = headingBySubject.get(subject)?.value;
    return heading !== undefined && heading.count > 0 && heading.errorCount === 0;
  }).length;
  const headingRate = calculateRate(headingNumerator, indexableSubjects.size);
  const structuredNumerator = [...indexableSubjects].filter((subject) =>
    structuredSubjects.has(subject)
  ).length;
  const structuredRate = calculateRate(structuredNumerator, indexableSubjects.size);
  const crawledSubjects = new Set(http.map(({ subject }) => subject));
  const brokenSourceSubjects = new Set(brokenLinks.map(({ value }) => value.sourceUrl)
    .filter((sourceUrl) => crawledSubjects.has(sourceUrl)));
  const unmatchedBrokenLinkSources = brokenLinks.some(({ value }) =>
    !crawledSubjects.has(value.sourceUrl)
  );
  const brokenRate = unmatchedBrokenLinkSources
    ? null
    : calculateRate(brokenSourceSubjects.size, crawledSubjects.size);

  const metrics: SeoMetricResult[] = [
    result(scope, SEO_METRIC_NAMES.CRAWL_SUCCESS_RATE, crawlRate,
      "count(http status 200-399) / count(valid crawled URLs)", "latest_siteone_crawl", http,
      { numerator: crawlNumerator, denominator: http.length }),
    result(scope, SEO_METRIC_NAMES.INDEXABILITY_RATE, indexRate,
      "count(indexable URLs) / count(URLs with indexability facts)", "latest_siteone_crawl", indexability,
      { numerator: indexNumerator, denominator: indexability.length }),
    result(scope, SEO_METRIC_NAMES.CANONICAL_HEALTH_RATE, canonicalHealth,
      "1 - canonical mismatch count / count(valid crawled URLs)", "latest_siteone_crawl",
      [...http, ...canonical],
      { mismatchCount: canonicalMismatchCount, denominator: http.length },
      canonical.length === 0 ? "no_valid_observations" : "invalid_percentage_inputs"),
    result(scope, SEO_METRIC_NAMES.TITLE_COMPLETENESS_RATE, titleRate,
      "count(crawled subjects with non-empty title) / count(crawled indexability subjects)",
      "latest_siteone_crawl", [...indexability, ...titles],
      { numerator: titleNumerator, denominator: indexableSubjects.size }),
    result(scope, SEO_METRIC_NAMES.HEADING_COMPLETENESS_RATE, headingRate,
      "count(crawled subjects with headings and zero heading errors) / count(crawled indexability subjects)",
      "latest_siteone_crawl", [...indexability, ...headings],
      { numerator: headingNumerator, denominator: indexableSubjects.size }),
    result(scope, SEO_METRIC_NAMES.STRUCTURED_DATA_COVERAGE_RATE, structuredRate,
      "count(crawled subjects with structured data) / count(crawled indexability subjects)",
      "latest_siteone_crawl", [...indexability, ...structuredData],
      { numerator: structuredNumerator, denominator: indexableSubjects.size }),
    result(scope, SEO_METRIC_NAMES.BROKEN_LINK_RATE, brokenRate,
      "count(unique crawled source pages with one or more broken links) / count(valid crawled URLs)",
      "latest_siteone_crawl", [...http, ...brokenLinks],
      { numerator: brokenSourceSubjects.size, denominator: crawledSubjects.size },
      unmatchedBrokenLinkSources
        ? "unmatched_broken_link_source"
        : "no_valid_observations"),
    averageMetric(scope, facts, "unlighthouse.performance",
      SEO_METRIC_NAMES.LIGHTHOUSE_PERFORMANCE_SCORE, "mean sampled Lighthouse performance score", (item) => item.score),
    averageMetric(scope, facts, "unlighthouse.accessibility",
      SEO_METRIC_NAMES.LIGHTHOUSE_ACCESSIBILITY_SCORE, "mean sampled Lighthouse accessibility score", (item) => item.score),
    averageMetric(scope, facts, "unlighthouse.best_practices",
      SEO_METRIC_NAMES.LIGHTHOUSE_BEST_PRACTICES_SCORE, "mean sampled Lighthouse best-practices score", (item) => item.score),
    averageMetric(scope, facts, "unlighthouse.seo",
      SEO_METRIC_NAMES.LIGHTHOUSE_SEO_SCORE, "mean sampled Lighthouse SEO score", (item) => item.score),
    averageMetric(scope, facts, "unlighthouse.lcp",
      SEO_METRIC_NAMES.LIGHTHOUSE_LCP_MS, "mean sampled Lighthouse largest-contentful-paint milliseconds", (item) => item.milliseconds),
    averageMetric(scope, facts, "unlighthouse.cls",
      SEO_METRIC_NAMES.LIGHTHOUSE_CLS_SCORE, "mean sampled Lighthouse cumulative-layout-shift score", (item) => item.score),
  ];

  const inp = factsOfKind(facts, "unlighthouse.inp").filter(({ value: item }) =>
    item.metric === "interaction-to-next-paint" && !item.fallback
  );
  metrics.push(result(scope, SEO_METRIC_NAMES.LIGHTHOUSE_INP_MS,
    mean(inp.map(({ value: item }) => item.milliseconds)),
    "mean sampled Lighthouse interaction-to-next-paint milliseconds; TBT fallbacks are excluded",
    "mean_per_sampled_template_url", inp, { samples: inp.length }));

  const search = factsOfKind(facts, "search_console.search_analytics");
  const searchSummaries = factsOfKind(facts, "search_console.sync_summary");
  const searchEvidence = [...search, ...searchSummaries];
  const clicks = search.reduce((sum, item) => sum + item.value.clicks, 0);
  const impressions = search.reduce((sum, item) => sum + item.value.impressions, 0);
  const searchCtr = search.length === 0 ? null : calculateRate(clicks, impressions);
  const weightedPositions = search.filter(({ value: item }) => item.impressions > 0);
  const weightedPositionNumerator = weightedPositions.reduce(
    (sum, item) => sum + item.value.position * item.value.impressions,
    0,
  );
  const weightedPositionDenominator = weightedPositions.reduce(
    (sum, item) => sum + item.value.impressions,
    0,
  );
  const averagePosition = weightedPositionDenominator > 0
    ? weightedPositionNumerator / weightedPositionDenominator
    : null;
  const searchDimensions = "search_console_final_top_rows";
  metrics.push(
    result(scope, SEO_METRIC_NAMES.SEARCH_CONSOLE_CLICKS,
      search.length === 0 ? null : clicks, "sum(clicks)", searchDimensions, searchEvidence,
      { rows: search.length }, search.length === 0 && searchSummaries.length > 0
        ? "no_observations_in_latest_source_window"
        : "no_valid_observations"),
    result(scope, SEO_METRIC_NAMES.SEARCH_CONSOLE_IMPRESSIONS,
      search.length === 0 ? null : impressions, "sum(impressions)", searchDimensions, searchEvidence,
      { rows: search.length }, search.length === 0 && searchSummaries.length > 0
        ? "no_observations_in_latest_source_window"
        : "no_valid_observations"),
    result(scope, SEO_METRIC_NAMES.SEARCH_CONSOLE_CTR, searchCtr,
      "sum(clicks) / sum(impressions)", searchDimensions, searchEvidence,
      { numerator: clicks, denominator: impressions },
      search.length === 0 && searchSummaries.length > 0
        ? "no_observations_in_latest_source_window"
        : search.length === 0
        ? "no_valid_observations"
        : "invalid_percentage_inputs"),
    result(scope, SEO_METRIC_NAMES.SEARCH_CONSOLE_AVERAGE_POSITION,
      Number.isFinite(averagePosition) ? averagePosition : null,
      "impression-weighted mean(position)", searchDimensions,
      weightedPositions.length > 0 ? [...weightedPositions, ...searchSummaries] : searchEvidence,
      { numerator: weightedPositionNumerator, denominator: weightedPositionDenominator },
      search.length === 0 && searchSummaries.length > 0
        ? "no_observations_in_latest_source_window"
        : "no_valid_observations"),
  );

  const organic = factsOfKind(facts, "organic_visit");
  const conversions = factsOfKind(facts, "conversion");
  const matomoSummaries = factsOfKind(facts, "matomo.sync_summary");
  const organicEvidence = [...organic, ...matomoSummaries];
  const conversionEvidence = [...conversions, ...matomoSummaries];
  const organicWindowError = matomoWindowError(organic);
  const conversionWindowError = matomoWindowError(conversions);
  metrics.push(
    result(scope, SEO_METRIC_NAMES.ORGANIC_VISITS,
      organic.length === 0 || organicWindowError !== null
        ? null
        : organic.reduce((sum, item) => sum + item.value.count, 0),
      "sum(Matomo organic visits)", "sum_per_final_matomo_date_window", organicEvidence,
      { rows: organic.length }, organicWindowError ?? (
        organic.length === 0 && matomoSummaries.length > 0
          ? "no_observations_in_latest_source_window"
          : "no_valid_observations"
      )),
    result(scope, SEO_METRIC_NAMES.CONVERSIONS,
      conversions.length === 0 || conversionWindowError !== null
        ? null
        : conversions.reduce((sum, item) => sum + item.value.count, 0),
      "sum(Matomo goal conversions)", "sum_per_final_matomo_date_window", conversionEvidence,
      { rows: conversions.length }, conversionWindowError ?? (
        conversions.length === 0 && matomoSummaries.length > 0
          ? "no_observations_in_latest_source_window"
          : "no_valid_observations"
      )),
  );

  return metrics;
}
