import { access, readFile, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  executeUnlighthouse,
  UNLIGHTHOUSE_MAX_REPORT_BYTES,
  UnlighthouseExecutionError,
  UnlighthouseInputError,
  type UnlighthouseInput,
} from "./unlighthouse";

const input: UnlighthouseInput = {
  runId: "run_123",
  clientId: "client_123",
  brandId: "brand_123",
  siteId: "site_123",
  siteMarketId: null,
  url: "https://audit.example/",
  templateRoutes: ["/", "/pricing"],
  timeoutSeconds: 30,
};

type CapturedCommand = {
  file: string;
  args: string[];
  cwd: string;
  shell: boolean | undefined;
  env: NodeJS.ProcessEnv | undefined;
  config: string;
};

function fixture(name: string) {
  return readFile(new URL(`../../test/fixtures/unlighthouse/${name}`, import.meta.url));
}

function publicLookup() {
  return vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
}

function successfulCli(rawReport: Uint8Array, command: CapturedCommand[]) {
  return ((file: unknown, args: unknown, options: unknown, callback: unknown) => {
    const commandArgs = args as string[];
    const commandOptions = options as { cwd: string; shell?: boolean; env?: NodeJS.ProcessEnv };
    const outputPath = commandArgs.find((arg) => arg.startsWith("--output-path="))?.slice(14);
    const configPath = commandArgs.find((arg) => arg.startsWith("--config-file="))?.slice(14);
    if (outputPath === undefined || configPath === undefined) throw new Error("missing required CLI argument");

    void Promise.all([
      writeFile(join(outputPath, "ci-result.json"), rawReport),
      readFile(configPath, "utf8"),
    ]).then(([, config]) => {
      command.push({
        file: file as string,
        args: commandArgs,
        cwd: commandOptions.cwd,
        shell: commandOptions.shell,
        env: commandOptions.env,
        config,
      });
      (callback as (error: Error | null, stdout: string, stderr: string) => void)(null, "", "");
    });
    return {};
  }) as unknown as typeof import("node:child_process").execFile;
}

