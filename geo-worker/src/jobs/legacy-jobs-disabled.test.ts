import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jobs: [] as Array<{
    id: string;
    run: (payload: unknown, io: unknown) => Promise<unknown>;
  }>,
  prismaConstructor: vi.fn(),
  siteFindFirst: vi.fn(),
  trendFindFirst: vi.fn(),
  trendUpdateMany: vi.fn(),
  trendCreate: vi.fn(),
  fetchGoogleTrends: vi.fn(),
  fetchWeiboTrending: vi.fn(),
  signInternalRequest: vi.fn(),
  fetch: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("../trigger", () => ({
  client: {
    defineJob: (job: (typeof mocks.jobs)[number]) => {
      mocks.jobs.push(job);
      return job;
    },
  },
}));

vi.mock("@trigger.dev/sdk", () => ({
  cronTrigger: vi.fn((options) => options),
  eventTrigger: vi.fn((options) => options),
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: class PrismaClient {
    site = { findFirst: mocks.siteFindFirst };
    trendTopic = {
      findFirst: mocks.trendFindFirst,
      updateMany: mocks.trendUpdateMany,
      create: mocks.trendCreate,
    };

    constructor() {
      mocks.prismaConstructor();
    }
  },
}));

vi.mock("../clients/google-trends", () => ({
  fetchGoogleTrends: mocks.fetchGoogleTrends,
}));

vi.mock("../clients/firecrawl", () => ({
  fetchWeiboTrending: mocks.fetchWeiboTrending,
}));

vi.mock("@sgeo/internal-protocol", () => ({
  signInternalRequest: mocks.signInternalRequest,
}));

describe("disabled legacy workers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SGEO_INTERNAL_SECRET;
  });

  it("fails both jobs before any database, crawler, or API call", async () => {
    mocks.jobs.length = 0;
    vi.clearAllMocks();
    process.env.SGEO_INTERNAL_SECRET = "test-secret";
    mocks.siteFindFirst.mockResolvedValue({ id: "site_a" });
    mocks.fetchGoogleTrends.mockResolvedValue([]);
    mocks.fetchWeiboTrending.mockResolvedValue([]);
    mocks.signInternalRequest.mockResolvedValue({
      timestamp: "1",
      signature: "signature",
    });
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", mocks.fetch);

    await import("./trend-crawl");
    await import("./content-generate");

    expect(mocks.jobs.map((job) => job.id).sort()).toEqual([
      "content-generate",
      "trend-crawl",
    ]);

    const io = { logger: { info: mocks.loggerInfo } };
    for (const job of mocks.jobs) {
      let thrown: unknown;
      try {
        await job.run(
          { topicId: "topic_a", keyword: "keyword", platform: "manual" },
          io,
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown, job.id).toMatchObject({
        name: "LegacyWorkerDisabledError",
        code: "LEGACY_WORKER_DISABLED_USE_SGEO_API",
        message: "LEGACY_WORKER_DISABLED_USE_SGEO_API",
        retryable: false,
      });
    }

    expect(mocks.prismaConstructor).not.toHaveBeenCalled();
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.trendFindFirst).not.toHaveBeenCalled();
    expect(mocks.trendUpdateMany).not.toHaveBeenCalled();
    expect(mocks.trendCreate).not.toHaveBeenCalled();
    expect(mocks.fetchGoogleTrends).not.toHaveBeenCalled();
    expect(mocks.fetchWeiboTrending).not.toHaveBeenCalled();
    expect(mocks.signInternalRequest).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).not.toHaveBeenCalled();
  });
});
