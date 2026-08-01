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
  const database = {
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
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    siteMarket: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    $queryRaw: vi.fn(),
  };
  return Object.assign(database, {
    $transaction: vi.fn(
      async (operation: (transaction: typeof database) => Promise<unknown>) =>
        operation(database),
    ),
  });
}

function publicSiteRecord(id: string, canonicalHost: string) {
  const suffix = id.replace(/^site_/, "");
  return {
    id,
    brandId: `brand_${suffix}`,
    name: `Site ${suffix.toUpperCase()}`,
    canonicalHost,
    originHosts: [`origin-${suffix}.example.com`],
    siteType: "content",
    hostingMode: "hosted",
    canonicalRules: { https: true },
    allowedPublishPaths: ["/guides"],
    active: true,
    brand: {
      clientId: `client_${suffix}`,
      client: {
        workspaceId: "workspace_internal",
        active: true,
      },
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

  it("lists active sites nested beneath only the scoped clients", async () => {
    const database = organizationDatabase();
    database.client.findMany.mockResolvedValue([
      {
        id: "client_a",
        workspaceId: "workspace_internal",
        name: "Client A",
        slug: "client-a",
        active: true,
        createdAt: new Date("2026-07-31T00:00:00.000Z"),
        updatedAt: new Date("2026-07-31T00:00:00.000Z"),
        brands: [
          {
            sites: [
              {
                id: "site_a",
                name: "Client A Site",
                canonicalHost: "client-a.example.com",
              },
            ],
          },
        ],
      },
    ]);
    const repository = new PrismaOrganizationRepository(database as never);

    await expect(repository.listClientSiteOverviews(scope)).resolves.toEqual([
      {
        id: "client_a",
        workspaceId: "workspace_internal",
        name: "Client A",
        slug: "client-a",
        active: true,
        createdAt: new Date("2026-07-31T00:00:00.000Z"),
        updatedAt: new Date("2026-07-31T00:00:00.000Z"),
        sites: [
          {
            id: "site_a",
            name: "Client A Site",
            canonicalHost: "client-a.example.com",
          },
        ],
      },
    ]);
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

  it("gives an exact canonical claim priority over every origin alias", async () => {
    const database = organizationDatabase();
    database.site.findUnique.mockResolvedValue(
      publicSiteRecord("site_b", "example.com"),
    );
    const repository = new PrismaOrganizationRepository(database as never);

    await expect(
      repository.resolveSiteByHost("EXAMPLE.COM.:443"),
    ).resolves.toMatchObject({
      workspaceId: "workspace_internal",
      clientId: "client_b",
      brandId: "brand_b",
      siteId: "site_b",
    });
    expect(database.site.findUnique).toHaveBeenCalledWith({
      where: { canonicalHost: "example.com" },
      select: expect.any(Object),
    });
    expect(database.site.findMany).not.toHaveBeenCalled();
  });

  it("returns one active origin claim and fails closed for ambiguity", async () => {
    const database = organizationDatabase();
    database.site.findUnique.mockResolvedValue(null);
    database.site.findMany
      .mockResolvedValueOnce([publicSiteRecord("site_a", "site-a.example.com")])
      .mockResolvedValueOnce([
        publicSiteRecord("site_a", "site-a.example.com"),
        publicSiteRecord("site_b", "site-b.example.com"),
      ]);
    const repository = new PrismaOrganizationRepository(database as never);

    await expect(
      repository.resolveSiteByHost("origin-a.example.com"),
    ).resolves.toMatchObject({ siteId: "site_a" });
    await expect(
      repository.resolveSiteByHost("shared.example.com"),
    ).resolves.toBeNull();
    expect(database.site.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        active: true,
        brand: { client: { active: true } },
        originHosts: { has: "shared.example.com" },
      },
      select: expect.any(Object),
      orderBy: { id: "asc" },
      take: 2,
    });
  });

  it("does not fall through an inactive canonical claim to an alias", async () => {
    const database = organizationDatabase();
    database.site.findUnique.mockResolvedValue({
      ...publicSiteRecord("site_inactive", "claimed.example.com"),
      active: false,
    });
    const repository = new PrismaOrganizationRepository(database as never);

    await expect(
      repository.resolveSiteByHost("claimed.example.com"),
    ).resolves.toBeNull();
    expect(database.site.findMany).not.toHaveBeenCalled();
  });

  it("rejects site claims that collide with any canonical or origin host", async () => {
    const database = organizationDatabase();
    database.brand.findFirst.mockResolvedValue({ id: "brand_a" });
    database.site.findFirst.mockResolvedValue({ id: "site_existing" });
    const repository = new PrismaOrganizationRepository(database as never);

    await expect(
      repository.createSite(scope, {
        brandId: "brand_a",
        name: "Site New",
        canonicalHost: "new.example.com",
        originHosts: ["shared.example.com"],
        siteType: "content",
        hostingMode: "hosted",
        canonicalRules: {},
        allowedPublishPaths: [],
        active: true,
      }),
    ).rejects.toMatchObject({
      name: "ScopedOrganizationError",
      code: "HOST_CONFLICT",
    });

    expect(database.$transaction).toHaveBeenCalledOnce();
    expect(database.$queryRaw).toHaveBeenCalledOnce();
    expect(database.site.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            canonicalHost: {
              in: ["new.example.com", "shared.example.com"],
            },
          },
          {
            originHosts: {
              hasSome: ["new.example.com", "shared.example.com"],
            },
          },
        ],
      },
      select: { id: true },
    });
    expect(database.site.create).not.toHaveBeenCalled();
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
