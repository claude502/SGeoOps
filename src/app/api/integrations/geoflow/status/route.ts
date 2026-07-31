import { NextResponse } from "next/server";
import { requireAccessScope, requireRole } from "@/lib/authorization";
import { businessRouteError } from "@/lib/business/http";
import { GeoFlowClient } from "@/lib/geoflow/client";
import { readGeoFlowConfig } from "@/lib/geoflow/config";
import { ScopedPrismaGeoFlowBridgeRepository } from "@/lib/geoflow/repository";
import { isDatabaseConfigured } from "@/lib/prisma";
import type { GeoFlowTaskLinkView } from "@/types/geo";

export const dynamic = "force-dynamic";

const DEFAULT_STATUS_TIMEOUT_MS = 2500;

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function GET(request: Request) {
  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin", "Operator", "Reviewer", "Viewer"]);
    const databaseConfigured = isDatabaseConfigured();
    const configResult = readGeoFlowConfig();
    const geoFlowStatusTimeoutMs = parsePositiveInt(
      process.env.GEOFLOW_STATUS_TIMEOUT_MS,
      DEFAULT_STATUS_TIMEOUT_MS,
    );

    const databaseCheck = databaseConfigured
      ? new ScopedPrismaGeoFlowBridgeRepository(scope, request)
        .listLinks()
        .then((links) => ({
          databaseReachable: true,
          databaseError: null as string | null,
          links,
        }))
        .catch((error: unknown) => ({
          databaseReachable: false,
          databaseError: "Could not read scoped bridge links.",
          links: [] as GeoFlowTaskLinkView[],
        }))
      : Promise.resolve({
          databaseReachable: false,
          databaseError: "DATABASE_URL is not configured.",
          links: [] as GeoFlowTaskLinkView[],
        });

    const catalogCheck = configResult.config
      ? new GeoFlowClient(configResult.config, fetch, {
          timeoutMs: geoFlowStatusTimeoutMs,
        })
        .getCatalog()
        .then(() => ({
          catalogReachable: true,
          catalogError: null as string | null,
        }))
        .catch((error: unknown) => ({
          catalogReachable: false,
          catalogError: "GEOFlow catalog check failed.",
        }))
      : Promise.resolve({
          catalogReachable: false,
          catalogError: configResult.missing.length
            ? `Missing: ${configResult.missing.join(", ")}`
            : null,
        });

    const [database, catalog] = await Promise.all([
      databaseCheck,
      catalogCheck,
    ]);

    return NextResponse.json(
      {
        checkedAt: new Date().toISOString(),
        databaseConfigured,
        databaseReachable: database.databaseReachable,
        databaseError: database.databaseError,
        geoFlowConfigured: configResult.ok,
        missing: [
          ...(databaseConfigured ? [] : ["DATABASE_URL"]),
          ...configResult.missing,
        ],
        catalogReachable: catalog.catalogReachable,
        catalogError: catalog.catalogError,
        geoFlowStatusTimeoutMs,
        postizConfigured: Boolean(process.env.POSTIZ_WEBHOOK_URL),
        links: database.links,
      },
      { status: database.databaseReachable ? 200 : 500 },
    );
  } catch (error) {
    return businessRouteError(error);
  }
}
