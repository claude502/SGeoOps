import { describe, expect, it, vi } from "vitest";

import type { AccessScope } from "@/lib/authorization";
import { PrismaIntegrationRepository } from "@/lib/integrations/repository";

const scope: AccessScope = {
  actorId: "admin_a",
  workspaceId: "workspace_internal",
  role: "Admin",
  clientIds: ["client_a"],
};

function integrationDatabase() {
  return {
    site: { findFirst: vi.fn() },
    siteMarket: { findFirst: vi.fn() },
    integration: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  };
}

describe("PrismaIntegrationRepository", () => {
  it("lists integrations through the complete scoped site chain", async () => {
    const database = integrationDatabase();
    database.site.findFirst.mockResolvedValue({ id: "site_a" });
    database.integration.findMany.mockResolvedValue([
      {
        id: "integration_a",
        siteId: "site_a",
        siteMarketId: null,
        type: "wordpress",
        endpoint: "https://cms.example.com",
        capabilities: ["publish"],
        adapterVersion: "1.0.0",
        secretRef: "file:wordpress/token",
        healthState: "unknown",
        lastCheckedAt: null,
        createdAt: new Date("2026-07-31T00:00:00.000Z"),
        updatedAt: new Date("2026-07-31T00:00:00.000Z"),
      },
    ]);
    const repository = new PrismaIntegrationRepository(database as never);

    await expect(repository.listBySite(scope, "site_a")).resolves.toEqual([
      expect.objectContaining({
        id: "integration_a",
        secretConfigured: true,
      }),
    ]);
    expect(database.site.findFirst).toHaveBeenCalledWith({
      where: {
        id: "site_a",
        brand: {
          client: {
            workspaceId: "workspace_internal",
            id: { in: ["client_a"] },
          },
        },
      },
      select: { id: true },
    });
    expect(database.integration.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          siteId: "site_a",
          site: {
            brand: {
              client: {
                workspaceId: "workspace_internal",
                id: { in: ["client_a"] },
              },
            },
          },
        },
      }),
    );
  });

  it("never returns secretRef from list summaries", async () => {
    const database = integrationDatabase();
    database.site.findFirst.mockResolvedValue({ id: "site_a" });
    database.integration.findMany.mockResolvedValue([
      {
        id: "integration_a",
        siteId: "site_a",
        siteMarketId: null,
        type: "api",
        endpoint: null,
        capabilities: [],
        adapterVersion: "1",
        secretRef: "file:api/token",
        healthState: "unknown",
        lastCheckedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const repository = new PrismaIntegrationRepository(database as never);

    const [integration] = await repository.listBySite(scope, "site_a");
    expect(integration).not.toHaveProperty("secretRef");
    expect(JSON.stringify(integration)).not.toContain("file:api/token");
  });

  it("requires an optional market to belong to the same scoped site", async () => {
    const database = integrationDatabase();
    database.site.findFirst.mockResolvedValue({ id: "site_a" });
    database.siteMarket.findFirst.mockResolvedValue(null);
    const repository = new PrismaIntegrationRepository(database as never);

    await expect(
      repository.create(scope, {
        siteId: "site_a",
        siteMarketId: "market_b",
        type: "wordpress",
        endpoint: null,
        capabilities: ["publish"],
        adapterVersion: "1.0.0",
        secretRef: null,
      }),
    ).rejects.toThrow("RESOURCE_NOT_FOUND");

    expect(database.siteMarket.findFirst).toHaveBeenCalledWith({
      where: {
        id: "market_b",
        siteId: "site_a",
        site: {
          brand: {
            client: {
              workspaceId: "workspace_internal",
              id: { in: ["client_a"] },
            },
          },
        },
      },
      select: { id: true },
    });
    expect(database.integration.create).not.toHaveBeenCalled();
  });
});
