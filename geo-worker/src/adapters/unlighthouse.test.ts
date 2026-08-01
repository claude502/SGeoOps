import { access, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
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
  it("forces every Chromium request through the pinned proxy while normalizing every required metric", async () => {
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
    // The loopback bypass removal sends all browser navigation through the pinned proxy,
    // which rejects any host outside the validated origin; WebRTC must not bypass it via UDP.
    expect(command[0]?.config).toContain('"--proxy-server=http://127.0.0.1:');
    expect(command[0]?.config).toContain('"--proxy-bypass-list=<-loopback>"');
    expect(command[0]?.config).toContain('"--force-webrtc-ip-handling-policy=disable_non_proxied_udp"');
    expect(command[0]?.config).toContain('"--disable-quic"');
    expect(command[0]?.config).not.toContain("direct://");
    expect(command[0]?.config).toContain('"executablePath":"/usr/bin/chromium"');
    expect(command[0]?.env?.PUPPETEER_EXECUTABLE_PATH).toBe("/usr/bin/chromium");
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

  it("rejects a score-only summary even when every route has complete metrics", async () => {
    const rawReport = await fixture("invalid-summary-aggregate.json");

    const result = await executeUnlighthouse(input, {
      execFile: successfulCli(rawReport, []),
      lookup: publicLookup(),
    });

    expect(result).toMatchObject({
      rawReport: new Uint8Array(rawReport),
      envelope: {
        status: "failed",
        error: { code: "UNLIGHTHOUSE_INVALID_REPORT", retryable: false },
      },
    });
  });

  it.each([
    ["performance category", ["categories", "performance"]],
    ["accessibility category", ["categories", "accessibility"]],
    ["best-practices category", ["categories", "best-practices"]],
    ["SEO category", ["categories", "seo"]],
    ["LCP metric", ["metrics", "largest-contentful-paint"]],
    ["CLS metric", ["metrics", "cumulative-layout-shift"]],
    ["both INP and TBT metrics", ["metrics", "interaction-to-next-paint", "total-blocking-time"]],
  ])("rejects a summary missing the required %s", async (_label, path) => {
    const document = JSON.parse((await fixture("success.json")).toString("utf8")) as {
      summary: { categories: Record<string, unknown>; metrics: Record<string, unknown> };
    };
    const [section, ...keys] = path;
    const summarySection = document.summary[section as "categories" | "metrics"];
    for (const key of keys) delete summarySection[key];
    const rawReport = new TextEncoder().encode(JSON.stringify(document));

    const result = await executeUnlighthouse(input, {
      execFile: successfulCli(rawReport, []),
      lookup: publicLookup(),
    });

    expect(result.envelope).toMatchObject({
      status: "failed",
      error: { code: "UNLIGHTHOUSE_INVALID_REPORT", retryable: false },
    });
  });

  it("accepts aggregate INP when TBT is absent", async () => {
    const document = JSON.parse((await fixture("success.json")).toString("utf8")) as {
      summary: { metrics: Record<string, unknown> };
      routes: Array<{ metrics: Record<string, unknown> }>;
    };
    delete document.summary.metrics["total-blocking-time"];
    document.summary.metrics["interaction-to-next-paint"] = { averageNumericValue: 82 };
    for (const route of document.routes) {
      delete route.metrics["total-blocking-time"];
      route.metrics["interaction-to-next-paint"] = { numericValue: 80 };
    }
    const rawReport = new TextEncoder().encode(JSON.stringify(document));

    const result = await executeUnlighthouse(input, {
      execFile: successfulCli(rawReport, []),
      lookup: publicLookup(),
    });

    expect(result.envelope).toMatchObject({ status: "succeeded", error: null });
    expect(result.envelope.observations).toContainEqual(expect.objectContaining({
      kind: "unlighthouse.inp",
      value: expect.objectContaining({ metric: "interaction-to-next-paint", fallback: false }),
    }));
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

  it("rejects malformed runtime input before DNS resolution or CLI execution", async () => {
    const execFile = vi.fn();
    const lookup = vi.fn();

    await expect(executeUnlighthouse({
      ...input,
      runId: 7,
    } as unknown as UnlighthouseInput, {
      execFile: execFile as unknown as typeof import("node:child_process").execFile,
      lookup,
    })).rejects.toBeInstanceOf(UnlighthouseInputError);

    expect(lookup).not.toHaveBeenCalled();
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

  it("rejects a symlink ci-result.json instead of following an untrusted output path", async () => {
    const rawReport = await fixture("success.json");
    const execFile = ((_file: unknown, args: unknown, _options: unknown, callback: unknown) => {
      const outputPath = (args as string[]).find((arg) => arg.startsWith("--output-path="))?.slice(14);
      if (outputPath === undefined) throw new Error("missing output path");
      const target = join(outputPath, "other-report.json");
      void writeFile(target, rawReport)
        .then(() => symlink("other-report.json", join(outputPath, "ci-result.json")))
        .then(() => (callback as (error: Error | null) => void)(null));
      return {};
    }) as unknown as typeof import("node:child_process").execFile;

    const result = await executeUnlighthouse(input, { execFile, lookup: publicLookup() });

    expect(result).toMatchObject({
      rawReport: null,
      envelope: {
        status: "failed",
        error: { code: "UNLIGHTHOUSE_INVALID_OUTPUT", retryable: false },
      },
    });
  });

  it.each([
    ["grows", 1, 0],
    ["shrinks", -1, 0],
    ["changes descriptor identity", 0, 1],
  ])("rejects a report that %s after a same-descriptor read and closes the handle", async (
    _scenario,
    sizeDelta,
    inodeDelta,
  ) => {
    const rawReport = await fixture("success.json");
    const handle = {
      stat: vi.fn()
        .mockResolvedValueOnce({ isFile: () => true, size: rawReport.byteLength, dev: 1, ino: 1 })
        .mockResolvedValueOnce({
          isFile: () => true,
          size: rawReport.byteLength + sizeDelta,
          dev: 1,
          ino: 1 + inodeDelta,
        }),
      read: vi.fn(async (buffer: Buffer) => {
        rawReport.copy(buffer);
        return { bytesRead: rawReport.byteLength, buffer };
      }),
      close: vi.fn(async () => {}),
    };
    const openReportFile = vi.fn(async () => handle);

    const result = await executeUnlighthouse(input, {
      execFile: successfulCli(rawReport, []),
      lookup: publicLookup(),
      openReportFile: openReportFile as never,
    });

    expect(openReportFile).toHaveBeenCalledWith(
      expect.stringMatching(/ci-result\.json$/),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    expect(handle.read).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      rawReport: null,
      envelope: {
        status: "failed",
        error: { code: "UNLIGHTHOUSE_INVALID_OUTPUT", retryable: false },
      },
    });
  });
});
