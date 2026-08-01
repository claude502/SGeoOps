import { execFile as defaultExecFile } from "node:child_process";
import { lookup as defaultLookup } from "node:dns/promises";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  analysisEnvelopeSchema,
  type AnalysisEnvelope,
  type NormalizedObservation,
} from "@sgeo/analysis-contract";

import { startPinnedOriginProxy, type PinnedOriginProxy } from "./pinned-origin-proxy";

export const SITEONE_BINARY = "siteone-crawler";
export const SITEONE_SOURCE = "siteone";
export const SITEONE_SOURCE_VERSION = "2.5.1";
export const SITEONE_ADAPTER_VERSION = "1.0.0";
export const SITEONE_ARTIFACT_NAME = "siteone-report.json";
export const SITEONE_ARTIFACT_MEDIA_TYPE = "application/json";
export const SITEONE_STRUCTURED_DATA_COLUMN = "SgeoStructuredData";
// SiteOne's ExtraColumn implementation passes this directly to Rust regex::Regex.
// Inline flags are therefore required; JavaScript-style /pattern/i delimiters are literals.
export const SITEONE_STRUCTURED_DATA_REGEXP =
  String.raw`(?is)<script\b[^>]*\btype\s*=\s*(?:"application/ld\+json"|'application/ld\+json'|application/ld\+json)[^>]*>(.*?)</script>`;
// The signed ingestion route accepts a compact 1 MiB envelope. Fifty pages keeps
// the normalized URL-level facts safely below that boundary.
export const SITEONE_MAX_URLS = 50;
// Leave the Trigger task at least three minutes to read, archive, and deliver the report.
export const SITEONE_FINALIZATION_RESERVE_SECONDS = 180;
export const SITEONE_MAX_TIMEOUT_SECONDS = 60;
export const SITEONE_MAX_REPORT_BYTES = 64 * 1024 * 1024;
const SITEONE_MAX_REPORTED_URL_LENGTH = 2_048;
const SITEONE_MAX_TEXT_LENGTH = 512;
const SITEONE_MAX_STRUCTURED_DATA_TYPES = 10;
const SITEONE_MAX_STRUCTURED_DATA_BYTES = 4_096;
const SITEONE_MAX_EXTRA_COLUMNS = 20;
const SITEONE_MAX_PROCESS_SECONDS = 900 - SITEONE_FINALIZATION_RESERVE_SECONDS;

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

export type SiteOneLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

type SiteOneDependencies = {
  execFile?: typeof import("node:child_process").execFile;
  lookup?: SiteOneLookup;
};

type JsonRecord = Record<string, unknown>;
type SiteOneReport = {
  crawler: JsonRecord;
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

type AuditedOrigin = {
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
  includeRegex: string;
};

function unbracket(address: string) {
  return address.startsWith("[") && address.endsWith("]")
    ? address.slice(1, -1)
    : address;
}

function isGloballyRoutableIpv4(address: string) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second, third] = octets;
  if (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  ) {
    return false;
  }
  return true;
}

function isGloballyRoutableIpv6(address: string) {
  const normalized = address.toLowerCase();
  const firstHextet = Number.parseInt(normalized.split(":", 1)[0] ?? "", 16);
  if (
    !Number.isInteger(firstHextet) ||
    firstHextet < 0x2000 ||
    firstHextet > 0x3fff ||
    normalized.startsWith("2001:0:") ||
    normalized.startsWith("2001:2:") ||
    normalized.startsWith("2001:db8:")
  ) {
    return false;
  }
  return true;
}

function isGloballyRoutableAddress(address: string, family: number) {
  const ipFamily = isIP(address);
  if (ipFamily === 0 || ipFamily !== family) return false;
  return ipFamily === 4
    ? isGloballyRoutableIpv4(address)
    : isGloballyRoutableIpv6(address);
}

