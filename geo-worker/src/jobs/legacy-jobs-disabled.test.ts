import { describe, expect, it } from "vitest";

import { contentGenerateLegacyJob } from "./content-generate";
import { trendCrawlLegacyJob } from "./trend-crawl";

describe("disabled legacy workers", () => {
  it("fails both legacy direct-write jobs with the API migration error", async () => {
    const jobs = [trendCrawlLegacyJob, contentGenerateLegacyJob];

    expect(jobs.map((job) => job.id).sort()).toEqual([
      "content-generate",
      "trend-crawl",
    ]);

    for (const job of jobs) {
      await expect(
        job.run(),
        job.id,
      ).rejects.toThrow("LEGACY_WORKER_DISABLED_USE_SGEO_API");
    }
  });
});
