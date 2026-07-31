import { describe, expect, it, vi } from "vitest";

import type { AccessScope } from "@/lib/authorization";
import {
  PrismaOrganizationRepository,
  ScopedOrganizationError,
} from "@/lib/organization/repository";

const scope: AccessScope = {
  actorId: "user_a",
  workspaceId: "workspace_internal",
  role: "Operator",
  clientIds: ["client_a"],
};

function organizationDatabase() {
  return {
    client: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    brand: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    site: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    siteMarket: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  };
}

describe("PrismaOrganizationRepository", () => {
  it("lists only clients allowed by both workspace and client scope", async () => {
    const database = organizationDatabase();
    database.client.findMany.mockResolvedValue([]);
    const repository = new PrismaOrganizationRepository(database as never);

    await expect(repository.listClients(scope)).resolves.toEqual([]);
    expect(database.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: "workspace_internal",
          id: { in: ["client_a"] },
        },
      }),
    );
  });

  it("creates a client inside the scoped workspace", async () => {
    const database = organizationDatabase();
    database.client.create.mockResolvedValue({
      id: "client_new",
      workspaceId: "workspace_internal",
      name: "Client New",
      slug: "client-new",
      active: true,
      createdAt: new Date("2026-07-31T00:00:00.000Z"),
      updatedAt: new Date("2026-07-31T00:00:00.000Z"),
    });
    const repository = new PrismaOrganizationRepository(database as never);

    await repository.createClient(scope, {
      name: "Client New",
      slug: "client-new",
      active: true,
    });

    expect(database.client.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          workspaceId: "workspace_internal",
          name: "Client New",
          slug: "client-new",
          active: true,
        },
      }),
    );
  });

  it("validates a brand parent with a scoped predicate before creating", async () => {
    const database = organizationDatabase();
    database.client.findFirst.mockResolvedValue({ id: "client_a" });
    database.brand.create.mockResolvedValue({
      id: "brand_a",
      clientId: "client_a",
      name: "Brand A",
      slug: "brand-a",
      aliases: [],
      products: null,
      industry: null,
      goals: null,
      riskCategory: "standard",
      createdAt: new Date("2026-07-31T00:00:00.000Z"),
      updatedAt: new Date("2026-07-31T00:00:00.000Z"),
    });
    const repository = new PrismaOrganizationRepository(database as never);

    await expect(
      repository.createBrand(scope, {
        clientId: "client_a",
        name: "Brand A",
        slug: "brand-a",
        aliases: [],
        products: null,
        industry: null,
        goals: null,
        riskCategory: "standard",
      }),
    ).resolves.toMatchObject({ clientId: "client_a" });

    expect(database.client.findFirst).toHaveBeenCalledWith({
      where: {
        id: "client_a",
        workspaceId: "workspace_internal",
        AND: [{ id: { in: ["client_a"] } }],
      },
      select: { id: true },
    });
  });

  it("uses the same fail-closed result for missing and cross-client sites", async () => {
    const database = organizationDatabase();
    database.site.findFirst.mockResolvedValue(null);
    const repository = new PrismaOrganizationRepository(database as never);

    for (const siteId of ["site_missing", "site_client_b"]) {
      await expect(repository.getSite(scope, siteId)).rejects.toMatchObject({
        name: "ScopedOrganizationError",
        code: "RESOURCE_NOT_FOUND",
      });
    }

    expect(database.site.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          id: "site_client_b",
          brand: {
            client: {
              workspaceId: "workspace_internal",
              id: { in: ["client_a"] },
            },
          },
        },
      }),
    );
  });

  it("validates a site's full ownership chain before creating a market", async () => {
    const database = organizationDatabase();
    database.site.findFirst.mockResolvedValue({ id: "site_a" });
    database.siteMarket.create.mockResolvedValue({
      id: "market_a",
      siteId: "site_a",
      country: "MY",
      locale: "en-MY",
      defaultDevice: "desktop",
      timezone: "Asia/Kuala_Lumpur",
      settings: null,
      createdAt: new Date("2026-07-31T00:00:00.000Z"),
      updatedAt: new Date("2026-07-31T00:00:00.000Z"),
    });
    const repository = new PrismaOrganizationRepository(database as never);

    await repository.createSiteMarket(scope, {
      siteId: "site_a",
      country: "MY",
      locale: "en-MY",
      defaultDevice: "desktop",
      timezone: "Asia/Kuala_Lumpur",
      settings: null,
    });

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
  });

  it("normalizes a public host and resolves only active ownership", async () => {
    const database = organizationDatabase();
    database.site.findFirst.mockResolvedValue({
      id: "site_a",
      brandId: "brand_a",
      name: "Site A",
      canonicalHost: "example.com",
      originHosts: ["origin.example.com"],
      siteType: "content",
      hostingMode: "hosted",
      canonicalRules: { https: true },
      allowedPublishPaths: ["/guides"],
      active: true,
      brand: {
        id: "brand_a",
        clientId: "client_a",
        client: {
          id: "client_a",
          workspaceId: "workspace_internal",
        },
      },
    });
    const repository = new PrismaOrganizationRepository(database as never);

    await expect(
      repository.resolveSiteByHost("EXAMPLE.COM.:443"),
    ).resolves.toMatchObject({
      workspaceId: "workspace_internal",
      clientId: "client_a",
      brandId: "brand_a",
      siteId: "site_a",
    });
    expect(database.site.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          active: true,
          brand: { client: { active: true } },
          OR: [
            { canonicalHost: "example.com" },
            { originHosts: { has: "example.com" } },
          ],
        },
      }),
    );
  });

  it.each([
    "https://example.com",
    "example.com/path",
    "user@example.com",
    "example.com?x=1",
  ])("rejects public host injection: %s", async (host) => {
    const repository = new PrismaOrganizationRepository(
      organizationDatabase() as never,
    );

    await expect(repository.resolveSiteByHost(host)).rejects.toBeInstanceOf(
      ScopedOrganizationError,
    );
  });
});
