import { NextResponse } from "next/server";
import { GeoFlowClient } from "@/lib/geoflow/client";
import { readGeoFlowConfig } from "@/lib/geoflow/config";
import { PrismaGeoFlowBridgeRepository } from "@/lib/geoflow/repository";
import { getBasicAuthConfig } from "@/lib/basic-auth";
import { isDatabaseConfigured } from "@/lib/prisma";
import type { GeoFlowTaskLinkView } from "@/types/geo";

export const dynamic = "force-dynamic";

export async function GET() {
  const databaseConfigured = isDatabaseConfigured();
  const configResult = readGeoFlowConfig();
  const authConfig = getBasicAuthConfig();
  let catalogReachable = false;
  let catalogError: string | null = null;
  let links: GeoFlowTaskLinkView[] = [];

  if (databaseConfigured) {
    try {
      links = await new PrismaGeoFlowBridgeRepository().listLinks();
    } catch (error) {
      catalogError = error instanceof Error ? error.message : "Could not read bridge links.";
    }
  }

  if (configResult.config) {
    try {
      await new GeoFlowClient(configResult.config).getCatalog();
      catalogReachable = true;
    } catch (error) {
      catalogError = error instanceof Error ? error.message : "GEOFlow catalog check failed.";
    }
  }

  return NextResponse.json({
    databaseConfigured,
    geoFlowConfigured: configResult.ok,
    missing: [...(databaseConfigured ? [] : ["DATABASE_URL"]), ...configResult.missing],
    catalogReachable,
    catalogError,
    auth: {
      enabled: authConfig.enabled,
      actionHeaderRequired: authConfig.requireActionHeader,
      maxAttempts: authConfig.maxAttempts,
      windowSeconds: authConfig.windowSeconds,
    },
    postizConfigured: Boolean(process.env.POSTIZ_WEBHOOK_URL),
    links,
  });
}
