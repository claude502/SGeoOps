import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("platform Prisma schema", () => {
  it("contains ownership, evidence, auth, and event models", async () => {
    const schema = await readFile("prisma/schema.prisma", "utf8");

    for (const model of [
      "Workspace",
      "Client",
      "Brand",
      "Site",
      "SiteMarket",
      "Competitor",
      "Keyword",
      "User",
      "Session",
      "Account",
      "Verification",
      "WorkspaceMember",
      "Integration",
      "AnalysisRun",
      "RawArtifact",
      "Observation",
      "MetricSnapshot",
      "Recommendation",
      "Opportunity",
      "OpportunityRecommendation",
      "OutboxEvent",
      "InboxEvent",
    ]) {
      expect(schema).toContain(`model ${model} {`);
    }
  });
});