describe("Unlighthouse adapter", () => {
  it("runs exact 0.18.0 jsonExpanded CLI arguments through the pinned proxy and normalizes every required metric", async () => {
    const rawReport = await fixture("success.json");
    const command: CapturedCommand[] = [];

    const result = await executeUnlighthouse(input, {
      execFile: successfulCli(rawReport, command),
      lookup: publicLookup(),
    });

    expect(result.rawReport).toEqual(new Uint8Array(rawReport));
    expect(result.envelope).toMatchObject({
      source: "unlighthouse",
      sourceVersion: "0.18.0",
      status: "succeeded",
      error: null,
    });
    expect(result.envelope.observations.map((fact) => fact.kind)).toEqual(expect.arrayContaining([
      "unlighthouse.performance",
      "unlighthouse.accessibility",
      "unlighthouse.best_practices",
      "unlighthouse.seo",
      "unlighthouse.lcp",
      "unlighthouse.cls",
      "unlighthouse.inp",
      "unlighthouse.template_url",
    ]));
    expect(result.envelope.observations).toContainEqual(expect.objectContaining({
      kind: "unlighthouse.inp",
      subject: "https://audit.example/",
      value: expect.objectContaining({ metric: "total-blocking-time", fallback: true, milliseconds: 100 }),
    }));
    expect(result.envelope.observations).toContainEqual(expect.objectContaining({
      kind: "unlighthouse.template_url",
      subject: "https://audit.example/pricing",
    }));
    expect(command).toHaveLength(1);
    expect(command[0]).toMatchObject({ file: "unlighthouse-ci", shell: false });
    expect(command[0]?.args).toEqual(expect.arrayContaining([
      "--site=https://audit.example/",
      "--reporter=jsonExpanded",
      expect.stringMatching(/^--output-path=/),
      expect.stringMatching(/^--config-file=/),
    ]));
    expect(command[0]?.args.join(" ")).not.toContain("--urls=");
    expect(command[0]?.config).toContain('"urls":["/","/pricing"]');
    expect(command[0]?.config).toContain('"crawler":false');
    expect(command[0]?.config).toContain('"discovery":false');
    expect(command[0]?.config).toContain('"--proxy-server=http://127.0.0.1:');
    expect(command[0]?.env).toMatchObject({
      NODE_OPTIONS: expect.stringContaining("--use-env-proxy"),
      HTTP_PROXY: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
      HTTPS_PROXY: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
      NO_PROXY: "",
    });
    await expect(access(command[0]!.cwd)).rejects.toThrow();
  });

  it("marks a valid report with one missing configured template as partial", async () => {
    const rawReport = await fixture("mixed-partial.json");

    const result = await executeUnlighthouse(input, {
      execFile: successfulCli(rawReport, []),
      lookup: publicLookup(),
    });

    expect(result.envelope).toMatchObject({
      status: "partial",
      error: { code: "UNLIGHTHOUSE_PARTIAL", retryable: false },
    });
    expect(result.envelope.observations).toHaveLength(8);
  });

  it("preserves raw invalid reports but classifies their schema and route violations as permanent", async () => {
    const rawReport = await fixture("invalid.json");

    const result = await executeUnlighthouse(input, {
      execFile: successfulCli(rawReport, []),
      lookup: publicLookup(),
    });

    expect(result.rawReport).toEqual(new Uint8Array(rawReport));
    expect(result.envelope).toMatchObject({
      status: "failed",
      error: { code: "UNLIGHTHOUSE_INVALID_REPORT", retryable: false },
    });
  });

  it("rejects a route-shaped JSON document that is missing jsonExpanded summary provenance", async () => {
    const document = JSON.parse((await fixture("success.json")).toString("utf8")) as Record<string, unknown>;
    delete document.summary;
    const rawReport = new TextEncoder().encode(JSON.stringify(document));

    const result = await executeUnlighthouse(input, {
      execFile: successfulCli(rawReport, []),
      lookup: publicLookup(),
    });

    expect(result).toMatchObject({
      rawReport,
      envelope: {
        status: "failed",
        error: { code: "UNLIGHTHOUSE_INVALID_REPORT", retryable: false },
      },
    });
  });

  it("rejects a private or mixed DNS response before it creates a proxy or spawns the CLI", async () => {
    const execFile = vi.fn();

    await expect(executeUnlighthouse(input, {
      execFile: execFile as unknown as typeof import("node:child_process").execFile,
      lookup: vi.fn(async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    })).rejects.toBeInstanceOf(UnlighthouseInputError);

    expect(execFile).not.toHaveBeenCalled();
  });

  it("rejects absolute, cross-origin, control-character, and unbounded template routes before spawning", async () => {
    const execFile = vi.fn();
    const invalidInputs = [
      { ...input, templateRoutes: ["https://foreign.example/"] },
      { ...input, templateRoutes: ["//foreign.example/"] },
      { ...input, templateRoutes: ["/pricing\n--site=https://foreign.example"] },
      { ...input, templateRoutes: Array.from({ length: 11 }, (_, index) => `/route-${index}`) },
    ];

    for (const invalidInput of invalidInputs) {
      await expect(executeUnlighthouse(invalidInput, {
        execFile: execFile as unknown as typeof import("node:child_process").execFile,
        lookup: publicLookup(),
      })).rejects.toBeInstanceOf(UnlighthouseInputError);
    }

    expect(execFile).not.toHaveBeenCalled();
  });

  it("returns a retryable execution error when the CLI does not emit its exact report file", async () => {
    const errorFixture = JSON.parse((await fixture("upstream-error.json")).toString("utf8")) as {
      message: string;
    };
    const execFile = ((_file: unknown, _args: unknown, _options: unknown, callback: unknown) => {
      (callback as (error: Error) => void)(new Error(errorFixture.message));
      return {};
    }) as unknown as typeof import("node:child_process").execFile;

    await expect(executeUnlighthouse(input, { execFile, lookup: publicLookup() }))
      .rejects.toMatchObject({
        name: "UnlighthouseExecutionError",
        retryable: true,
      } satisfies Partial<UnlighthouseExecutionError>);
  });

  it("keeps a nonzero CLI exit retryable even when a stale report file exists", async () => {
    const rawReport = await fixture("success.json");
    const execFile = ((_file: unknown, args: unknown, _options: unknown, callback: unknown) => {
      const outputPath = (args as string[]).find((arg) => arg.startsWith("--output-path="))?.slice(14);
      if (outputPath === undefined) throw new Error("missing output path");
      void writeFile(join(outputPath, "ci-result.json"), rawReport)
        .then(() => (callback as (error: Error) => void)(new Error("upstream process failure")));
      return {};
    }) as unknown as typeof import("node:child_process").execFile;

    await expect(executeUnlighthouse(input, { execFile, lookup: publicLookup() }))
      .rejects.toMatchObject({
        name: "UnlighthouseExecutionError",
        retryable: true,
      } satisfies Partial<UnlighthouseExecutionError>);
  });

  it("rejects an oversized ci-result.json before loading its bytes", async () => {
    const execFile = ((_file: unknown, args: unknown, _options: unknown, callback: unknown) => {
      const outputPath = (args as string[]).find((arg) => arg.startsWith("--output-path="))?.slice(14);
      if (outputPath === undefined) throw new Error("missing output path");
      void writeFile(join(outputPath, "ci-result.json"), "")
        .then(() => truncate(join(outputPath, "ci-result.json"), UNLIGHTHOUSE_MAX_REPORT_BYTES + 1))
        .then(() => (callback as (error: Error | null) => void)(null));
      return {};
    }) as unknown as typeof import("node:child_process").execFile;

    const result = await executeUnlighthouse(input, { execFile, lookup: publicLookup() });

    expect(result).toMatchObject({
      rawReport: null,
      envelope: {
        status: "failed",
        error: { code: "UNLIGHTHOUSE_REPORT_TOO_LARGE", retryable: false },
      },
    });
  });
});
