import { parseMatomoOrigin } from "@/lib/matomo/origin";
import {
  parseSearchConsoleRunId,
  readBoundedJsonBody,
} from "@/lib/search-console/internal-route";

export { readBoundedJsonBody };
export const parseMatomoRunId = parseSearchConsoleRunId;

export type MatomoControlRequestScope = {
  clientId: string;
  brandId: string;
  siteId: string;
  siteMarketId: string | null;
  integrationId: string;
  endpoint: string;
};

function boundedIdentifier(value: unknown) {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)
    ? value
    : null;
}

export function parseMatomoControlRequestScope(
  value: unknown,
): MatomoControlRequestScope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const expectedKeys = [
    "brandId",
    "clientId",
    "endpoint",
    "integrationId",
    "siteId",
    "siteMarketId",
  ];
  if (
    Object.keys(body).sort().join("\u0000") !== expectedKeys.join("\u0000") ||
    (body.siteMarketId !== null && boundedIdentifier(body.siteMarketId) === null)
  ) {
    return null;
  }
  const clientId = boundedIdentifier(body.clientId);
  const brandId = boundedIdentifier(body.brandId);
  const siteId = boundedIdentifier(body.siteId);
  const integrationId = boundedIdentifier(body.integrationId);
  const endpoint = parseMatomoOrigin(body.endpoint);
  if (
    clientId === null ||
    brandId === null ||
    siteId === null ||
    integrationId === null ||
    endpoint === null
  ) {
    return null;
  }
  return {
    clientId,
    brandId,
    siteId,
    siteMarketId: body.siteMarketId as string | null,
    integrationId,
    endpoint,
  };
}
