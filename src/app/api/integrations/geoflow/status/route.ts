import { NextResponse } from "next/server";
import { GeoFlowClient } from "@/lib/geoflow/client";
import { readGeoFlowConfig } from "@/lib/geoflow/config";
import { PrismaGeoFlowBridgeRepository } from "@/lib/geoflow/repository";
import { getBasicAuthConfig } from "@/lib/basic-auth";
import { isDatabaseConfigured } from "@/lib/prisma";
import type { GeoFlowTaskLinkView } from "@/types/geo";

export const dynamic = "force-dynamic";

const DEFAULT_STATUS_TIMEOUT_MS = 2500;

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function GET() {
  const databaseConfigured = isDatabaseConfigured();
  const configResult = readGeoFlowConfig();
  const authConfig = getBasicAuthConfig();
  const geoFlowStatusTimeoutMs = parsePositiveInt(
    process.env.GEOFLOW_STATUS_TIMEOUT_MS,
    DEFAULT_STATUS_TIMEOUT_MS,
  );

  const databaseCheck = databaseConfigured
    ? new PrismaGeoFlowBridgeRepository()
        .listLinks()
        .then((links) => ({
          databaseReachable: true,
          databaseError: null as string | null,
          links,
        }))
        .catch((error: unknown) => ({
          databaseReachable: false,
          databaseError: error instanceof Error ? error.message : "Could not read bridge links.",
          links: [] as GeoFlowTaskLinkView[],
        }))
    : Promise.resolve({
        databaseReachable: false,
        databaseError: "DATABASE_URL is not configured.",
        links: [] as GeoFlowTaskLinkView[],
      });

  const catalogCheck = configResult.config
    ? new GeoFlowClient(configResult.config, fetch, { timeoutMs: geoFlowStatusTimeoutMs })
        .getCatalog()
        .then(() => ({
          catalogReachable: true,
          catalogError: null as string | null,
        }))
        .catch((error: unknown) => ({
          catalogReachable: false,
          catalogError: error instanceof Error ? error.message : "GEOFlow catalog check failed.",
        }))
    : Promise.resolve({
        catalogReachable: false,
        catalogError: configResult.missing.length
          ? `Missing: ${configResult.missing.join(", ")}`
          : null,
      });

  const [database, catalog] = await Promise.all([databaseCheck, catalogCheck]);

  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    databaseConfigured,
    databaseReachable: database.databaseReachable,
    databaseError: database.databaseError,
    geoFlowConfigured: configResult.ok,
    missing: [...(databaseConfigured ? [] : ["DATABASE_URL"]), ...configResult.missing],
    catalogReachable: catalog.catalogReachable,
    catalogError: catalog.catalogError,
    geoFlowStatusTimeoutMs,
    auth: {
      enabled: authConfig.enabled,
      actionHeaderRequired: authConfig.requireActionHeader,
      maxAttempts: authConfig.maxAttempts,
      windowSeconds: authConfig.windowSeconds,
    },
    postizConfigured: Boolean(process.env.POSTIZ_WEBHOOK_URL),
    links: database.links,
  });
}
