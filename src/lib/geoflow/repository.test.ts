import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessScope } from "@/lib/authorization";
import type { OwnedContext } from "@/lib/business/repository";
import { ScopedPrismaGeoFlowBridgeRepository } from "@/lib/geoflow/repository";

const { createAuditEvent, createOutboxEvent } = vi.hoisted(() => ({
  createAuditEvent: vi.fn(),
  createOutboxEvent: vi.fn(),
}));

vi.mock("@/lib/audit-log", () => ({ createAuditEvent }));
vi.mock("@/lib/events/outbox", () => ({ createOutboxEvent }));

const scope: AccessScope = {
  actorId: "user_a",
  workspaceId: "workspace_a",
  clientIds: ["client_a"],
  role: "Admin",
};

describe("ScopedPrismaGeoFlowBridgeRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists only normalized ownership fields for a sync run", async () => {
    const create = vi.fn(async ({ data }) => ({
      id: "sync_a",
      siteId: data.siteId,
    }));
    const tx = { geoFlowSyncRun: { create } };
    const database = {
      $transaction: vi.fn(async (callback) => callback(tx)),
    };
    const siteContext: OwnedContext & {
      siteName: string;
      brandName: string;
      canonicalHost: string;
    } = {
      clientId: "client_a",
      brandId: "brand_a",
      siteId: "site_a",
      siteMarketId: null,
      siteName: "Site A",
      brandName: "Brand A",
      canonicalHost: "a.example",
    };
    const repository = new ScopedPrismaGeoFlowBridgeRepository(
      scope,
      undefined,
      siteContext,
      database as never,
    );

    await repository.createSyncRun();

    expect(create).toHaveBeenCalledWith({
      data: {
        clientId: "client_a",
        brandId: "brand_a",
        siteId: "site_a",
        siteMarketId: null,
      },
    });
  });

  it("selects and maps only the declared public link fields", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "link_a",
        contentAssetId: "asset_a",
        geoFlowTaskId: 1,
        geoFlowJobId: 2,
        geoFlowArticleId: null,
        geoFlowArticleUrl: null,
        status: "generating",
        lastSyncedAt: null,
        lastError: "GEOFLOW_READ_FAILED",
        idempotencyKey: "idem_a",
        taskPayload: { authorization: "Bearer top-secret" },
        clientId: "client_a",
      },
    ]);
    const database = {
      geoFlowTaskLink: { findMany },
    };
    const repository = new ScopedPrismaGeoFlowBridgeRepository(
      scope,
      undefined,
      undefined,
      database as never,
    );

    const links = await repository.listLinks();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          id: true,
          contentAssetId: true,
          idempotencyKey: true,
        }),
      }),
    );
    expect(links).toEqual([
      {
        id: "link_a",
        contentAssetId: "asset_a",
        geoFlowTaskId: 1,
        geoFlowJobId: 2,
        geoFlowArticleId: null,
        geoFlowArticleUrl: null,
        status: "generating",
        lastSyncedAt: null,
        lastError: "GEOFLOW_READ_FAILED",
        idempotencyKey: "idem_a",
      },
    ]);
    expect(JSON.stringify(links)).not.toContain("top-secret");
  });

  it("rejects a sync cursor outside the scoped ownership chain before listing", async () => {
    const findFirst = vi.fn(async () => null);
    const findMany = vi.fn();
    const database = {
      geoFlowTaskLink: { findFirst, findMany },
    };
    const repository = new ScopedPrismaGeoFlowBridgeRepository(
      scope,
      undefined,
      {
        clientId: "client_a",
        brandId: "brand_a",
        siteId: "site_a",
        siteMarketId: null,
      },
      database as never,
    );

    await expect(
      repository.listSyncableLinks({ cursor: "link_b", limit: 10 }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "link_b",
        clientId: { in: ["client_a"] },
        siteId: "site_a",
      }),
      select: { id: true },
    });
    expect(findMany).not.toHaveBeenCalled();
  });
});
