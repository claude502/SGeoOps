import type { execFile as execFileType } from "node:child_process";
import { readFile, stat, truncate, writeFile } from "node:fs/promises";

import type { AnalysisEnvelope } from "@sgeo/analysis-contract";
import { describe, expect, it } from "vitest";

import {
  executeSiteOne,
  runSiteOne,
  SITEONE_ARTIFACT_MEDIA_TYPE,
  SITEONE_ARTIFACT_NAME,
  SITEONE_BINARY,
  SITEONE_FINALIZATION_RESERVE_SECONDS,
  SITEONE_MAX_TIMEOUT_SECONDS,
  SITEONE_STRUCTURED_DATA_REGEXP,
  type SiteOneLookup,
} from "./siteone";

type ExecFile = typeof execFileType;
type ExecCall = {
  binary: string;
  args: string[];
  options: Record<string, unknown>;
};

const input = {
  runId: "run_123",
  clientId: "client_123",
  brandId: "brand_123",
  siteId: "site_123",
  siteMarketId: null,
  url: "https://example.test/",
  maxUrls: 25,
  timeoutSeconds: 30,
};

const publicLookup: SiteOneLookup = async () => [{
  address: "93.184.216.34",
  family: 4,
}];

function fixtureUrl(name: string) {
  return new URL(`../../test/fixtures/siteone/${name}`, import.meta.url);
}

function fixtureExec(name: string, calls: ExecCall[]): ExecFile {
  return ((
    binary: string,
    args: readonly string[],
    options: unknown,
    callback?: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls.push({
      binary,
      args: [...args],
      options: options as Record<string, unknown>,
    });
    const outputArgument = args.find((arg) =>
      arg.startsWith("--output-json-file="),
    );
    if (outputArgument === undefined) {
      throw new Error("missing JSON output argument");
    }
    const outputFile = outputArgument.slice("--output-json-file=".length);
    void readFile(fixtureUrl(name)).then(async (body) => {
      await writeFile(outputFile, body);
      callback?.(null, "", "");
    });
    return {} as ReturnType<ExecFile>;
  }) as unknown as ExecFile;
}

function failingExec(calls: ExecCall[]): ExecFile {
  return ((
    binary: string,
    args: readonly string[],
    options: unknown,
    callback?: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls.push({
      binary,
      args: [...args],
      options: options as Record<string, unknown>,
    });
    queueMicrotask(() => callback?.(new Error("crawler unavailable"), "", ""));
    return {} as ReturnType<ExecFile>;
  }) as unknown as ExecFile;
}

function oversizedExec(calls: ExecCall[]): ExecFile {
  return ((
    binary: string,
    args: readonly string[],
    options: unknown,
    callback?: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls.push({
      binary,
      args: [...args],
      options: options as Record<string, unknown>,
    });
    const outputArgument = args.find((arg) => arg.startsWith("--output-json-file="));
    if (outputArgument === undefined) throw new Error("missing JSON output argument");
    const outputFile = outputArgument.slice("--output-json-file=".length);
    void writeFile(outputFile, "")
      .then(() => truncate(outputFile, 64 * 1024 * 1024 + 1))
      .then(() => callback?.(null, "", ""));
    return {} as ReturnType<ExecFile>;
  }) as unknown as ExecFile;
}

function jsonExec(body: string, calls: ExecCall[]): ExecFile {
  return ((
    binary: string,
    args: readonly string[],
    options: unknown,
    callback?: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls.push({ binary, args: [...args], options: options as Record<string, unknown> });
    const outputArgument = args.find((arg) => arg.startsWith("--output-json-file="));
    if (outputArgument === undefined) throw new Error("missing JSON output argument");
    const outputFile = outputArgument.slice("--output-json-file=".length);
    void writeFile(outputFile, body).then(() => callback?.(null, "", ""));
    return {} as ReturnType<ExecFile>;
  }) as unknown as ExecFile;
}

function facts(envelope: AnalysisEnvelope, kind: string) {
  return envelope.observations.filter((observation) => observation.kind === kind);
}

