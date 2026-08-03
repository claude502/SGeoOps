import { NextResponse } from "next/server";

import { requireAccessScope } from "@/lib/authorization";
import { organizationRouteError } from "@/lib/organization/http";
import { ScopedOrganizationError } from "@/lib/organization/repository";
import { pathIdSchema } from "@/lib/organization/schemas";
import {
  loadScopedSeoReport,
  parseSeoReportFilters,
  SeoReportRequestError,
} from "@/lib/seo/report-service";
import {
  SeoReportQueryInputError,
  SeoReportScopeNotFoundError,
} from "@/lib/seo/report-queries";

type RouteContext = {
  params: Promise<{ siteId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const access = await requireAccessScope(request);
    const rawSiteId = (await context.params).siteId;
    const siteId = pathIdSchema.safeParse(rawSiteId);
    if (!siteId.success || siteId.data !== rawSiteId) {
      throw new SeoReportRequestError();
    }
    const filters = parseSeoReportFilters(new URL(request.url).searchParams);
    const result = await loadScopedSeoReport(access, siteId.data, filters);
    return NextResponse.json(result.report);
  } catch (error) {
    if (
      error instanceof SeoReportRequestError ||
      error instanceof SeoReportQueryInputError
    ) {
      return NextResponse.json(
        { error: "Invalid SEO report request" },
        { status: 400 },
      );
    }
    if (
      error instanceof ScopedOrganizationError ||
      error instanceof SeoReportScopeNotFoundError
    ) {
      return NextResponse.json({ error: "Resource not found" }, { status: 404 });
    }
    return organizationRouteError(error);
  }
}