function escapePcreLiteral(value: string) {
  return value.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

function originRegex(parsed: URL, hostname: string, port: number) {
  const defaultPort = (parsed.protocol === "http:" && port === 80) ||
    (parsed.protocol === "https:" && port === 443);
  const portPattern = defaultPort ? `(?::${port})?` : `:${port}`;
  return `^${escapePcreLiteral(parsed.protocol)}\\/\\/${escapePcreLiteral(hostname)}${portPattern}(?:[\\/?#]|$)`;
}

function validateUrl(value: string): AuditedOrigin {
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
  const hostname = unbracket(parsed.hostname.toLowerCase());
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isIP(hostname) !== 0
  ) {
    throw new SiteOneInputError("url hostname must be a public DNS name.");
  }
  const port = parsed.port === ""
    ? parsed.protocol === "https:" ? 443 : 80
    : Number(parsed.port);
  return {
    protocol: parsed.protocol,
    hostname,
    port,
    includeRegex: originRegex(parsed, hostname, port),
  };
}

function validateInput(input: SiteOneInput): AuditedOrigin {
  nonEmptyIdentifier(input.runId, "runId");
  nonEmptyIdentifier(input.clientId, "clientId");
  nonEmptyIdentifier(input.brandId, "brandId");
  nonEmptyIdentifier(input.siteId, "siteId");
  if (input.siteMarketId !== null) {
    nonEmptyIdentifier(input.siteMarketId, "siteMarketId");
  }
  const origin = validateUrl(input.url);
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
  return origin;
}

type ResolvedAddress = { address: string; family: 4 | 6 };

async function resolveAuditedOrigin(origin: AuditedOrigin, lookup: SiteOneLookup): Promise<ResolvedAddress[]> {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(origin.hostname, { all: true, verbatim: true });
  } catch {
    throw new SiteOneInputError("url host could not be resolved.");
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) => !isGloballyRoutableAddress(address, family))
  ) {
    throw new SiteOneInputError("url host must resolve only to globally routable addresses.");
  }
  return addresses.reduce<ResolvedAddress[]>((unique, { address, family }) => {
    if (!unique.some((entry) => entry.address === address)) {
      unique.push({ address, family: family as 4 | 6 });
    }
    return unique;
  }, []);
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

