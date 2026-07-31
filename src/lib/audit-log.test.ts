import { beforeEach, describe, expect, it, vi } from "vitest";

const { bestEffortCreate } = vi.hoisted(() => ({
  bestEffortCreate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ auditEvent: { create: bestEffortCreate } }),
  isDatabaseConfigured: () => true,
}));

import * as auditLog from "@/lib/audit-log";

describe("required audit events", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    bestEffortCreate.mockReset();
  });

  it("writes explicit actor and ownership through the supplied transaction", async () => {
    const create = vi.fn().mockResolvedValue({ id: "audit_1" });
    const tx = { auditEvent: { create } };
    const createAuditEvent = (
      auditLog as typeof auditLog & {
        createAuditEvent?: (
          transaction: unknown,
          input: Record<string, unknown>,
        ) => Promise<void>;
      }
    ).createAuditEvent;

    expect(createAuditEvent).toBeTypeOf("function");
    await createAuditEvent?.(tx, {
      actorId: "operator_a",
      workspaceId: "workspace_internal",
      clientId: "client_a",
      brandId: "brand_a",
      siteId: "site_a",
      action: "content_asset.create",
      entityType: "ContentAsset",
      entityId: "asset_a",
      outcome: "success",
      metadata: { contentAssetId: "asset_a" },
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actor: "operator_a",
        clientId: "client_a",
        brandId: "brand_a",
        siteId: "site_a",
        action: "content_asset.create",
        entityId: "asset_a",
      }),
    });
  });

  it("does not swallow a required audit failure", async () => {
    const failure = new Error("audit unavailable");
    const createAuditEvent = (
      auditLog as typeof auditLog & {
        createAuditEvent?: (
          transaction: unknown,
          input: Record<string, unknown>,
        ) => Promise<void>;
      }
    ).createAuditEvent;

    expect(createAuditEvent).toBeTypeOf("function");
    await expect(
      createAuditEvent?.(
        {
          auditEvent: {
            create: vi.fn().mockRejectedValue(failure),
          },
        },
        {
          actorId: "operator_a",
          workspaceId: "workspace_internal",
          clientId: "client_a",
          brandId: "brand_a",
          siteId: "site_a",
          action: "content_asset.create",
          entityType: "ContentAsset",
          outcome: "success",
        },
      ),
    ).rejects.toBe(failure);
  });

  it("does not include a best-effort audit error message in diagnostics", async () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    bestEffortCreate.mockRejectedValue(
      new Error("authorization=top-secret full content"),
    );

    await auditLog.recordAuditEvent({
      clientId: "client_a",
      brandId: "brand_a",
      siteId: "site_a",
      action: "diagnostic.failure",
      entityType: "ContentAsset",
      outcome: "failure",
    });

    expect(warning).toHaveBeenCalledWith(
      "Could not write audit event.",
      { name: "Error" },
    );
  });
});
