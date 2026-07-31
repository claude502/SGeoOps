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
});
