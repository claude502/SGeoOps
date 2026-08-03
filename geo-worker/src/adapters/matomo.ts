import {
  analysisEnvelopeSchema,
  type AnalysisEnvelope,
  type NormalizedObservation,
} from "@sgeo/analysis-contract";

import type { MatomoPage, MatomoReportRequest } from "../clients/matomo";

export const MATOMO_SOURCE = "matomo";
export const MATOMO_SOURCE_VERSION = "reporting-api-v5";
export const MATOMO_ADAPTER_VERSION = "1.0.0";
export const MATOMO_ARTIFACT_NAME = "matomo-reports-v1.bin";
export const MATOMO_ARTIFACT_MEDIA_TYPE = "application/vnd.sgeo.matomo-reports.v1";
export const MATOMO_MAX_RAW_BYTES = 4 * 1024 * 1024;
export const MATOMO_DEFAULT_MAX_ENVELOPE_BYTES = 192 * 1024;

const ARTIFACT_MAGIC = new TextEncoder().encode("SGEO-MATOMO-REPORTS-V1\n");
const MAX_ID_LENGTH = 200;
const MAX_MATOMO_IDENTIFIER = 2_147_483_647;
const MAX_DATE_RANGE_DAYS = 366;
const MAX_SEGMENT_BYTES = 1_024;
const MAX_GOAL_NAME_BYTES = 200;

export interface MatomoInput {
  runId: string;
  clientId: string;
  brandId: string;
  siteId: string;
  siteMarketId: string | null;
  integrationId: string;
  endpoint: string;
  startDate: string;
  endDate: string;
  idSite: number;
  segment: string;
  timezone: string;
  idGoal: number;
  goalName: string;
}

export interface MatomoExecution {
  envelope: AnalysisEnvelope;
  rawReport: Uint8Array;
}

export class MatomoInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatomoInputError";
  }
}

export class MatomoExecutionError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "MatomoExecutionError";
    this.retryable = retryable;
  }
}

