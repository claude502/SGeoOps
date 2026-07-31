import { GeoFlowClient, GeoFlowHttpError } from "@/lib/geoflow/client";
import { readGeoFlowConfig } from "@/lib/geoflow/config";
import { GeoFlowBridgeService } from "@/lib/geoflow/bridge-service";
import {
  PrismaGeoFlowBridgeRepository,
  type GeoFlowBridgeRepository,
} from "@/lib/geoflow/repository";
import { isDatabaseConfigured } from "@/lib/prisma";

export class IntegrationConfigError extends Error {
  constructor(
    message: string,
    public readonly missing: string[],
    public readonly status = 500,
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

export function createGeoFlowBridgeService(
  repository: GeoFlowBridgeRepository = new PrismaGeoFlowBridgeRepository(),
) {
  assertDatabaseReady();
  const configResult = readGeoFlowConfig();
  if (!configResult.ok || !configResult.config) {
    throw new IntegrationConfigError(
      `Missing GEOFlow configuration: ${configResult.missing.join(", ")}`,
      configResult.missing,
    );
  }

  return new GeoFlowBridgeService(
    repository,
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
        error: "GEOFlow integration request failed.",
        code: error.code,
      },
      status: error.status === 409 ? 409 : 500,
    };
  }

  return {
    body: { error: error instanceof Error ? error.message : "Integration request failed." },
    status: 500,
  };
}
