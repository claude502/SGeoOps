import { ArrowLeft, Filter } from "lucide-react";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { OpportunityQueue } from "@/components/opportunities/opportunity-queue";
import { BaselineSummary } from "@/components/seo/baseline-summary";
import { ComparisonTable } from "@/components/seo/comparison-table";
import { RunHistory } from "@/components/seo/run-history";
import { SourceCoverage } from "@/components/seo/source-coverage";
import { AuthorizationError, requireAccessScope } from "@/lib/authorization";
import { ScopedOrganizationError } from "@/lib/organization/repository";
import { pathIdSchema } from "@/lib/organization/schemas";
import {
  loadScopedSeoReport,
  parseSeoReportFilters,
  SeoReportRequestError,
} from "@/lib/seo/report-service";
import { SeoReportScopeNotFoundError } from "@/lib/seo/report-queries";

type PageProps = {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const dynamic = "force-dynamic";

function InvalidFilters({ siteId }: { siteId: string }) {
  return (
    <main className="seo-page">
      <header className="seo-page-header">
        <div>
          <p className="clients-eyebrow">SEO operations</p>
          <h1>Invalid report filters</h1>
          <p>Use one valid start and end date, up to 366 days.</p>
        </div>
        <Link className="button button-secondary" href={`/sites/${siteId}/seo`}>
          Reset filters
        </Link>
      </header>
    </main>
  );
}

export default async function SiteSeoPage({ params, searchParams }: PageProps) {
  const rawSiteId = (await params).siteId;
  const parsedSiteId = pathIdSchema.safeParse(rawSiteId);
  if (!parsedSiteId.success || parsedSiteId.data !== rawSiteId) notFound();

  try {
    const access = await requireAccessScope(
      new Request(`http://geo-ops.local/sites/${parsedSiteId.data}/seo`, {
        headers: await headers(),
      }),
    );
    let filters;
    try {
      filters = parseSeoReportFilters(await searchParams);
    } catch (error) {
      if (error instanceof SeoReportRequestError) {
        return <InvalidFilters siteId={parsedSiteId.data} />;
      }
      throw error;
    }
    const result = await loadScopedSeoReport(access, parsedSiteId.data, filters);

    return (
      <main className="seo-page">
        <header className="seo-page-header">
          <div>
            <p className="clients-eyebrow">SEO operations</p>
            <h1>{result.site.name}</h1>
            <p>{result.site.canonicalHost}</p>
          </div>
          <Link className="button button-secondary" href={`/sites/${result.site.id}`}>
            <ArrowLeft aria-hidden="true" size={16} />
            Site overview
          </Link>
        </header>

        <form action={`/sites/${result.site.id}/seo`} className="seo-filter-bar" method="get">
          <label>
            <span>Start</span>
            <input defaultValue={filters.from} name="start" required type="date" />
          </label>
          <label>
            <span>End</span>
            <input defaultValue={filters.to} name="end" required type="date" />
          </label>
          <label>
            <span>Market scope</span>
            <select defaultValue={filters.siteMarketId ?? ""} name="siteMarketId">
              <option value="">Site level only</option>
              {result.markets.map((market) => (
                <option key={market.id} value={market.id}>
                  {market.country} / {market.locale}
                </option>
              ))}
            </select>
          </label>
          <button className="button button-primary" type="submit">
            <Filter aria-hidden="true" size={16} />
            Apply filters
          </button>
        </form>

        {result.report.isEmpty ? (
          <p className="seo-report-empty" role="status">
            No SEO report data for this scope and date range.
          </p>
        ) : null}

        <BaselineSummary report={result.report} />
        <SourceCoverage coverage={result.report.coverage} />
        <ComparisonTable metrics={result.report.metrics} />
        <RunHistory runs={result.report.runs} />
        <OpportunityQueue opportunities={result.report.opportunities} />
      </main>
    );
  } catch (error) {
    if (
      error instanceof AuthorizationError ||
      error instanceof ScopedOrganizationError ||
      error instanceof SeoReportScopeNotFoundError
    ) {
      notFound();
    }
    throw error;
  }
}
