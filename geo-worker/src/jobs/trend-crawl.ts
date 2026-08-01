import { failLegacyWorker } from "./legacy-worker-disabled";

export const trendCrawlLegacyJob = {
  id: "trend-crawl",
  run: async (): Promise<never> => {
    failLegacyWorker();
  },
};
