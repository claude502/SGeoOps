import type { AccessScope } from "@/lib/authorization";
import {
  organizationRepository,
  type OrganizationRepository,
  type SeoSiteContext,
} from "@/lib/organization/repository";
import { pathIdSchema } from "@/lib/organization/schemas";
import { toPublicSeoReport, type PublicSeoReport } from "./report-presenter";
import { SeoReportQueries } from "./report-queries";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const MAX_REPORT_DAYS = 366;
const DEFAULT_REPORT_DAYS = 30;
const allowedQueryKeys = new Set(["start", "end", "siteMarketId"]);

export interface SeoReportFilters {
  from: string;
  to: string;
  startAt: string;
  endAt: string;
  siteMarketId: string | null;
}

export interface ScopedSeoReportResult extends SeoSiteContext {
  report: PublicSeoReport;
}

export class SeoReportRequestError extends Error {
  constructor() {
    super("SEO report request is invalid.");
    this.name = "SeoReportRequestError";
  }
}

type PageSearchParams = Record<string, string | string[] | undefined>;

function queryEntries(value: URLSearchParams | PageSearchParams) {
  if (value instanceof URLSearchParams) return [...value.entries()];
  return Object.entries(value).flatMap(([key, item]) =>
    Array.isArray(item)
      ? item.map((entry) => [key, entry] as const)
      : item === undefined ? [] : [[key, item] as const]
  );
}

function isoCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return null;
  }
  return date;
}

function formatUtcDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function parseSeoReportFilters(
  value: URLSearchParams | PageSearchParams,
  now = new Date(),
): SeoReportFilters {
  const grouped = new Map<string, string[]>();
  for (const [key, entry] of queryEntries(value)) {
    if (!allowedQueryKeys.has(key)) throw new SeoReportRequestError();
    const entries = grouped.get(key) ?? [];
    entries.push(entry);
    grouped.set(key, entries);
  }
  if ([...grouped.values()].some((entries) => entries.length !== 1)) {
    throw new SeoReportRequestError();
  }

  const rawStart = grouped.get("start")?.[0];
  const rawEnd = grouped.get("end")?.[0];
  if ((rawStart === undefined) !== (rawEnd === undefined)) {
    throw new SeoReportRequestError();
  }

  let from: string;
  let to: string;
  let startDate: Date;
  let endDate: Date;
  if (rawStart === undefined || rawEnd === undefined) {
    const today = isoCalendarDate(formatUtcDate(now));
    if (today === null) throw new SeoReportRequestError();
    endDate = today;
    startDate = new Date(endDate.getTime() - (DEFAULT_REPORT_DAYS - 1) * DAY_MILLISECONDS);
    from = formatUtcDate(startDate);
    to = formatUtcDate(endDate);
  } else {
    const parsedStart = isoCalendarDate(rawStart);
    const parsedEnd = isoCalendarDate(rawEnd);
    if (parsedStart === null || parsedEnd === null) throw new SeoReportRequestError();
    startDate = parsedStart;
    endDate = parsedEnd;
    from = rawStart;
    to = rawEnd;
  }

  const inclusiveDays = Math.floor((endDate.getTime() - startDate.getTime()) / DAY_MILLISECONDS) + 1;
  if (inclusiveDays < 1 || inclusiveDays > MAX_REPORT_DAYS) {
    throw new SeoReportRequestError();
  }

  const rawMarket = grouped.get("siteMarketId")?.[0];
  let siteMarketId: string | null = null;
  if (rawMarket !== undefined && rawMarket !== "") {
    const parsedMarket = pathIdSchema.safeParse(rawMarket);
    if (!parsedMarket.success || parsedMarket.data !== rawMarket) {
      throw new SeoReportRequestError();
    }
    siteMarketId = parsedMarket.data;
  }

  return {
    from,
    to,
    startAt: `${from}T00:00:00.000Z`,
    endAt: `${to}T23:59:59.999Z`,
    siteMarketId,
  };
}

interface SeoReportServiceDependencies {
  organization: Pick<OrganizationRepository, "getSeoSiteContext">;
  reports: Pick<SeoReportQueries, "getReport">;
  present: typeof toPublicSeoReport;
}

export async function loadScopedSeoReport(
  access: AccessScope,
  siteId: string,
  filters: SeoReportFilters,
  dependencies?: SeoReportServiceDependencies,
): Promise<ScopedSeoReportResult> {
  const resolved = dependencies ?? {
    organization: organizationRepository,
    reports: new SeoReportQueries(),
    present: toPublicSeoReport,
  };
  const context = await resolved.organization.getSeoSiteContext(
    access,
    siteId,
    filters.siteMarketId,
  );
  const internalReport = await resolved.reports.getReport(access, {
    clientId: context.clientId,
    brandId: context.brandId,
    siteId: context.site.id,
    siteMarketId: context.siteMarketId,
    startAt: filters.startAt,
    endAt: filters.endAt,
  });
  return {
    ...context,
    report: resolved.present(internalReport, {
      from: filters.from,
      to: filters.to,
    }),
  };
}
