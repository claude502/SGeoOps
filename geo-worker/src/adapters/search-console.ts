import {
  analysisEnvelopeSchema,
  type AnalysisEnvelope,
  type NormalizedObservation,
} from "@sgeo/analysis-contract";

import {
  SEARCH_CONSOLE_DATA_STATE,
  SEARCH_CONSOLE_DIMENSIONS,
  SEARCH_CONSOLE_ROW_LIMIT,
  SearchConsoleClient,
  type SearchConsolePage,
  type SearchConsoleQueryRequest,
} from "../clients/search-console";
import {
  encodeSearchConsoleArtifact,
  SEARCH_CONSOLE_ARTIFACT_MAGIC,
  SEARCH_CONSOLE_ARTIFACT_MAX_BYTES,
  SEARCH_CONSOLE_ARTIFACT_MAX_PAGES,
  SEARCH_CONSOLE_ARTIFACT_PAGE_HEADER_BYTES,
  SearchConsoleArtifactCapacityError,
  searchConsoleResponseByteBudget,
  type SearchConsoleArtifactPage,
} from "../search-console/artifact";

export const SEARCH_CONSOLE_SOURCE = "search-console";
export const SEARCH_CONSOLE_SOURCE_VERSION = "webmasters-v3";
export const SEARCH_CONSOLE_ADAPTER_VERSION = "1.0.0";
export const SEARCH_CONSOLE_ARTIFACT_NAME = "search-console-pages-v1.bin";
export const SEARCH_CONSOLE_ARTIFACT_MEDIA_TYPE = "application/vnd.sgeo.search-console-pages.v1";
export const SEARCH_CONSOLE_MAX_PROVIDER_PAGES = SEARCH_CONSOLE_ARTIFACT_MAX_PAGES;
export const SEARCH_CONSOLE_MAX_ROWS = SEARCH_CONSOLE_MAX_PROVIDER_PAGES * SEARCH_CONSOLE_ROW_LIMIT;
export const SEARCH_CONSOLE_MAX_RAW_BYTES = SEARCH_CONSOLE_ARTIFACT_MAX_BYTES;
export const SEARCH_CONSOLE_MAX_ENVELOPE_BYTES = 1_024 * 1_024;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_PROPERTY_LENGTH = 2_048;
const MAX_DATE_RANGE_DAYS = 366;

export interface SearchConsoleInput {
  runId: string;
  clientId: string;
  brandId: string;
  siteId: string;
  siteMarketId: string | null;
  integrationId: string;
  property: string;
  startDate: string;
  endDate: string;
}

export interface SearchConsoleExecution {
  envelope: AnalysisEnvelope;
  rawReport: Uint8Array | null;
}

export class SearchConsoleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchConsoleInputError";
  }
}

export class SearchConsoleExecutionError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "SearchConsoleExecutionError";
    this.retryable = retryable;
  }
}

export type SearchConsoleQueryClient = Pick<SearchConsoleClient, "query">;

type SearchConsoleDependencies = {
  client?: SearchConsoleQueryClient;
  query?: SearchConsoleQueryClient["query"];
  maximumProviderPages?: number;
  maximumRows?: number;
  maximumRawBytes?: number;
  maximumEnvelopeBytes?: number;
};

type SearchConsoleRow = {
  date: string;
  query: string;
  page: string;
  country: string;
  device: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  startRow: number;
};

type SearchConsoleParsedPage = {
  rows: SearchConsoleRow[];
  incomplete: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string") throw new SearchConsoleInputError(`${name} must be a string.`);
  return value;
}

function boundedIdentifier(value: string, name: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new SearchConsoleInputError(`${name} must be a bounded identifier.`);
  }
}