type Dependencies = {
  query: (request: MatomoReportRequest) => Promise<MatomoPage>;
  maximumRawBytes?: number;
  maximumEnvelopeBytes?: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function identifier(value: unknown, name: string) {
  if (
    typeof value !== "string" ||
    value.length > MAX_ID_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new MatomoInputError(`${name} must be a bounded identifier.`);
  }
  return value;
}

function date(value: unknown, name: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new MatomoInputError(`${name} must be a YYYY-MM-DD date.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new MatomoInputError(`${name} must be a real date.`);
  }
  return { value, parsed };
}

function validTimezone(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 100 ||
    !/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function validateMatomoOrigin(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new MatomoInputError("endpoint must be an HTTP(S) origin.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MatomoInputError("endpoint must be an HTTP(S) origin.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new MatomoInputError(
      "endpoint must be an HTTP(S) origin without credentials, path, query, or fragment.",
    );
  }
  return parsed.origin;
}

export function parseMatomoInput(value: unknown): MatomoInput {
  const body = record(value);
  const keys = [
    "brandId",
    "clientId",
    "endDate",
    "endpoint",
    "goalName",
    "idGoal",
    "idSite",
    "integrationId",
    "runId",
    "segment",
    "siteId",
    "siteMarketId",
    "startDate",
    "timezone",
  ];
  if (body === null || Object.keys(body).sort().join("\u0000") !== keys.join("\u0000")) {
    throw new MatomoInputError("Matomo task input contains unexpected or missing fields.");
  }
  if (body.siteMarketId !== null && typeof body.siteMarketId !== "string") {
    throw new MatomoInputError("siteMarketId must be a string or null.");
  }
  const start = date(body.startDate, "startDate");
  const end = date(body.endDate, "endDate");
  const dayCount = (end.parsed.getTime() - start.parsed.getTime()) / 86_400_000 + 1;
  if (dayCount < 1 || dayCount > MAX_DATE_RANGE_DAYS) {
    throw new MatomoInputError("Matomo date range is invalid or too large.");
  }
  if (
    !Number.isSafeInteger(body.idSite) ||
    (body.idSite as number) < 1 ||
    (body.idSite as number) > MAX_MATOMO_IDENTIFIER ||
    !Number.isSafeInteger(body.idGoal) ||
    (body.idGoal as number) < 1 ||
    (body.idGoal as number) > MAX_MATOMO_IDENTIFIER
  ) {
    throw new MatomoInputError("idSite and idGoal must be bounded positive integers.");
  }
  if (
    typeof body.segment !== "string" ||
    Buffer.byteLength(body.segment, "utf8") > MAX_SEGMENT_BYTES ||
    /[\u0000-\u001f\u007f]/.test(body.segment) ||
    /token_auth/i.test(body.segment)
  ) {
    throw new MatomoInputError("segment is invalid.");
  }
  if (
    typeof body.goalName !== "string" ||
    body.goalName.length === 0 ||
    Buffer.byteLength(body.goalName, "utf8") > MAX_GOAL_NAME_BYTES ||
    /[\u0000-\u001f\u007f]/.test(body.goalName)
  ) {
    throw new MatomoInputError("goalName is invalid.");
  }
  if (!validTimezone(body.timezone)) {
    throw new MatomoInputError("timezone is invalid.");
  }
  return {
    runId: identifier(body.runId, "runId"),
    clientId: identifier(body.clientId, "clientId"),
    brandId: identifier(body.brandId, "brandId"),
    siteId: identifier(body.siteId, "siteId"),
    siteMarketId: body.siteMarketId === null
      ? null
      : identifier(body.siteMarketId, "siteMarketId"),
    integrationId: identifier(body.integrationId, "integrationId"),
    endpoint: validateMatomoOrigin(body.endpoint),
    startDate: start.value,
    endDate: end.value,
    idSite: body.idSite as number,
    idGoal: body.idGoal as number,
    segment: body.segment,
    timezone: body.timezone,
    goalName: body.goalName,
  };
}

function canonicalPagePath(value: string) {
  if (
    value.length === 0 ||
    value.length > 2_048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }
  const rawPath = value.split(/[?#]/, 1)[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (
    decoded.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(decoded) ||
    decoded.split("/").some((part) => part === "." || part === "..")
  ) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value, "https://sgeo.invalid");
  } catch {
    return null;
  }
  return parsed.origin === "https://sgeo.invalid" && parsed.pathname.length <= 2_048
    ? parsed.pathname
    : null;
}

function pageRows(value: unknown, metric: "nb_hits" | "nb_visits") {
  if (!Array.isArray(value)) return null;
  const counts = new Map<string, number>();
  for (const item of value) {
    const row = record(item);
    const path = row === null || typeof row.label !== "string"
      ? null
      : canonicalPagePath(row.label);
    const count = row?.[metric];
    if (
      path === null ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      return null;
    }
    const total = (counts.get(path) ?? 0) + count;
    if (!Number.isSafeInteger(total)) return null;
    counts.set(path, total);
  }
  return [...counts.entries()].map(([path, count]) => ({ path, count }));
}

function goalConversions(value: unknown) {
  const goal = record(value);
  if (goal === null) return null;
  if (Object.keys(goal).length === 0) return { empty: true as const, count: 0 };
  const count = goal.nb_conversions;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
  return { empty: false as const, count };
}

function containsCredentialMaterial(root: unknown) {
  const pending: unknown[] = [root];
  const seen = new WeakSet<object>();
  let inspected = 0;
  while (pending.length > 0) {
    if (inspected >= 1_000_000) return true;
    inspected += 1;
    const value = pending.pop();
    if (typeof value === "string") {
      if (/(?:token_auth|access_token|authorization|password)\s*[=:]/i.test(value)) return true;
      continue;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    for (const key of Object.keys(value)) {
      if (/^(?:token_auth|access_token|authorization|password)$/i.test(key)) return true;
      pending.push((value as Record<string, unknown>)[key]);
    }
  }
  return false;
}

function frameArtifact(pages: readonly Uint8Array[], maximumRawBytes: number) {
  const total = ARTIFACT_MAGIC.byteLength + pages.reduce(
    (size, page) => size + 4 + page.byteLength,
    0,
  );
  if (total > maximumRawBytes) {
    throw new MatomoExecutionError("Matomo raw artifact is too large.");
  }
  const artifact = new Uint8Array(total);
  artifact.set(ARTIFACT_MAGIC, 0);
  const view = new DataView(artifact.buffer);
  let offset = ARTIFACT_MAGIC.byteLength;
  for (const page of pages) {
    view.setUint32(offset, page.byteLength, false);
    offset += 4;
    artifact.set(page, offset);
    offset += page.byteLength;
  }
  return artifact;
}

function observation(
  input: MatomoInput,
  observedAt: string,
  kind: string,
  subject: string,
  count: number,
  extra: Record<string, unknown> = {},
): NormalizedObservation {
  return {
    kind,
    subject,
    observedAt,
    value: {
      count,
      startDate: input.startDate,
      endDate: input.endDate,
      idSite: input.idSite,
      segment: input.segment,
      configuredSegment: input.segment,
      timezone: input.timezone,
      ...extra,
    },
  };
}

function envelope(
  input: MatomoInput,
  startedAt: string,
  finishedAt: string,
  observations: NormalizedObservation[],
  valid: boolean,
) {
  return analysisEnvelopeSchema.parse({
    contractVersion: "1",
    runId: input.runId,
    clientId: input.clientId,
    brandId: input.brandId,
    siteId: input.siteId,
    siteMarketId: input.siteMarketId,
    source: MATOMO_SOURCE,
    sourceVersion: MATOMO_SOURCE_VERSION,
    adapterVersion: MATOMO_ADAPTER_VERSION,
    status: valid ? "succeeded" : "failed",
    startedAt,
    finishedAt,
    rawArtifact: null,
    observations: valid ? observations : [],
    error: valid
      ? null
      : {
          code: "MATOMO_INVALID_REPORT",
          message: "Matomo returned an invalid report.",
          retryable: false,
        },
  });
}

function enforceEnvelopeSize(value: AnalysisEnvelope, maximumEnvelopeBytes: number) {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw new MatomoExecutionError("Matomo result cannot be serialized safely.");
  }
  if (bytes > maximumEnvelopeBytes) {
    throw new MatomoExecutionError("Matomo result exceeds the delivery envelope limit.");
  }
}

export async function executeMatomo(
  value: MatomoInput,
  dependencies: Dependencies,
): Promise<MatomoExecution> {
  const input = parseMatomoInput(value);
  const maximumRawBytes = dependencies.maximumRawBytes ?? MATOMO_MAX_RAW_BYTES;
  const maximumEnvelopeBytes = dependencies.maximumEnvelopeBytes ?? MATOMO_DEFAULT_MAX_ENVELOPE_BYTES;
  if (
    !Number.isInteger(maximumRawBytes) ||
    maximumRawBytes < ARTIFACT_MAGIC.byteLength + 12 ||
    maximumRawBytes > MATOMO_MAX_RAW_BYTES
  ) {
    throw new MatomoExecutionError("Matomo raw artifact limit is invalid.");
  }
  if (
    !Number.isInteger(maximumEnvelopeBytes) ||
    maximumEnvelopeBytes < 1 ||
    maximumEnvelopeBytes > MATOMO_DEFAULT_MAX_ENVELOPE_BYTES
  ) {
    throw new MatomoExecutionError("Matomo delivery envelope limit is invalid.");
  }

  const startedAt = new Date().toISOString();
  const common = {
    startDate: input.startDate,
    endDate: input.endDate,
    idSite: input.idSite,
    timezone: input.timezone,
  };
  const organicSegment = input.segment.length > 0
    ? `${input.segment};referrerType==search`
    : "referrerType==search";
  const requests: MatomoReportRequest[] = [
    { ...common, method: "Actions.getPageUrls", metric: "nb_hits", segment: input.segment },
    { ...common, method: "Actions.getPageUrls", metric: "nb_visits", segment: organicSegment },
    { ...common, method: "Goals.get", idGoal: input.idGoal, segment: input.segment },
  ];
  const rawPages: Uint8Array[] = [];
  const parsedPages: unknown[] = [];
  let projectedRawBytes = ARTIFACT_MAGIC.byteLength;
  for (const request of requests) {
    const page = await dependencies.query(request);
    if (!(page.rawBytes instanceof Uint8Array)) {
      throw new MatomoExecutionError("Matomo client returned invalid raw bytes.");
    }
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(page.rawBytes);
    } catch {
      throw new MatomoExecutionError("Matomo client returned invalid raw bytes.");
    }
    if (decoded !== page.rawBody) {
      throw new MatomoExecutionError("Matomo client returned inconsistent raw bytes.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw new MatomoExecutionError("Matomo client returned invalid report JSON.");
    }
    if (containsCredentialMaterial(parsed)) {
      throw new MatomoExecutionError("Matomo report contains credential material.");
    }
    projectedRawBytes += 4 + page.rawBytes.byteLength;
    if (projectedRawBytes > maximumRawBytes) {
      throw new MatomoExecutionError("Matomo raw artifact is too large.");
    }
    rawPages.push(page.rawBytes);
    parsedPages.push(parsed);
  }

  const rawReport = frameArtifact(rawPages, maximumRawBytes);
  const pageViews = pageRows(parsedPages[0], "nb_hits");
  const organicVisits = pageRows(parsedPages[1], "nb_visits");
  const conversion = goalConversions(parsedPages[2]);
  const valid = pageViews !== null && organicVisits !== null && conversion !== null;
  const finishedAt = new Date().toISOString();
  const observations = valid
    ? [
        ...pageViews.map(({ path, count }) => observation(
          input,
          finishedAt,
          "page_view",
          path,
          count,
          { reportMethod: "Actions.getPageUrls", metric: "nb_hits" },
        )),
        ...organicVisits.map(({ path, count }) => observation(
          input,
          finishedAt,
          "organic_visit",
          path,
          count,
          {
            segment: organicSegment,
            reportMethod: "Actions.getPageUrls",
            metric: "nb_visits",
          },
        )),
        ...(conversion.empty
          ? []
          : [observation(
              input,
              finishedAt,
              "conversion",
              input.goalName,
              conversion.count,
              { idGoal: input.idGoal, reportMethod: "Goals.get" },
            )]),
      ]
    : [];
  const resultEnvelope = envelope(input, startedAt, finishedAt, observations, valid);
  enforceEnvelopeSize(resultEnvelope, maximumEnvelopeBytes);
  return { envelope: resultEnvelope, rawReport };
}
