import { defineConfig } from "@trigger.dev/sdk";
import { puppeteer } from "@trigger.dev/build/extensions/puppeteer";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_sgeo_ops",
  dirs: ["./src/tasks"],
  maxDuration: 3_600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 30_000,
      factor: 2,
    },
  },
  build: {
    extensions: [puppeteer()],
  },
});
