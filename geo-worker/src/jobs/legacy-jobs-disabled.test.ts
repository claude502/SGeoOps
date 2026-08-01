import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jobs: [] as Array<{
    id: string;
    run: (payload: unknown, io: unknown) => Promise<unknown>;
  }>,
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

describe("disabled legacy workers", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("fails both legacy direct-write jobs with the API migration error", async () => {
    mocks.jobs.length = 0;
    vi.clearAllMocks();

    await import("./trend-crawl");
    await import("./content-generate");

    expect(mocks.jobs.map((job) => job.id).sort()).toEqual([
      "content-generate",
      "trend-crawl",
    ]);

    const io = {};
    for (const job of mocks.jobs) {
      await expect(
        job.run(
          { topicId: "topic_a", keyword: "keyword", platform: "manual" },
          io,
        ),
        job.id,
      ).rejects.toThrow("LEGACY_WORKER_DISABLED_USE_SGEO_API");
    }
  });
});
