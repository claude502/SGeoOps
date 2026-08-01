import { execFile as defaultExecFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  analysisEnvelopeSchema,
  type AnalysisEnvelope,
  type NormalizedObservation,
} from "@sgeo/analysis-contract";

export const SITEONE_BINARY = "siteone-crawler";
export const SITEONE_SOURCE = "siteone";
export const SITEONE_SOURCE_VERSION = "2.5.1";
export const SITEONE_ADAPTER_VERSION = "1.0.0";
export const SITEONE_ARTIFACT_NAME = "siteone-report.json";
export const SITEONE_ARTIFACT_MEDIA_TYPE = "application/json";
export const SITEONE_STRUCTURED_DATA_COLUMN = "SgeoStructuredData";
// The signed ingestion route accepts a compact 1 MiB envelope. Fifty pages keeps
// the normalized URL-level facts safely below that boundary.
export const SITEONE_MAX_URLS = 50;
export const SITEONE_MAX_TIMEOUT_SECONDS = 900;
export const SITEONE_MAX_REPORT_BYTES = 64 * 1024 * 1024;
const SITEONE_MAX_REPORTED_URL_LENGTH = 2_048;
const SITEONE_MAX_TEXT_LENGTH = 512;
const SITEONE_MAX_STRUCTURED_DATA_TYPES = 10;

export interface SiteOneInput {
  runId: string;
  clientId: string;
  brandId: string;
  siteId: string;
  siteMarketId: string | null;
  url: string;
  maxUrls: number;
  timeoutSeconds: number;
}

export interface SiteOneExecution {
  envelope: AnalysisEnvelope;
  rawReport: Uint8Array | null;
}

export class SiteOneInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteOneInputError";
  }
}

type SiteOneDependencies = {
  execFile?: typeof import("node:child_process").execFile;
};

type JsonRecord = Record<string, unknown>;
type SiteOneReport = {
  crawler?: JsonRecord;
  results: JsonRecord[];
  stats?: JsonRecord;
  summary?: JsonRecord;
  tables?: Record<string, JsonRecord>;
};