function structuredDataExtra(result: JsonRecord): string | null {
  const extras = result.extras;
  let extracted: unknown;
  if (asRecord(extras) !== null) {
    // SiteOne v2.5.1 JSON output uses a keyed object when extra columns are configured.
    extracted = asRecord(extras)?.[SITEONE_STRUCTURED_DATA_COLUMN];
  } else if (Array.isArray(extras)) {
    for (const extra of extras.slice(0, SITEONE_MAX_EXTRA_COLUMNS)) {
      const record = asRecord(extra);
      if (record !== null && record.name === SITEONE_STRUCTURED_DATA_COLUMN) {
        extracted = record.value;
        break;
      }
    }
  }
  const value = stringValue(extracted);
  return value !== null && value.length <= SITEONE_MAX_STRUCTURED_DATA_BYTES
    ? value
    : null;
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
    const extractedJson = structuredDataExtra(result);
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

function hasExpectedCrawlerIdentity(crawler: JsonRecord | null) {
  if (crawler === null || crawler.name !== "SiteOne Crawler") return false;
  const version = stringValue(crawler.version);
  // SiteOne's release artifact is 2.5.1 while its report includes the release-line
  // build date (for example 2.5.1.20260627). Do not accept another release line.
  return version === SITEONE_SOURCE_VERSION || /^2\.5\.1\.\d{8}$/.test(version ?? "");
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
  const crawler = asRecord(document.crawler);
  if (crawler === null || !hasExpectedCrawlerIdentity(crawler)) {
    return baseEnvelope(input, startedAt, finishedAt, "failed", [], {
      code: "SITEONE_INVALID_REPORT",
      message: "SiteOne emitted a report without the expected crawler identity.",
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
    crawler,
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

function commandArgs(
  input: SiteOneInput,
  origin: AuditedOrigin,
  proxyPort: number,
  outputFile: string,
  configFile: string,
) {
  return [
    `--url=${input.url}`,
    `--max-visited-urls=${input.maxUrls}`,
    `--timeout=${input.timeoutSeconds}`,
    "--workers=1",
    "--max-reqs-per-sec=2",
    "--memory-limit=512M",
    `--max-queue-length=${input.maxUrls}`,
    `--max-skipped-urls=${input.maxUrls}`,
    `--proxy=127.0.0.1:${proxyPort}`,
    `--include-regex=${origin.includeRegex}`,
    `--output-json-file=${outputFile}`,
    "--output-html-report=",
    "--output-text-file=",
    "--disable-all-assets",
    "--no-cache",
    "--hide-progress-bar",
    `--extra-columns=${SITEONE_STRUCTURED_DATA_COLUMN}=regexp:${SITEONE_STRUCTURED_DATA_REGEXP}#1(4096)`,
    `--config-file=${configFile}`,
  ];
}

function executionTimeout(input: SiteOneInput) {
  return Math.min(
    SITEONE_MAX_PROCESS_SECONDS * 1_000,
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

type RawReportReadResult =
  | { kind: "ok"; rawReport: Uint8Array }
  | { kind: "missing" }
  | { kind: "too_large" };

async function readRawReport(outputFile: string): Promise<RawReportReadResult> {
  try {
    const metadata = await stat(outputFile);
    if (!metadata.isFile()) return { kind: "missing" };
    if (metadata.size > SITEONE_MAX_REPORT_BYTES) return { kind: "too_large" };
    return { kind: "ok", rawReport: new Uint8Array(await readFile(outputFile)) };
  } catch {
    return { kind: "missing" };
  }
}

export async function executeSiteOne(
  input: SiteOneInput,
  dependencies?: SiteOneDependencies,
): Promise<SiteOneExecution> {
  const origin = validateInput(input);
  const resolvedAddresses = await resolveAuditedOrigin(
    origin,
    dependencies?.lookup ?? defaultLookup,
  );
  const startedAt = new Date().toISOString();
  const workingDirectory = await mkdtemp(join(tmpdir(), "sgeo-siteone-"));
  const outputFile = join(workingDirectory, "report.json");
  const configFile = join(workingDirectory, "siteone.conf");
  const execFile = dependencies?.execFile ?? defaultExecFile;
  const pinnedAddress = resolvedAddresses[0]!;
  let proxy: PinnedOriginProxy | null = null;

  try {
    await writeFile(configFile, "", { mode: 0o600 });
    try {
      proxy = await startPinnedOriginProxy({
        protocol: origin.protocol,
        hostname: origin.hostname,
        port: origin.port,
        address: pinnedAddress.address,
        family: pinnedAddress.family,
      });
    } catch {
      return {
        rawReport: null,
        envelope: executionFailure(
          input,
          startedAt,
          "SITEONE_PROXY_UNAVAILABLE",
          "SiteOne could not start its pinned origin proxy.",
          true,
        ),
      };
    }
    let commandFailed = false;
    try {
      await invokeSiteOne(
        execFile,
        commandArgs(input, origin, proxy.port, outputFile, configFile),
        workingDirectory,
        input,
      );
    } catch {
      commandFailed = true;
    }
    const report = await readRawReport(outputFile);
    if (report.kind === "too_large") {
      return {
        rawReport: null,
        envelope: executionFailure(
          input,
          startedAt,
          "SITEONE_REPORT_TOO_LARGE",
          "SiteOne produced a JSON report larger than the 64 MiB safety limit.",
          false,
        ),
      };
    }
    if (report.kind === "missing") {
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
    const rawReport = report.rawReport;
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
    try {
      await proxy?.close();
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }
}

export async function runSiteOne(
  input: SiteOneInput,
  dependencies?: { execFile?: typeof import("node:child_process").execFile },
): Promise<AnalysisEnvelope> {
  return (await executeSiteOne(input, dependencies)).envelope;
}
