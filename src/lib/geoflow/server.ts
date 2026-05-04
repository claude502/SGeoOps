import { GeoFlowClient, GeoFlowHttpError } from "@/lib/geoflow/client";
import { readGeoFlowConfig } from "@/lib/geoflow/config";
import { GeoFlowBridgeService } from "@/lib/geoflow/bridge-service";
import { PrismaGeoFlowBridgeRepository } from "@/lib/geoflow/repository";
import { isDatabaseConfigured } from "@/lib/prisma";

export class IntegrationConfigError extends Error {
  constructor(
    message: string,
    public readonly missing: string[],
    public readonly status = 503,
  ) {
    super(message);
    this.name = "IntegrationConfigError";
  }
}

export function assertDatabaseReady() {
  if (!isDatabaseConfigured()) {
    throw new IntegrationConfigError("DATABASE_URL is required for GEOFlow bridge persistence.", [
      "DATABASE_URL",
    ]);
  }
}

export function createGeoFlowBridgeService() {
  assertDatabaseReady();
  const configResult = readGeoFlowConfig();
  if (!configResult.ok || !configResult.config) {
    throw new IntegrationConfigError(
      `Missing GEOFlow configuration: ${configResult.missing.join(", ")}`,
      configResult.missing,
    );
  }

  return new GeoFlowBridgeService(
    new PrismaGeoFlowBridgeRepository(),
    new GeoFlowClient(configResult.config),
    configResult.config,
  );
}

export function integrationErrorResponse(error: unknown) {
  if (error instanceof IntegrationConfigError) {
    return {
      body: { error: error.message, missing: error.missing },
      status: error.status,
    };
  }

  if (error instanceof GeoFlowHttpError) {
    return {
      body: {
        error: error.message,
        code: error.code,
        details: error.details ?? null,
      },
      status: error.status >= 400 ? error.status : 502,
    };
  }

  return {
    body: { error: error instanceof Error ? error.message : "Integration request failed." },
    status: 500,
  };
}