function nonEmptyIdentifier(value: string, name: string) {
  if (value.length === 0 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SiteOneInputError(`${name} must be a bounded, non-control string.`);
  }
}

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && (
    parts[0] === 10 ||
    parts[0] === 127 ||
    parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function isPrivateIpv6(hostname: string) {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const address = hostname.slice(1, -1).toLowerCase();
  return (
    address === "::" ||
    address === "::1" ||
    address.startsWith("::ffff:") ||
    /^(?:fc|fd)[0-9a-f]{2}:/.test(address) ||
    /^fe[89ab][0-9a-f]:/.test(address)
  );
}

function validateUrl(value: string) {
  if (value.length === 0 || value.length > 2_083 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SiteOneInputError("url must be a bounded HTTP(S) URL.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SiteOneInputError("url must be a valid HTTP(S) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SiteOneInputError("url must use http or https.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new SiteOneInputError("url must not include credentials.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isPrivateIpv4(hostname) ||
    isPrivateIpv6(hostname)
  ) {
    throw new SiteOneInputError("url must not target a local or private address.");
  }
}

function validateInput(input: SiteOneInput) {
  nonEmptyIdentifier(input.runId, "runId");
  nonEmptyIdentifier(input.clientId, "clientId");
  nonEmptyIdentifier(input.brandId, "brandId");
  nonEmptyIdentifier(input.siteId, "siteId");
  if (input.siteMarketId !== null) {
    nonEmptyIdentifier(input.siteMarketId, "siteMarketId");
  }
  validateUrl(input.url);
  if (!Number.isInteger(input.maxUrls) || input.maxUrls < 1 || input.maxUrls > SITEONE_MAX_URLS) {
    throw new SiteOneInputError(`maxUrls must be an integer between 1 and ${SITEONE_MAX_URLS}.`);
  }
  if (
    !Number.isInteger(input.timeoutSeconds) ||
    input.timeoutSeconds < 1 ||
    input.timeoutSeconds > SITEONE_MAX_TIMEOUT_SECONDS
  ) {
    throw new SiteOneInputError(
      `timeoutSeconds must be an integer between 1 and ${SITEONE_MAX_TIMEOUT_SECONDS}.`,
    );
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asRows(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const parsed = asRecord(row);
    return parsed === null ? [] : [parsed];
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function absoluteUrl(value: string, baseUrl: string): string | null {
  try {
    const parsed = new URL(value, baseUrl);
    const normalized = parsed.toString();
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      normalized.length <= SITEONE_MAX_REPORTED_URL_LENGTH
    ) ? normalized : null;
  } catch {
    return null;
  }
}

function boundedText(value: string, maximumLength: number = SITEONE_MAX_TEXT_LENGTH) {
  return value.slice(0, maximumLength);
}

function observation(
  kind: string,
  subject: string,
  value: Record<string, unknown>,
  observedAt: string,
): NormalizedObservation {
  return {
    kind,
    subject,
    value: value as NormalizedObservation["value"],
    observedAt,
  };
}

function tableRows(report: SiteOneReport, key: string) {
  return asRows(report.tables?.[key]?.rows);
}

function reportStatusCodes(report: SiteOneReport) {
  return report.results.flatMap((result) => {
    const status = numberValue(result.status);
    return status === null ? [] : [status];
  });
}

function appendHttpStatusFacts(
  report: SiteOneReport,
  input: SiteOneInput,
  observedAt: string,
  facts: NormalizedObservation[],
) {
  for (const result of report.results) {
    const value = stringValue(result.url);
    const subject = value === null ? null : absoluteUrl(value, input.url);
    const statusCode = numberValue(result.status);
    if (subject !== null && statusCode !== null) {
      facts.push(observation("siteone.http_status", subject, { statusCode }, observedAt));
    }
  }
}

function appendSeoFacts(
  report: SiteOneReport,
  input: SiteOneInput,
  observedAt: string,
  facts: NormalizedObservation[],
) {
  for (const row of tableRows(report, "seo")) {
    const path = stringValue(row.urlPathAndQuery);
    if (path === null) continue;
    const subject = absoluteUrl(path, input.url);
    if (subject === null) continue;

    const indexing = boundedText(stringValue(row.indexing) ?? "");
    const robotsIndex = stringValue(row.robotsIndex);
    const deniedByRobots = stringValue(row.deniedByRobotsTxt);
    const indexable = robotsIndex !== "0" &&
      deniedByRobots !== "1" &&
      deniedByRobots !== "true" &&
      !/\bnoindex\b/i.test(indexing);
    facts.push(observation("siteone.indexability", subject, {
      indexable,
      indexing,
      deniedByRobotsTxt: deniedByRobots === "1" || deniedByRobots === "true",
    }, observedAt));

    const title = stringValue(row.title);
    if (title !== null) {
      facts.push(observation("siteone.title", subject, { text: boundedText(title) }, observedAt));
    }
  }
}

function appendHeadingFacts(
  report: SiteOneReport,
  input: SiteOneInput,
  observedAt: string,
  facts: NormalizedObservation[],
) {
  for (const row of tableRows(report, "seo-headings")) {
    const path = stringValue(row.urlPathAndQuery);
    const subject = path === null ? null : absoluteUrl(path, input.url);
    const count = numberValue(row.headingsCount);
    const errorCount = numberValue(row.headingsErrorsCount);
    if (subject === null || count === null || errorCount === null) continue;
    facts.push(observation("siteone.heading", subject, {
      count,
      errorCount,
    }, observedAt));
  }
}

function appendCanonicalMismatchFacts(
  report: SiteOneReport,
  input: SiteOneInput,
  observedAt: string,
  facts: NormalizedObservation[],
) {
  const subject = absoluteUrl(input.url, input.url);
  if (subject === null) return;
  for (const item of asRows(report.summary?.items)) {
    if (stringValue(item.aplCode) !== "seo-canonical-mismatch") continue;
    const match = /^(\d+)/.exec(stringValue(item.text) ?? "");
    facts.push(observation("siteone.canonical_mismatch", subject, {
      count: match === null ? null : Number(match[1]),
    }, observedAt));
  }
}

function structuredTypes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .slice(0, SITEONE_MAX_STRUCTURED_DATA_TYPES)
      .map((entry) => boundedText(entry));
  }
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, SITEONE_MAX_STRUCTURED_DATA_TYPES)
    .map((entry) => boundedText(entry));
}

function appendStructuredDataFacts(
  report: SiteOneReport,
  input: SiteOneInput,
  observedAt: string,
  facts: NormalizedObservation[],
) {
  for (const result of report.results) {
    const rawSubject = stringValue(result.url);
    const subject = rawSubject === null ? null : absoluteUrl(rawSubject, input.url);
    if (subject === null) continue;
    const extras = asRecord(result.extras);
    const extractedJson = extras === null
      ? null
      : stringValue(extras[SITEONE_STRUCTURED_DATA_COLUMN]);
    if (extractedJson === null || extractedJson.length === 0) continue;
    let parsed: JsonRecord | null;
    try {
      parsed = asRecord(JSON.parse(extractedJson));
    } catch {
      parsed = null;
    }
    if (parsed === null) continue;
    const types = structuredTypes([
      parsed["@type"],
      ...asRows(parsed["@graph"]).map((node) => node["@type"]),
    ].flatMap((value) => structuredTypes(value)));
    if (types.length > 0) {
      facts.push(observation("siteone.structured_data", subject, {
        count: types.length,
        types,
      }, observedAt));
    }
  }
}

function appendBrokenLinkFacts(
  report: SiteOneReport,
  input: SiteOneInput,
  observedAt: string,
  facts: NormalizedObservation[],
) {
  for (const row of tableRows(report, "404")) {
    const rawSubject = stringValue(row.url);
    const subject = rawSubject === null ? null : absoluteUrl(rawSubject, input.url);
    const statusCode = numberValue(row.statusCode) ?? 404;
    if (subject === null) continue;
    const rawSourceUrl = stringValue(row.sourceUqId);
    const sourceUrl = rawSourceUrl === null
      ? ""
      : absoluteUrl(rawSourceUrl, input.url) ?? "";
    facts.push(observation("siteone.broken_link", subject, {
      sourceUrl,
      statusCode,
    }, observedAt));
  }
}

function reportIsWithinInputBounds(report: SiteOneReport, maxUrls: number) {
  if (report.results.length > maxUrls) return false;
  return ["seo", "seo-headings", "404"]
    .every((key) => tableRows(report, key).length <= maxUrls);
}

function isPartialReport(report: SiteOneReport, maxUrls: number) {
  if (
    report.results.length === maxUrls ||
    report.stats?.visitedUrlLimitReached === true
  ) return true;
  const items = asRows(report.summary?.items);
  return items.some((item) => stringValue(item.aplCode) === "crawler-partial");
}

function classifiedError(report: SiteOneReport) {
  const statuses = reportStatusCodes(report);
  if (statuses.some((status) => status === 401 || status === 403)) {
    return { code: "SITEONE_UNAUTHORIZED", message: "The audited origin rejected SiteOne credentials.", retryable: false };
  }
  if (statuses.includes(429)) {
    return { code: "SITEONE_RATE_LIMITED", message: "The audited origin rate limited SiteOne.", retryable: true };
  }
  if (statuses.some((status) => status >= 500 && status <= 599)) {
    return { code: "SITEONE_UPSTREAM_ERROR", message: "The audited origin returned an upstream server error.", retryable: true };
  }
  return null;
}

function baseEnvelope(
  input: SiteOneInput,
  startedAt: string,
  finishedAt: string,
  status: AnalysisEnvelope["status"],
  observations: NormalizedObservation[],
  error: AnalysisEnvelope["error"],
): AnalysisEnvelope {
  return analysisEnvelopeSchema.parse({
    contractVersion: "1",
    runId: input.runId,
    clientId: input.clientId,
    brandId: input.brandId,
    siteId: input.siteId,
    siteMarketId: input.siteMarketId,
    source: SITEONE_SOURCE,
    sourceVersion: SITEONE_SOURCE_VERSION,
    adapterVersion: SITEONE_ADAPTER_VERSION,
    status,
    startedAt,
    finishedAt,
    rawArtifact: null,
    observations,
    error,
  });
}

function normalizeReport(
  input: SiteOneInput,
  rawReport: Uint8Array,
  startedAt: string,
  finishedAt: string,
): AnalysisEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(rawReport));
  } catch {
    return baseEnvelope(input, startedAt, finishedAt, "failed", [], {
      code: "SITEONE_INVALID_REPORT",
      message: "SiteOne emitted invalid JSON.",
      retryable: false,
    });
  }
  const document = asRecord(value);
  if (document === null || !Array.isArray(document.results)) {
    return baseEnvelope(input, startedAt, finishedAt, "failed", [], {
      code: "SITEONE_INVALID_REPORT",
      message: "SiteOne emitted a report without valid crawl results.",
      retryable: false,
    });
  }
  const results = asRows(document.results);
  if (results.length !== document.results.length) {
    return baseEnvelope(input, startedAt, finishedAt, "failed", [], {
      code: "SITEONE_INVALID_REPORT",
      message: "SiteOne emitted a report without valid crawl results.",
      retryable: false,
    });
  }
  const tablesRecord = asRecord(document.tables);
  const report: SiteOneReport = {
    crawler: asRecord(document.crawler) ?? undefined,
    results,
    stats: asRecord(document.stats) ?? undefined,
    summary: asRecord(document.summary) ?? undefined,
    tables: tablesRecord === null
      ? undefined
      : tablesRecord as Record<string, JsonRecord>,
  };
  if (!reportIsWithinInputBounds(report, input.maxUrls)) {
    return baseEnvelope(input, startedAt, finishedAt, "failed", [], {
      code: "SITEONE_REPORT_LIMIT_EXCEEDED",
      message: "SiteOne emitted more URL-level rows than the bounded crawl permits.",
      retryable: false,
    });
  }
  const facts: NormalizedObservation[] = [];
  appendHttpStatusFacts(report, input, finishedAt, facts);
  appendSeoFacts(report, input, finishedAt, facts);
  appendCanonicalMismatchFacts(report, input, finishedAt, facts);
  appendHeadingFacts(report, input, finishedAt, facts);
  appendStructuredDataFacts(report, input, finishedAt, facts);
  appendBrokenLinkFacts(report, input, finishedAt, facts);

  const error = classifiedError(report);
  if (error !== null) {
    return baseEnvelope(input, startedAt, finishedAt, "failed", facts, error);
  }
  if (isPartialReport(report, input.maxUrls)) {
    return baseEnvelope(input, startedAt, finishedAt, "partial", facts, {
      code: "SITEONE_PARTIAL",
      message: "SiteOne completed only a bounded partial crawl.",
      retryable: false,
    });
  }
  return baseEnvelope(input, startedAt, finishedAt, "succeeded", facts, null);
}