describe("SiteOne technical audit adapter", () => {
  it("pins a validated public origin and confines the crawler to injection-safe argv", async () => {
    const calls: ExecCall[] = [];
    const execution = await executeSiteOne(
      {
        ...input,
        url: "https://example.test/?q=$(touch%20/tmp/not-run)",
      },
      { execFile: fixtureExec("success.json", calls), lookup: publicLookup },
    );

    expect(execution.envelope.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      binary: SITEONE_BINARY,
      options: { shell: false },
    });
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      "--url=https://example.test/?q=$(touch%20/tmp/not-run)",
      "--max-visited-urls=25",
      "--timeout=30",
      "--workers=1",
      "--max-reqs-per-sec=2",
      "--resolve=example.test:443:93.184.216.34",
      "--include-regex=^https:\\/\\/example\\.test(?::443)?(?:[\\/?#]|$)",
      "--memory-limit=512M",
      "--max-queue-length=25",
      "--max-skipped-urls=25",
      "--disable-all-assets",
      "--no-cache",
      "--hide-progress-bar",
      `--extra-columns=SgeoStructuredData=regexp:${SITEONE_STRUCTURED_DATA_REGEXP}#1(4096)`,
      "--output-html-report=",
      "--output-text-file=",
    ]));
    expect(calls[0]?.args).not.toContain("--output=json");
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      expect.stringMatching(/^--config-file=.*siteone\.conf$/),
    ]));

    const outputArgument = calls[0]?.args.find((arg) =>
      arg.startsWith("--output-json-file="),
    );
    expect(outputArgument).toBeDefined();
    await expect(
      stat(outputArgument!.slice("--output-json-file=".length)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses SiteOne's extra-column grammar with a Rust-compatible structured-data regexp", async () => {
    const calls: ExecCall[] = [];
    await executeSiteOne(input, {
      execFile: fixtureExec("success.json", calls),
      lookup: publicLookup,
    });

    const definition = calls[0]?.args.find((arg) => arg.startsWith("--extra-columns="));
    expect(definition).toBeDefined();
    const parsed = /^--extra-columns=([^=]+)=(xpath|regexp):(.+?)(?:#(\d+))?(?:\((\d+)(>?)\))?$/.exec(
      definition!,
    );
    expect(parsed?.slice(1)).toEqual([
      "SgeoStructuredData",
      "regexp",
      SITEONE_STRUCTURED_DATA_REGEXP,
      "1",
      "4096",
      "",
    ]);
    expect(SITEONE_STRUCTURED_DATA_REGEXP).toMatch(/^\(\?is\)/);
    expect(SITEONE_STRUCTURED_DATA_REGEXP).not.toMatch(/^\/.+\/i$/);
  });

  it("preserves exact raw JSON separately while normalizing all technical facts", async () => {
    const calls: ExecCall[] = [];
    const rawFixture = await readFile(fixtureUrl("success.json"));
    const execution = await executeSiteOne(input, {
      execFile: fixtureExec("success.json", calls),
      lookup: publicLookup,
    });

    expect(execution.rawReport).toEqual(new Uint8Array(rawFixture));
    expect(execution.envelope).toMatchObject({
      source: "siteone",
      sourceVersion: "2.5.1",
      adapterVersion: "1.0.0",
      rawArtifact: null,
      status: "succeeded",
    });
    expect(facts(execution.envelope, "siteone.http_status")).toContainEqual(
      expect.objectContaining({
        subject: "https://example.test/",
        value: { statusCode: 200 },
      }),
    );
    expect(facts(execution.envelope, "siteone.indexability")).toContainEqual(
      expect.objectContaining({
        subject: "https://example.test/",
        value: expect.objectContaining({ indexable: true }),
      }),
    );
    expect(facts(execution.envelope, "siteone.canonical_mismatch")).toContainEqual(
      expect.objectContaining({
        subject: "https://example.test/",
        value: {
          count: 1,
        },
      }),
    );
    expect(facts(execution.envelope, "siteone.title")).toContainEqual(
      expect.objectContaining({ value: { text: "Example home" } }),
    );
    expect(facts(execution.envelope, "siteone.heading")).toContainEqual(
      expect.objectContaining({ value: expect.objectContaining({ count: 2 }) }),
    );
    expect(facts(execution.envelope, "siteone.structured_data")).toContainEqual(
      expect.objectContaining({
        value: { count: 2, types: ["Organization", "BreadcrumbList"] },
      }),
    );
    expect(facts(execution.envelope, "siteone.broken_link")).toContainEqual(
      expect.objectContaining({
        subject: "https://example.test/missing",
        value: {
          sourceUrl: "https://example.test/",
          statusCode: 404,
        },
      }),
    );
    expect(SITEONE_ARTIFACT_NAME).toBe("siteone-report.json");
    expect(SITEONE_ARTIFACT_MEDIA_TYPE).toBe("application/json");
  });

  it("returns a partial envelope when SiteOne reports a bounded incomplete crawl", async () => {
    const execution = await executeSiteOne(input, {
      execFile: fixtureExec("partial.json", []),
      lookup: publicLookup,
    });

    expect(execution.rawReport).not.toBeNull();
    expect(execution.envelope).toMatchObject({
      status: "partial",
      error: {
        code: "SITEONE_PARTIAL",
        retryable: false,
      },
    });
  });

  it("treats a report that reaches the requested URL cap as partial", async () => {
    const execution = await executeSiteOne({ ...input, maxUrls: 2 }, {
      execFile: fixtureExec("success.json", []),
      lookup: publicLookup,
    });

    expect(execution.envelope).toMatchObject({
      status: "partial",
      error: { code: "SITEONE_PARTIAL", retryable: false },
    });
  });

  it("keeps an invalid report available for archival and returns a safe failed envelope", async () => {
    const execution = await executeSiteOne(input, {
      execFile: fixtureExec("invalid.json", []),
      lookup: publicLookup,
    });

    expect(execution.rawReport).not.toBeNull();
    expect(execution.envelope).toMatchObject({
      status: "failed",
      error: { code: "SITEONE_INVALID_REPORT", retryable: false },
      observations: [],
    });
  });

  it.each([
    ["rate-limited.json", "SITEONE_RATE_LIMITED", true],
    ["unauthorized.json", "SITEONE_UNAUTHORIZED", false],
    ["upstream-error.json", "SITEONE_UPSTREAM_ERROR", true],
  ])("classifies SiteOne %s reports", async (fixture, code, retryable) => {
    const execution = await executeSiteOne(input, {
      execFile: fixtureExec(fixture, []),
      lookup: publicLookup,
    });

    expect(execution.envelope).toMatchObject({
      status: "failed",
      error: { code, retryable },
    });
  });

  it("returns a retryable failed envelope and removes temporary state when the command fails", async () => {
    const calls: ExecCall[] = [];
    const execution = await executeSiteOne(input, {
      execFile: failingExec(calls),
      lookup: publicLookup,
    });

    expect(execution).toMatchObject({
      rawReport: null,
      envelope: {
        status: "failed",
        error: { code: "SITEONE_EXECUTION_FAILED", retryable: true },
      },
    });
    const outputArgument = calls[0]?.args.find((arg) =>
      arg.startsWith("--output-json-file="),
    );
    await expect(
      stat(outputArgument!.slice("--output-json-file=".length)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when SiteOne returns more rows than the bounded input permits", async () => {
    const execution = await executeSiteOne({ ...input, maxUrls: 1 }, {
      execFile: fixtureExec("success.json", []),
      lookup: publicLookup,
    });

    expect(execution).toMatchObject({
      rawReport: expect.any(Uint8Array),
      envelope: {
        status: "failed",
        error: { code: "SITEONE_REPORT_LIMIT_EXCEEDED", retryable: false },
        observations: [],
      },
    });
  });

  it("rejects literal, private, mixed, and unresolved origins before spawning SiteOne", async () => {
    const execFile = fixtureExec("success.json", []);

    await expect(runSiteOne({ ...input, url: "file:///etc/passwd" }, { execFile }))
      .rejects.toThrow("http or https");
    for (const url of [
      "http://8.8.8.8/",
      "http://[::1]/",
      "http://[::ffff:7f00:1]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
    ]) {
      await expect(runSiteOne({ ...input, url }, { execFile }))
        .rejects.toThrow("hostname");
    }
    const calls: ExecCall[] = [];
    await expect(executeSiteOne(input, {
      execFile: fixtureExec("success.json", calls),
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ],
    })).rejects.toThrow("globally routable");
    await expect(executeSiteOne(input, {
      execFile: fixtureExec("success.json", calls),
      lookup: async () => {
        throw new Error("resolver unavailable");
      },
    })).rejects.toThrow("could not be resolved");
    expect(calls).toEqual([]);
    await expect(runSiteOne({ ...input, maxUrls: 51 }, { execFile }))
      .rejects.toThrow("maxUrls");
    await expect(runSiteOne({ ...input, timeoutSeconds: SITEONE_MAX_TIMEOUT_SECONDS + 1 }, { execFile }))
      .rejects.toThrow("timeoutSeconds");
  });

  it("rejects a missing or stale SiteOne report identity while retaining raw bytes for archival", async () => {
    for (const crawler of [
      undefined,
      { name: "SiteOne Crawler", version: "2.5.0.20250101" },
      { name: "Something else", version: "2.5.1.20260627" },
    ]) {
      const calls: ExecCall[] = [];
      const execution = await executeSiteOne(input, {
        execFile: jsonExec(JSON.stringify({ crawler, results: [] }), calls),
        lookup: publicLookup,
      });

      expect(calls).toHaveLength(1);
      expect(execution).toMatchObject({
        rawReport: expect.any(Uint8Array),
        envelope: {
          status: "failed",
          error: { code: "SITEONE_INVALID_REPORT", retryable: false },
        },
      });
    }
  });

  it("supports only the bounded legacy keyed extras shape as a compatibility fallback", async () => {
    const execution = await executeSiteOne(input, {
      execFile: jsonExec(JSON.stringify({
        crawler: { name: "SiteOne Crawler", version: "2.5.1.20260627" },
        results: [{
          url: "https://example.test/",
          status: "200",
          extras: {
            SgeoStructuredData: "{\"@type\":\"Organization\"}",
          },
        }],
      }), []),
      lookup: publicLookup,
    });

    expect(facts(execution.envelope, "siteone.structured_data")).toContainEqual(
      expect.objectContaining({ value: { count: 1, types: ["Organization"] } }),
    );
  });

  it("classifies a report over 64 MiB without reading it into the envelope", async () => {
    const execution = await executeSiteOne(input, {
      execFile: oversizedExec([]),
      lookup: publicLookup,
    });

    expect(execution).toMatchObject({
      rawReport: null,
      envelope: {
        status: "failed",
        error: { code: "SITEONE_REPORT_TOO_LARGE", retryable: false },
      },
    });
  });

  it("reserves finalization time below Trigger's 900 second task duration", async () => {
    const calls: ExecCall[] = [];
    await executeSiteOne({ ...input, timeoutSeconds: SITEONE_MAX_TIMEOUT_SECONDS }, {
      execFile: fixtureExec("success.json", calls),
      lookup: publicLookup,
    });

    expect(SITEONE_FINALIZATION_RESERVE_SECONDS).toBeGreaterThanOrEqual(120);
    expect(calls[0]?.options).toMatchObject({
      timeout: expect.any(Number),
    });
    expect(calls[0]?.options.timeout).toBeLessThanOrEqual(
      (900 - SITEONE_FINALIZATION_RESERVE_SECONDS) * 1_000,
    );
  });

  it("pins the official musl release assets and fails unsupported Docker target architectures", async () => {
    const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");

    expect(dockerfile).toContain("ARG TARGETARCH");
    expect(dockerfile).toContain(
      "FROM node:24-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3",
    );
    expect(dockerfile).toContain(
      "siteone-crawler-v2.5.1-linux-musl-x64.tar.gz",
    );
    expect(dockerfile).toContain(
      "bd96b9502563aea2581fc248625871e69b60d7f1bb68a484f226c551c73706fd",
    );
    expect(dockerfile).toContain(
      "siteone-crawler-v2.5.1-linux-musl-arm64.tar.gz",
    );
    expect(dockerfile).toContain(
      "cad85649c09a4181ae36e47269caff647fe7e2bb556dc388b5f7aede6e420e20",
    );
    expect(dockerfile).toContain('echo "Unsupported TARGETARCH: $TARGETARCH"');
    expect(dockerfile).toContain("sha256sum -c -");
    expect(dockerfile).toContain("/tmp/siteone/siteone-crawler/siteone-crawler");
    expect(dockerfile).toContain("adduser -S -G sgeo sgeo");
    expect(dockerfile).toContain("USER sgeo");
    expect(dockerfile).not.toMatch(/^CMD\s/m);
  });
});