function parseDate(value: string, name: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new SearchConsoleInputError(`${name} must be a YYYY-MM-DD Pacific date.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new SearchConsoleInputError(`${name} must be a real YYYY-MM-DD Pacific date.`);
  }
  return parsed;
}

function validateProperty(value: string) {
  if (value.length === 0 || value.length > MAX_PROPERTY_LENGTH || /[\u0000-\u001f\u007f\s]/.test(value)) {
    throw new SearchConsoleInputError("property must be a bounded Search Console property.");
  }
  if (value.startsWith("sc-domain:")) {
    const domain = value.slice("sc-domain:".length);
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) {
      throw new SearchConsoleInputError("property must be a valid sc-domain property.");
    }
    return value;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SearchConsoleInputError("property must be a URL-prefix or sc-domain property.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new SearchConsoleInputError("property must be a credential-free URL-prefix or sc-domain property.");
  }
  return parsed.toString();
}

/** Parses the externally supplied Trigger payload before any provider call. */
export function parseSearchConsoleInput(value: unknown): SearchConsoleInput {
  const record = asRecord(value);
  if (record === null) throw new SearchConsoleInputError("Search Console task input must be an object.");
  const expectedKeys = [
    "brandId",
    "clientId",
    "endDate",
    "integrationId",
    "property",
    "runId",
    "siteId",
    "siteMarketId",
    "startDate",
  ];
  if (Object.keys(record).sort().join("\u0000") !== expectedKeys.join("\u0000")) {
    throw new SearchConsoleInputError("Search Console task input contains unexpected or missing fields.");
  }
  if (record.siteMarketId !== null && typeof record.siteMarketId !== "string") {
    throw new SearchConsoleInputError("siteMarketId must be a string or null.");
  }
  const input: SearchConsoleInput = {
    runId: requiredString(record.runId, "runId"),
    clientId: requiredString(record.clientId, "clientId"),
    brandId: requiredString(record.brandId, "brandId"),
    siteId: requiredString(record.siteId, "siteId"),
    siteMarketId: record.siteMarketId,
    integrationId: requiredString(record.integrationId, "integrationId"),
    property: requiredString(record.property, "property"),
    startDate: requiredString(record.startDate, "startDate"),
    endDate: requiredString(record.endDate, "endDate"),
  };
  boundedIdentifier(input.runId, "runId");
  boundedIdentifier(input.clientId, "clientId");
  boundedIdentifier(input.brandId, "brandId");
  boundedIdentifier(input.siteId, "siteId");
  if (input.siteMarketId !== null) boundedIdentifier(input.siteMarketId, "siteMarketId");
  boundedIdentifier(input.integrationId, "integrationId");
  input.property = validateProperty(input.property);
  const start = parseDate(input.startDate, "startDate");
  const end = parseDate(input.endDate, "endDate");
  if (start > end || (end.getTime() - start.getTime()) / 86_400_000 > MAX_DATE_RANGE_DAYS) {
    throw new SearchConsoleInputError("Search Console date range is invalid or exceeds the bounded sync window.");
  }
  return input;
}

function finiteNonnegative(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseRow(
  value: unknown,
  startRow: number,
  requestedStartDate: string,
  requestedEndDate: string,
): SearchConsoleRow | null {
  const row = asRecord(value);
  if (row === null || !Array.isArray(row.keys) || row.keys.length !== SEARCH_CONSOLE_DIMENSIONS.length) {
    return null;
  }
  if (!row.keys.every((key) => typeof key === "string" && key.length > 0 && !/[\u0000-\u001f\u007f]/.test(key))) {
    return null;
  }
  const [date, query, page, country, device] = row.keys as string[];
  try {
    parseDate(date!, "row date");
    if (date! < requestedStartDate || date! > requestedEndDate) return null;
    const pageUrl = new URL(page!);
    if ((pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") || pageUrl.username || pageUrl.password) {
      return null;
    }
  } catch {
    return null;
  }
  const clicks = finiteNonnegative(row.clicks);
  const impressions = finiteNonnegative(row.impressions);
  const ctr = finiteNonnegative(row.ctr);
  const position = finiteNonnegative(row.position);
  if (
    clicks === null || !Number.isInteger(clicks) ||
    impressions === null || !Number.isInteger(impressions) ||
    ctr === null || ctr > 1 || position === null
  ) {
    return null;
  }
  return {
    date: date!,
    query: query!,
    page: page!,
    country: country!,
    device: device!,
    clicks,
    impressions,
    ctr,
    position,
    startRow,
  };
}

function parsePage(
  value: unknown,
  startRow: number,
  requestedStartDate: string,
  requestedEndDate: string,
): SearchConsoleParsedPage | null {
  const body = asRecord(value);
  if (body === null) return null;
  const aggregationTypes = new Set(["auto", "byNewsShowcasePanel", "byPage", "byProperty"]);
  if (
    body.responseAggregationType !== undefined &&
    (typeof body.responseAggregationType !== "string" || !aggregationTypes.has(body.responseAggregationType))
  ) {
    return null;
  }
  const metadata = body.metadata === undefined ? null : asRecord(body.metadata);
  if (body.metadata !== undefined && metadata === null) return null;
  let incomplete = false;
  for (const field of ["first_incomplete_date", "first_incomplete_hour"] as const) {
    const marker = metadata?.[field];
    if (marker !== undefined) {
      if (typeof marker !== "string" || marker.length === 0) return null;
      incomplete = true;
    }
  }
  if (body.rows === undefined) return { rows: [], incomplete };
  if (!Array.isArray(body.rows)) return null;
  const rows = body.rows.map((row) => parseRow(
    row,
    startRow,
    requestedStartDate,
    requestedEndDate,
  ));
  return rows.some((row) => row === null)
    ? null
    : { rows: rows as SearchConsoleRow[], incomplete };
}

function rawBundle(pages: readonly SearchConsoleArtifactPage[], maximumBytes: number) {
  return encodeSearchConsoleArtifact(pages, maximumBytes);
}

function baseEnvelope(
  input: SearchConsoleInput,
  startedAt: string,
  status: AnalysisEnvelope["status"],
  observations: NormalizedObservation[],
  error: AnalysisEnvelope["error"],
) {
  return analysisEnvelopeSchema.parse({
    contractVersion: "1",
    runId: input.runId,
    clientId: input.clientId,
    brandId: input.brandId,
    siteId: input.siteId,
    siteMarketId: input.siteMarketId,
    source: SEARCH_CONSOLE_SOURCE,
    sourceVersion: SEARCH_CONSOLE_SOURCE_VERSION,
    adapterVersion: SEARCH_CONSOLE_ADAPTER_VERSION,
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    rawArtifact: null,
    observations,
    error,
  });
}

function failedEnvelope(
  input: SearchConsoleInput,
  startedAt: string,
  code: string,
  message: string,
  retryable: boolean,
) {
  return baseEnvelope(input, startedAt, "failed", [], { code, message, retryable });
}

function observation(row: SearchConsoleRow, pagesFetched: number): NormalizedObservation {
  return {
    kind: "search_console.search_analytics",
    subject: row.page,
    observedAt: new Date().toISOString(),
    value: {
      date: row.date,
      query: row.query,
      page: row.page,
      country: row.country,
      device: row.device,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
      dataState: SEARCH_CONSOLE_DATA_STATE,
      scope: "top_rows",
      pagination: {
        rowLimit: SEARCH_CONSOLE_ROW_LIMIT,
        startRow: row.startRow,
        pagesFetched,
        truncated: true,
      },
    },
  };
}

function summary(
  rowsFetched: number,
  rowsIncluded: number,
  pagesFetched: number,
): NormalizedObservation {
  return {
    kind: "search_console.sync_summary",
    subject: "search-console",
    observedAt: new Date().toISOString(),
    value: {
      scope: "top_rows",
      dataState: SEARCH_CONSOLE_DATA_STATE,
      rowsFetched,
      rowsIncluded,
      pagination: {
        rowLimit: SEARCH_CONSOLE_ROW_LIMIT,
        pagesFetched,
        truncated: true,
      },
    },
  };
}

function setTruncated(observations: NormalizedObservation[], truncated: boolean) {
  for (const fact of observations) {
    const value = fact.value as Record<string, unknown>;
    const pagination = asRecord(value.pagination);
    if (pagination !== null) pagination.truncated = truncated;
  }
}

function envelopeByteSize(envelope: AnalysisEnvelope) {
  return Buffer.byteLength(JSON.stringify(envelope), "utf8");
}

function queryRequest(
  input: SearchConsoleInput,
  startRow: number,
  maximumResponseBytes: number,
): SearchConsoleQueryRequest {
  return {
    startDate: input.startDate,
    endDate: input.endDate,
    dimensions: SEARCH_CONSOLE_DIMENSIONS,
    rowLimit: SEARCH_CONSOLE_ROW_LIMIT,
    startRow,
    dataState: SEARCH_CONSOLE_DATA_STATE,
    maximumResponseBytes,
  };
}

function validatedRawBytes(result: SearchConsolePage) {
  if (!(result.rawBytes instanceof Uint8Array)) {
    throw new SearchConsoleExecutionError("Search Console client returned invalid raw bytes.");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(result.rawBytes);
  } catch {
    throw new SearchConsoleExecutionError("Search Console client returned invalid raw bytes.");
  }
  if (decoded !== result.rawBody) {
    throw new SearchConsoleExecutionError("Search Console client returned inconsistent raw bytes.");
  }
  return result.rawBytes;
}

export async function executeSearchConsole(
  value: SearchConsoleInput,
  dependencies: SearchConsoleDependencies = {},
): Promise<SearchConsoleExecution> {
  const input = parseSearchConsoleInput(value);
  const query = dependencies.query ?? (
    dependencies.client === undefined
      ? undefined
      : (property: string, request: SearchConsoleQueryRequest) => dependencies.client!.query(property, request)
  );
  if (query === undefined) {
    throw new SearchConsoleExecutionError("Search Console client is required.");
  }
  const maximumProviderPages = dependencies.maximumProviderPages ?? SEARCH_CONSOLE_MAX_PROVIDER_PAGES;
  const maximumRows = dependencies.maximumRows ?? SEARCH_CONSOLE_MAX_ROWS;
  const maximumRawBytes = dependencies.maximumRawBytes ?? SEARCH_CONSOLE_MAX_RAW_BYTES;
  const maximumEnvelopeBytes = dependencies.maximumEnvelopeBytes ?? SEARCH_CONSOLE_MAX_ENVELOPE_BYTES;
  if (
    !Number.isInteger(maximumProviderPages) || maximumProviderPages < 1 ||
    maximumProviderPages > SEARCH_CONSOLE_MAX_PROVIDER_PAGES ||
    !Number.isInteger(maximumRows) || maximumRows < 1 || maximumRows > SEARCH_CONSOLE_MAX_ROWS ||
    !Number.isInteger(maximumRawBytes) || maximumRawBytes < 1 ||
    maximumRawBytes > SEARCH_CONSOLE_MAX_RAW_BYTES ||
    !Number.isInteger(maximumEnvelopeBytes) || maximumEnvelopeBytes < 1 ||
    maximumEnvelopeBytes > SEARCH_CONSOLE_MAX_ENVELOPE_BYTES
  ) {
    throw new SearchConsoleInputError("Search Console execution limits are invalid.");
  }
  const maximumResponseBytes = searchConsoleResponseByteBudget(maximumRawBytes, maximumProviderPages);
  if (
    maximumResponseBytes < 1 ||
    maximumRawBytes < SEARCH_CONSOLE_ARTIFACT_MAGIC.byteLength +
      maximumProviderPages * (SEARCH_CONSOLE_ARTIFACT_PAGE_HEADER_BYTES + 1)
  ) {
    throw new SearchConsoleInputError("Search Console execution limits are invalid.");
  }

  const startedAt = new Date().toISOString();
  const rawPages: SearchConsoleArtifactPage[] = [];
  const rows: SearchConsoleRow[] = [];
  let complete = false;
  for (let pageIndex = 0; pageIndex < maximumProviderPages; pageIndex += 1) {
    const startRow = pageIndex * SEARCH_CONSOLE_ROW_LIMIT;
    const result: SearchConsolePage = await query(
      input.property,
      queryRequest(input, startRow, maximumResponseBytes),
    );
    const rawBytes = validatedRawBytes(result);
    if (rawBytes.byteLength > maximumResponseBytes) {
      throw new SearchConsoleExecutionError(
        "Search Console client exceeded the bounded response contract.",
      );
    }
    rawPages.push({ startRow, rawBytes });
    let rawReport: Uint8Array;
    try {
      rawReport = rawBundle(rawPages, maximumRawBytes);
    } catch (error) {
      if (error instanceof SearchConsoleArtifactCapacityError) {
        throw new SearchConsoleExecutionError(
          "Search Console client exceeded the bounded artifact contract.",
        );
      }
      throw error;
    }
    const parsedPage = parsePage(result.value, startRow, input.startDate, input.endDate);
    if (parsedPage === null || parsedPage.rows.length > SEARCH_CONSOLE_ROW_LIMIT) {
      return {
        rawReport,
        envelope: failedEnvelope(
          input,
          startedAt,
          "SEARCH_CONSOLE_INVALID_REPORT",
          "Search Console returned malformed Search Analytics rows.",
          false,
        ),
      };
    }
    if (parsedPage.incomplete) {
      return {
        rawReport,
        envelope: baseEnvelope(input, startedAt, "partial", [], {
          code: "SEARCH_CONSOLE_NON_FINAL_DATA",
          message: "Search Console marked the requested final response as incomplete.",
          retryable: false,
        }),
      };
    }
    const pageRows = parsedPage.rows;
    if (pageRows.length > maximumRows - rows.length) {
      rows.push(...pageRows.slice(0, maximumRows - rows.length));
      break;
    }
    rows.push(...pageRows);
    if (pageRows.length === 0) {
      complete = true;
      break;
    }
  }

  const rawReport = rawBundle(rawPages, maximumRawBytes);
  const facts: NormalizedObservation[] = [];
  let envelopeTruncated = false;
  const providerTruncated = !complete;
  const envelopePartialError = {
    code: providerTruncated
      ? "SEARCH_CONSOLE_PROVIDER_AND_ENVELOPE_TRUNCATED"
      : "SEARCH_CONSOLE_ENVELOPE_TRUNCATED",
    message: providerTruncated
      ? "Search Console pagination and the ingest observation envelope were both truncated."
      : "Search Console top-row observations exceeded the ingest contract byte budget.",
    retryable: false,
  } as const;
  // Estimate each JSON observation once, then validate the final envelope exactly.
  // Re-serializing the whole envelope per provider row would make a 25k page O(n²).
  const summaryOnly = baseEnvelope(
    input,
    startedAt,
    "partial",
    [summary(rows.length, 0, rawPages.length)],
    envelopePartialError,
  );
  let estimatedBytes = envelopeByteSize(summaryOnly);
  const budgetHeadroomBytes = 1_024;
  for (const row of rows) {
    const fact = observation(row, rawPages.length);
    const factBytes = Buffer.byteLength(JSON.stringify(fact), "utf8") + 1;
    if (estimatedBytes + factBytes > maximumEnvelopeBytes - budgetHeadroomBytes) {
      envelopeTruncated = true;
      break;
    }
    facts.push(fact);
    estimatedBytes += factBytes;
  }
  let allFacts = [...facts, summary(rows.length, facts.length, rawPages.length)];
  setTruncated(allFacts, true);
  let partialEnvelope = baseEnvelope(input, startedAt, "partial", allFacts, envelopePartialError);
  while (envelopeByteSize(partialEnvelope) > maximumEnvelopeBytes && facts.length > 0) {
    facts.pop();
    envelopeTruncated = true;
    allFacts = [...facts, summary(rows.length, facts.length, rawPages.length)];
    setTruncated(allFacts, true);
    partialEnvelope = baseEnvelope(input, startedAt, "partial", allFacts, envelopePartialError);
  }
  if (envelopeTruncated) {
    return {
      rawReport,
      envelope: partialEnvelope,
    };
  }
  if (providerTruncated) {
    return {
      rawReport,
      envelope: baseEnvelope(input, startedAt, "partial", allFacts, {
        code: "SEARCH_CONSOLE_PROVIDER_TRUNCATED",
        message: "Search Console pagination reached the bounded provider page limit.",
        retryable: false,
      }),
    };
  }
  setTruncated(allFacts, false);
  return {
    rawReport,
    envelope: baseEnvelope(input, startedAt, "succeeded", allFacts, null),
  };
}

export async function runSearchConsole(
  input: SearchConsoleInput,
  token: string,
  dependencies: Omit<SearchConsoleDependencies, "client" | "query"> = {},
): Promise<AnalysisEnvelope> {
  if (typeof token !== "string" || token.length === 0 || token.length > 64 * 1024) {
    throw new SearchConsoleInputError("Search Console credential is invalid.");
  }
  return (await executeSearchConsole(input, {
    ...dependencies,
    client: new SearchConsoleClient({ token }),
  })).envelope;
}