function executionFailure(
  input: SiteOneInput,
  startedAt: string,
  code: string,
  message: string,
  retryable: boolean,
) {
  return baseEnvelope(input, startedAt, new Date().toISOString(), "failed", [], {
    code,
    message,
    retryable,
  });
}

function commandArgs(input: SiteOneInput, outputFile: string, configFile: string) {
  return [
    `--url=${input.url}`,
    `--max-visited-urls=${input.maxUrls}`,
    `--timeout=${input.timeoutSeconds}`,
    "--workers=1",
    "--max-reqs-per-sec=2",
    `--output-json-file=${outputFile}`,
    "--output-html-report=",
    "--output-text-file=",
    "--disable-all-assets",
    "--no-cache",
    "--hide-progress-bar",
    `--extra-columns=${SITEONE_STRUCTURED_DATA_COLUMN}=regexp:/<script[^>]*type=["']application\\/ld\\+json["'][^>]*>([\\s\\S]*?)<\\/script>/i#1(4096)`,
    `--config-file=${configFile}`,
  ];
}

function executionTimeout(input: SiteOneInput) {
  return Math.min(
    895_000,
    Math.max(30_000, input.maxUrls * input.timeoutSeconds * 1_000),
  );
}

async function invokeSiteOne(
  execFile: typeof defaultExecFile,
  args: string[],
  workingDirectory: string,
  input: SiteOneInput,
) {
  await new Promise<void>((resolve, reject) => {
    execFile(SITEONE_BINARY, args, {
      cwd: workingDirectory,
      shell: false,
      timeout: executionTimeout(input),
      maxBuffer: 1_024 * 1_024,
      env: {
        ...process.env,
        HOME: workingDirectory,
        XDG_CACHE_HOME: join(workingDirectory, "cache"),
      },
    }, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

async function readRawReport(outputFile: string): Promise<Uint8Array | null> {
  try {
    const metadata = await stat(outputFile);
    if (metadata.size > SITEONE_MAX_REPORT_BYTES) return null;
    return new Uint8Array(await readFile(outputFile));
  } catch {
    return null;
  }
}

export async function executeSiteOne(
  input: SiteOneInput,
  dependencies?: SiteOneDependencies,
): Promise<SiteOneExecution> {
  validateInput(input);
  const startedAt = new Date().toISOString();
  const workingDirectory = await mkdtemp(join(tmpdir(), "sgeo-siteone-"));
  const outputFile = join(workingDirectory, "report.json");
  const configFile = join(workingDirectory, "siteone.conf");
  const execFile = dependencies?.execFile ?? defaultExecFile;

  try {
    await writeFile(configFile, "", { mode: 0o600 });
    let commandFailed = false;
    try {
      await invokeSiteOne(
        execFile,
        commandArgs(input, outputFile, configFile),
        workingDirectory,
        input,
      );
    } catch {
      commandFailed = true;
    }
    const rawReport = await readRawReport(outputFile);
    if (rawReport === null) {
      return {
        rawReport: null,
        envelope: executionFailure(
          input,
          startedAt,
          commandFailed ? "SITEONE_EXECUTION_FAILED" : "SITEONE_REPORT_MISSING",
          commandFailed
            ? "SiteOne did not complete its crawl."
            : "SiteOne did not produce a JSON report.",
          true,
        ),
      };
    }
    if (commandFailed) {
      return {
        rawReport,
        envelope: executionFailure(
          input,
          startedAt,
          "SITEONE_EXECUTION_FAILED",
          "SiteOne exited before completing its crawl.",
          true,
        ),
      };
    }
    return {
      rawReport,
      envelope: normalizeReport(input, rawReport, startedAt, new Date().toISOString()),
    };
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

export async function runSiteOne(
  input: SiteOneInput,
  dependencies?: { execFile?: typeof import("node:child_process").execFile },
): Promise<AnalysisEnvelope> {
  return (await executeSiteOne(input, dependencies)).envelope;
}
