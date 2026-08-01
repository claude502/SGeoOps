import { failLegacyWorker } from "./legacy-worker-disabled";

export const contentGenerateLegacyJob = {
  id: "content-generate",
  run: async (): Promise<never> => {
    failLegacyWorker();
  },
};
