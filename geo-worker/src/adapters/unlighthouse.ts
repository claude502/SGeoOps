import { execFile as defaultExecFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  analysisEnvelopeSchema,
  type AnalysisEnvelope,
  type NormalizedObservation,
} from "@sgeo/analysis-contract";

import { startPinnedOriginProxy, type PinnedOriginProxy } from "./pinned-origin-proxy";
import {
  PublicOriginError,
  resolvePublicOrigin,
  validatePublicOrigin,
  type PublicOrigin,
  type PublicOriginLookup,
} from "./public-origin";

export const UNLIGHTHOUSE_BINARY = "unlighthouse-ci";
export const UNLIGHTHOUSE_SOURCE = "unlighthouse";
export const UNLIGHTHOUSE_SOURCE_VERSION = "0.18.0";
export const UNLIGHTHOUSE_ADAPTER_VERSION = "1.0.0";
export const UNLIGHTHOUSE_ARTIFACT_NAME = "unlighthouse-json-expanded.json";
export const UNLIGHTHOUSE_ARTIFACT_MEDIA_TYPE = "application/json";
export const UNLIGHTHOUSE_MAX_TEMPLATE_ROUTES = 10;
export const UNLIGHTHOUSE_MAX_TIMEOUT_SECONDS = 120;
export const UNLIGHTHOUSE_FINALIZATION_RESERVE_SECONDS = 180;
export const UNLIGHTHOUSE_MAX_REPORT_BYTES = 64 * 1024 * 1024;
const UNLIGHTHOUSE_MAX_ROUTE_LENGTH = 2_048;
const UNLIGHTHOUSE_MAX_PROCESS_SECONDS = 900 - UNLIGHTHOUSE_FINALIZATION_RESERVE_SECONDS;
const UNLIGHTHOUSE_REPORT_FILE = "ci-result.json";

export interface UnlighthouseInput {
  runId: string;
  clientId: string;
  brandId: string;
  siteId: string;
  siteMarketId: string | null;
  url: string;
  templateRoutes: string[];
  timeoutSeconds: number;
}

export interface UnlighthouseExecution {
  envelope: AnalysisEnvelope;
  rawReport: Uint8Array | null;
}

export class UnlighthouseInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnlighthouseInputError";
  }
}

export class UnlighthouseExecutionError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean = true) {
    super(message);
    this.name = "UnlighthouseExecutionError";
    this.retryable = retryable;
  }
}

type UnlighthouseDependencies = {
  execFile?: typeof import("node:child_process").execFile;
  lookup?: PublicOriginLookup;
};

type JsonRecord = Record<string, unknown>;

