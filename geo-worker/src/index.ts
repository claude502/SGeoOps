import "./jobs/trend-crawl";
import "./jobs/content-generate";
import "./jobs/seo-audit";

const REQUIRED_ENV = {
  TRIGGER_API_URL: process.env.TRIGGER_API_URL,
  TRIGGER_API_KEY: process.env.TRIGGER_API_KEY,
  TRIGGER_PROJECT_REF: process.env.TRIGGER_PROJECT_REF,
  SGEO_INTERNAL_URL: process.env.SGEO_INTERNAL_URL,
  SGEO_INTERNAL_SECRET_FILE: process.env.SGEO_INTERNAL_SECRET_FILE,
};

const missing = Object.entries(REQUIRED_ENV)
  .filter(([, value]) => !value?.trim())
  .map(([key]) => key);

if (missing.length > 0) {
  console.warn(
    `[geo-worker] Starting in degraded mode. Missing env vars: ${missing.join(", ")}. Jobs are registered, but API/event features may fail until configuration is complete.`,
  );
} else {
  console.log("[geo-worker] ✅ All env vars present. 3 jobs registered.");
}
