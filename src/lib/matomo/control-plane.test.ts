import { describe, expect, it, vi } from "vitest";

import {
  MatomoControlError,
  MatomoControlPlane,
  PrismaMatomoControlRepository,
  type MatomoControlScope,
} from "./control-plane";

const scope: MatomoControlScope = {
  runId: "run_1",
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: null,
  integrationId: "integration_1",
  endpoint: "https://analytics.example",
};

describe("MatomoControlPlane", () => {
  it("resolves only the scoped file secret and returns only the token", async () => {
    const repository = {
      getCredentialReference: vi.fn().mockResolvedValue("file:matomo/reporting-token"),
      disableForAuthenticationFailure: vi.fn(),
    };
    const secrets = { resolve: vi.fn().mockResolvedValue("matomo-secret-token") };
    const control = new MatomoControlPlane(repository, secrets);

    await expect(control.getCredential(scope)).resolves.toEqual({ token: "matomo-secret-token" });
    expect(repository.getCredentialReference).toHaveBeenCalledWith(scope);
    expect(secrets.resolve).toHaveBeenCalledWith("file:matomo/reporting-token");
  });

  it("maps secret traversal and resolver failures to a non-enumerating error", async () => {
    const control = new MatomoControlPlane({
      getCredentialReference: vi.fn().mockResolvedValue("file:../outside"),
      disableForAuthenticationFailure: vi.fn(),
    }, { resolve: vi.fn().mockRejectedValue(new Error("SECRET_REFERENCE_INVALID")) });

    await expect(control.getCredential(scope)).rejects.toMatchObject({
      name: "MatomoControlError",
      code: "CREDENTIAL_UNAVAILABLE",
    } satisfies Partial<MatomoControlError>);
  });
});

describe("PrismaMatomoControlRepository", () => {
  function harness(options: {
    run?: { id: string } | null;
    integration?: { id: string; secretRef: string | null } | null;
  } = {}) {
    const transaction = {
      analysisRun: {
        findFirst: vi.fn().mockResolvedValue(options.run === undefined ? { id: scope.runId } : options.run),
      },
      integration: {
        findFirst: vi.fn().mockResolvedValue(
          options.integration === undefined
            ? { id: scope.integrationId, secretRef: "file:matomo/reporting-token" }
            : options.integration,
        ),
        update: vi.fn().mockResolvedValue({ id: scope.integrationId }),
      },
      recommendation: { upsert: vi.fn().mockResolvedValue({ id: "recommendation" }) },
    };
    const database = {
      $transaction: vi.fn(async (operation: (tx: typeof transaction) => Promise<unknown>) => operation(transaction)),
    };
    return {
      repository: new PrismaMatomoControlRepository(database as never),
      database,
      transaction,
    };
  }

  it("matches the exact owned Matomo run and enabled canonical integration scope", async () => {
    const { repository, transaction } = harness();

    await expect(repository.getCredentialReference(scope)).resolves.toBe("file:matomo/reporting-token");

    expect(transaction.analysisRun.findFirst).toHaveBeenCalledWith({
      where: {
        id: scope.runId,
        clientId: scope.clientId,
        brandId: scope.brandId,
        siteId: scope.siteId,
        siteMarketId: scope.siteMarketId,
        source: "matomo",
      },
      select: { id: true },
    });
    expect(transaction.integration.findFirst).toHaveBeenCalledWith({
      where: {
        id: scope.integrationId,
        siteId: scope.siteId,
        siteMarketId: scope.siteMarketId,
        type: "matomo",
        endpoint: scope.endpoint,
        healthState: { not: "disabled" },
        site: { brandId: scope.brandId, brand: { clientId: scope.clientId } },
      },
      select: { id: true, secretRef: true },
    });
  });

  it.each([
    ["cross-client or missing run", { run: null }],
    ["disabled or scope-mismatched integration", { integration: null }],
  ])("fails closed for %s", async (_label, options) => {
    const { repository } = harness(options);
    await expect(repository.getCredentialReference(scope)).rejects.toMatchObject({
      name: "MatomoControlError",
      code: "RESOURCE_NOT_FOUND",
    });
  });

  it.each([null, "env:MATOMO_TOKEN", "file:../outside", "file:nested/../../outside"])(
    "rejects unavailable or unsafe secret reference %s",
    async (secretRef) => {
      const { repository } = harness({ integration: { id: scope.integrationId, secretRef } });
      await expect(repository.getCredentialReference(scope)).rejects.toMatchObject({
        name: "MatomoControlError",
        code: "CREDENTIAL_UNAVAILABLE",
      });
    },
  );

  it("atomically disables exactly one integration and deterministically upserts one recommendation", async () => {
    const { repository, transaction } = harness();
    const first = await repository.disableForAuthenticationFailure(scope);
    const second = await repository.disableForAuthenticationFailure(scope);

    expect(first).toEqual(second);
    expect(transaction.integration.update).toHaveBeenCalledWith({
      where: { id: scope.integrationId },
      data: { healthState: "disabled", lastCheckedAt: expect.any(Date) },
    });
    const calls = transaction.recommendation.upsert.mock.calls;
    expect(calls[0]?.[0].where.id).toBe(calls[1]?.[0].where.id);
    expect(calls[0]?.[0]).toMatchObject({
      where: { id: first.recommendationId },
      create: {
        id: first.recommendationId,
        runId: scope.runId,
        clientId: scope.clientId,
        siteId: scope.siteId,
        formulaVersion: "matomo-auth-v1",
      },
      update: {},
    });
  });
});