function nonEmptyIdentifier(value: string, name: string) {
  if (value.length === 0 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new UnlighthouseInputError(`${name} must be a bounded, non-control string.`);
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function scoreValue(value: unknown) {
  const score = finiteNumber(value);
  return score !== null && score >= 0 && score <= 1 ? score : null;
}

function canonicalOrigin(origin: PublicOrigin) {
  const defaultPort = (origin.protocol === "http:" && origin.port === 80) ||
    (origin.protocol === "https:" && origin.port === 443);
  return `${origin.protocol}//${origin.hostname}${defaultPort ? "" : `:${origin.port}`}`;
}

function validateTemplateRoute(value: string, origin: PublicOrigin) {
  if (
    value.length === 0 ||
    value.length > UNLIGHTHOUSE_MAX_ROUTE_LENGTH ||
    /[\u0000-\u001f\u007f\\]/.test(value) ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("#")
  ) {
    throw new UnlighthouseInputError("template routes must be bounded same-origin relative paths.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value, canonicalOrigin(origin));
  } catch {
    throw new UnlighthouseInputError("template routes must be valid same-origin relative paths.");
  }
  if (
    parsed.origin !== canonicalOrigin(origin) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new UnlighthouseInputError("template routes must remain on the audited origin.");
  }
  const canonical = `${parsed.pathname}${parsed.search}`;
  if (canonical !== value) {
    throw new UnlighthouseInputError("template routes must use canonical relative paths.");
  }
  return canonical;
}

type ValidatedInput = { origin: PublicOrigin; templateRoutes: string[] };

function validateInput(input: UnlighthouseInput): ValidatedInput {
  nonEmptyIdentifier(input.runId, "runId");
  nonEmptyIdentifier(input.clientId, "clientId");
  nonEmptyIdentifier(input.brandId, "brandId");
  nonEmptyIdentifier(input.siteId, "siteId");
  if (input.siteMarketId !== null) nonEmptyIdentifier(input.siteMarketId, "siteMarketId");
  let origin: PublicOrigin;
  try {
    origin = validatePublicOrigin(input.url);
  } catch (error) {
    if (error instanceof PublicOriginError) throw new UnlighthouseInputError(error.message);
    throw error;
  }
  const parsedStart = new URL(input.url);
  if (parsedStart.pathname !== "/" || parsedStart.search !== "" || parsedStart.hash !== "") {
    throw new UnlighthouseInputError("url must identify an audited origin without a path, query, or fragment.");
  }
  if (
    !Array.isArray(input.templateRoutes) ||
    input.templateRoutes.length === 0 ||
    input.templateRoutes.length > UNLIGHTHOUSE_MAX_TEMPLATE_ROUTES
  ) {
    throw new UnlighthouseInputError(
      `templateRoutes must contain between 1 and ${UNLIGHTHOUSE_MAX_TEMPLATE_ROUTES} routes.`,
    );
  }
  const templateRoutes = input.templateRoutes.map((route) => {
    if (typeof route !== "string") throw new UnlighthouseInputError("template routes must be strings.");
    return validateTemplateRoute(route, origin);
  });
  if (new Set(templateRoutes).size !== templateRoutes.length) {
    throw new UnlighthouseInputError("template routes must not contain duplicates.");
  }
  if (
    !Number.isInteger(input.timeoutSeconds) ||
    input.timeoutSeconds < 1 ||
    input.timeoutSeconds > UNLIGHTHOUSE_MAX_TIMEOUT_SECONDS
  ) {
    throw new UnlighthouseInputError(
      `timeoutSeconds must be an integer between 1 and ${UNLIGHTHOUSE_MAX_TIMEOUT_SECONDS}.`,
    );
  }
  return { origin, templateRoutes };
}

function baseEnvelope(
  input: UnlighthouseInput,
  startedAt: string,
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
    source: UNLIGHTHOUSE_SOURCE,
    sourceVersion: UNLIGHTHOUSE_SOURCE_VERSION,
    adapterVersion: UNLIGHTHOUSE_ADAPTER_VERSION,
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    rawArtifact: null,
    observations,
    error,
  });
}

function failedEnvelope(
  input: UnlighthouseInput,
  startedAt: string,
  code: string,
  message: string,
  retryable: boolean,
) {
  return baseEnvelope(input, startedAt, "failed", [], { code, message, retryable });
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

function categoryScore(categories: JsonRecord, key: string): number | null {
  const category = asRecord(categories[key]);
  return category === null ? null : scoreValue(category.score);
}

function metricValue(metrics: JsonRecord, key: string): number | null {
  const metric = asRecord(metrics[key]);
  const value = metric === null ? null : finiteNumber(metric.numericValue);
  return value !== null && value >= 0 ? value : null;
}

function normalizeReport(
  input: UnlighthouseInput,
  templateRoutes: string[],
  rawReport: Uint8Array,
  startedAt: string,
): AnalysisEnvelope {
  let document: JsonRecord | null;
  try {
    document = asRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawReport)));
  } catch {
    document = null;
  }
  const summary = document === null ? null : asRecord(document.summary);
  const rawRoutes = document === null ? null : document.routes;
  if (
    document === null ||
    summary === null ||
    scoreValue(summary.score) === null ||
    !Array.isArray(rawRoutes) ||
    rawRoutes.length === 0 ||
    rawRoutes.length > templateRoutes.length
  ) {
    return failedEnvelope(
      input,
      startedAt,
      "UNLIGHTHOUSE_INVALID_REPORT",
      "Unlighthouse emitted a report without bounded route results.",
      false,
    );
  }

  const expected = new Set(templateRoutes);
  const observed = new Set<string>();
  const facts: NormalizedObservation[] = [];
  const observedAt = new Date().toISOString();
  const origin = canonicalOrigin(validatePublicOrigin(input.url));
  for (const rawRoute of rawRoutes) {
    const route = asRecord(rawRoute);
    const path = route === null || typeof route.path !== "string" ? null : route.path;
    const categories = route === null ? null : asRecord(route.categories);
    const metrics = route === null ? null : asRecord(route.metrics);
    if (
      path === null ||
      route === null ||
      scoreValue(route.score) === null ||
      categories === null ||
      metrics === null ||
      !expected.has(path) ||
      observed.has(path)
    ) {
      return failedEnvelope(
        input,
        startedAt,
        "UNLIGHTHOUSE_INVALID_REPORT",
        "Unlighthouse emitted an unexpected template route.",
        false,
      );
    }
    const performance = categoryScore(categories, "performance");
    const accessibility = categoryScore(categories, "accessibility");
    const bestPractices = categoryScore(categories, "best-practices");
    const seo = categoryScore(categories, "seo");
    const lcp = metricValue(metrics, "largest-contentful-paint");
    const cls = metricValue(metrics, "cumulative-layout-shift");
    const inp = metricValue(metrics, "interaction-to-next-paint");
    const tbt = metricValue(metrics, "total-blocking-time");
    if (
      performance === null ||
      accessibility === null ||
      bestPractices === null ||
      seo === null ||
      lcp === null ||
      cls === null ||
      (inp === null && tbt === null)
    ) {
      return failedEnvelope(
        input,
        startedAt,
        "UNLIGHTHOUSE_INVALID_REPORT",
        "Unlighthouse emitted a route without required category or Web Vitals values.",
        false,
      );
    }
    const subject = new URL(path, origin).toString();
    facts.push(
      observation("unlighthouse.performance", subject, { score: performance }, observedAt),
      observation("unlighthouse.accessibility", subject, { score: accessibility }, observedAt),
      observation("unlighthouse.best_practices", subject, { score: bestPractices }, observedAt),
      observation("unlighthouse.seo", subject, { score: seo }, observedAt),
      observation("unlighthouse.lcp", subject, { milliseconds: lcp }, observedAt),
      observation("unlighthouse.cls", subject, { score: cls }, observedAt),
      observation("unlighthouse.inp", subject, inp === null
        ? { milliseconds: tbt, metric: "total-blocking-time", fallback: true }
        : { milliseconds: inp, metric: "interaction-to-next-paint", fallback: false }, observedAt),
      observation("unlighthouse.template_url", subject, { path }, observedAt),
    );
    observed.add(path);
  }
  if (observed.size !== expected.size) {
    return baseEnvelope(input, startedAt, "partial", facts, {
      code: "UNLIGHTHOUSE_PARTIAL",
      message: "Unlighthouse completed only a subset of the configured template routes.",
      retryable: false,
    });
  }
  return baseEnvelope(input, startedAt, "succeeded", facts, null);
}

