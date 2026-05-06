import { TriggerClient } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: process.env.TRIGGER_PROJECT_REF ?? "proj_geo_ops",
  apiKey: process.env.TRIGGER_API_KEY ?? "",
  apiUrl: process.env.TRIGGER_API_URL ?? "http://localhost:3040",
});