function executionTimeout(input: UnlighthouseInput) {
  return Math.min(
    UNLIGHTHOUSE_MAX_PROCESS_SECONDS * 1_000,
    Math.max(30_000, input.timeoutSeconds * input.templateRoutes.length * 1_000 + 60_000),
  );
}

function buildConfig(
  templateRoutes: string[],
  proxyPort: number,
  browserCacheDirectory: string,
  timeoutSeconds: number,
) {
  return `export default ${JSON.stringify({
    urls: templateRoutes,
    // In v0.18 a single explicit URL can otherwise still add framework routes.
    discovery: false,
    scanner: {
      crawler: false,
      sitemap: false,
      robotsTxt: false,
      dynamicSampling: false,
      maxRoutes: templateRoutes.length,
      samples: 1,
    },
    puppeteerOptions: {
      userDataDir: browserCacheDirectory,
      args: [
        `--proxy-server=http://127.0.0.1:${proxyPort}`,
        "--disable-quic",
      ],
    },
    puppeteerClusterOptions: {
      maxConcurrency: 1,
      retryLimit: 0,
      timeout: timeoutSeconds * 1_000,
    },
    chrome: {
      useSystem: true,
      useDownloadFallback: false,
    },
  })};\n`;
}

function proxyEnvironment(proxyPort: number, workingDirectory: string) {
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  const nodeOptions = `${process.env.NODE_OPTIONS ?? ""} --use-env-proxy`.trim();
  return {
    ...process.env,
    HOME: workingDirectory,
    XDG_CACHE_HOME: join(workingDirectory, "cache"),
    PUPPETEER_CACHE_DIR: join(workingDirectory, "browser-cache"),
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: "",
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    no_proxy: "",
    NODE_OPTIONS: nodeOptions,
  };
}

async function invokeUnlighthouse(
  execFile: typeof defaultExecFile,
  input: UnlighthouseInput,
  outputDirectory: string,
  configFile: string,
  proxyPort: number,
  workingDirectory: string,
) {
  const args = [
    `--site=${input.url}`,
    "--reporter=jsonExpanded",
    `--output-path=${outputDirectory}`,
    `--config-file=${configFile}`,
  ];
  await new Promise<void>((resolveCommand, rejectCommand) => {
    execFile(UNLIGHTHOUSE_BINARY, args, {
      cwd: workingDirectory,
      shell: false,
      timeout: executionTimeout(input),
      maxBuffer: 1_024 * 1_024,
      env: proxyEnvironment(proxyPort, workingDirectory),
    }, (error) => {
      if (error === null) resolveCommand();
      else rejectCommand(error);
    });
  });
}

type RawReport =
  | { kind: "ok"; rawReport: Uint8Array }
  | { kind: "missing" }
  | { kind: "too_large" }
  | { kind: "invalid_output" };

async function readRawReport(outputDirectory: string): Promise<RawReport> {
  const outputFile = resolve(outputDirectory, UNLIGHTHOUSE_REPORT_FILE);
  if (dirname(outputFile) !== resolve(outputDirectory)) return { kind: "invalid_output" };
  try {
    const metadata = await lstat(outputFile);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return { kind: "invalid_output" };
    if (metadata.size > UNLIGHTHOUSE_MAX_REPORT_BYTES) return { kind: "too_large" };
    return { kind: "ok", rawReport: new Uint8Array(await readFile(outputFile)) };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "invalid_output" };
  }
}

export async function executeUnlighthouse(
  input: UnlighthouseInput,
  dependencies: UnlighthouseDependencies = {},
): Promise<UnlighthouseExecution> {
  const validated = validateInput(input);
  let resolvedAddresses;
  try {
    resolvedAddresses = await resolvePublicOrigin(validated.origin, dependencies.lookup);
  } catch (error) {
    if (error instanceof PublicOriginError) throw new UnlighthouseInputError(error.message);
    throw error;
  }
  const startedAt = new Date().toISOString();
  const workingDirectory = await mkdtemp(join(tmpdir(), "sgeo-unlighthouse-"));
  const outputDirectory = join(workingDirectory, "output");
  const browserCacheDirectory = join(workingDirectory, "browser-cache");
  const configFile = join(workingDirectory, "unlighthouse.config.mjs");
  const execFile = dependencies.execFile ?? defaultExecFile;
  let proxy: PinnedOriginProxy | null = null;

  try {
    await Promise.all([
      mkdir(outputDirectory, { mode: 0o700 }),
      mkdir(browserCacheDirectory, { mode: 0o700 }),
    ]);
    try {
      proxy = await startPinnedOriginProxy({
        protocol: validated.origin.protocol,
        hostname: validated.origin.hostname,
        port: validated.origin.port,
        address: resolvedAddresses[0]!.address,
        family: resolvedAddresses[0]!.family,
      });
    } catch {
      throw new UnlighthouseExecutionError("Unlighthouse could not start its pinned origin proxy.");
    }
    await writeFile(
      configFile,
      buildConfig(validated.templateRoutes, proxy.port, browserCacheDirectory, input.timeoutSeconds),
      { mode: 0o600 },
    );
    let commandFailed = false;
    try {
      await invokeUnlighthouse(
        execFile,
        input,
        outputDirectory,
        configFile,
        proxy.port,
        workingDirectory,
      );
    } catch {
      commandFailed = true;
    }
    const report = await readRawReport(outputDirectory);
    if (report.kind === "too_large") {
      return {
        rawReport: null,
        envelope: failedEnvelope(
          input,
          startedAt,
          "UNLIGHTHOUSE_REPORT_TOO_LARGE",
          "Unlighthouse produced a JSON report larger than the 64 MiB safety limit.",
          false,
        ),
      };
    }
    if (report.kind === "invalid_output") {
      return {
        rawReport: null,
        envelope: failedEnvelope(
          input,
          startedAt,
          "UNLIGHTHOUSE_INVALID_OUTPUT",
          "Unlighthouse produced an unsafe report output path or type.",
          false,
        ),
      };
    }
    if (report.kind === "missing") {
      throw new UnlighthouseExecutionError(
        commandFailed
          ? "Unlighthouse did not complete its sampled audit."
          : "Unlighthouse did not emit ci-result.json.",
      );
    }
    if (commandFailed) {
      // A process-level failure is retriable even if it happened to leave an output file.
      // Accepting that file would turn an upstream failure into a false successful delivery.
      throw new UnlighthouseExecutionError("Unlighthouse exited before completing its sampled audit.");
    }
    return {
      rawReport: report.rawReport,
      envelope: normalizeReport(input, validated.templateRoutes, report.rawReport, startedAt),
    };
  } finally {
    try {
      await proxy?.close();
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }
}

export async function runUnlighthouse(
  input: UnlighthouseInput,
  dependencies?: { execFile?: typeof import("node:child_process").execFile },
): Promise<AnalysisEnvelope> {
  return (await executeUnlighthouse(input, dependencies)).envelope;
}
