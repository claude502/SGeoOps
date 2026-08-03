import { describe, expect, it, vi } from "vitest";

import {
  PrismaSearchConsoleControlRepository,
  SearchConsoleControlError,
  SearchConsoleControlPlane,
  type SearchConsoleControlScope,
} from "./control-plane";

const scope: SearchConsoleControlScope = {
  runId: "run_1",
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: null,
  integrationId: "integration_1",
  property: "sc-domain:shop.example",
};

describe("SearchConsoleControlPlane", () => {
  it("resolves a scoped file secret without retaining it in control-plane responses", async () => {
    const repository = {
      getCredentialReference: vi.fn().mockResolvedValue("file:google/search-console"),
      disableForAuthenticationFailure: vi.fn(),
    };
    const secrets = { resolve: vi.fn().mockResolvedValue("google-access-token") };
    const control = new SearchConsoleControlPlane(repository, secrets);

    await expect(control.getCredential(scope)).resolves.toEqual({ token: "google-access-token" });
    expect(repository.getCredentialReference).toHaveBeenCalledWith(scope);
    expect(secrets.resolve).toHaveBeenCalledWith("file:google/search-console");
    expect(JSON.stringify(repository.getCredentialReference.mock.calls)).not.toContain("google-access-token");
  });

  it("maps resolver failures to a safe unavailable credential error", async () => {
    const control = new SearchConsoleControlPlane({
      getCredentialReference: vi.fn().mockResolvedValue("file:google/search-console"),
      disableForAuthenticationFailure: vi.fn(),
    }, { resolve: vi.fn().mockRejectedValue(new Error("secret path detail")) });

    await expect(control.getCredential(scope)).rejects.toMatchObject({
      name: "SearchConsoleControlError",
      code: "CREDENTIAL_UNAVAILABLE",
    } satisfies Partial<SearchConsoleControlError>);
  });

  it("delegates an authentication failure once with its complete owned scope", async () => {
    const repository = {
      getCredentialReference: vi.fn(),
      disableForAuthenticationFailure: vi.fn().mockResolvedValue({ disabled: true, recommendationId: "sc-auth-1" }),
    };
    const control = new SearchConsoleControlPlane(repository, { resolve: vi.fn() });

    await expect(control.disableAfterAuthenticationFailure(scope)).resolves.toEqual({
      disabled: true,
      recommendationId: "sc-auth-1",
    });
    expect(repository.disableForAuthenticationFailure).toHaveBeenCalledWith(scope);
  });
});

describe("PrismaSearchConsoleControlRepository", () => {
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
            ? { id: scope.integrationId, secretRef: "file:google/search-console" }
            : options.integration,
        ),
        update: vi.fn().mockResolvedValue({ id: scope.integrationId }),
      },
      recommendation: {
        upsert: vi.fn().mockResolvedValue({ id: "recommendation" }),
      },
    };
    const database = {
      $transaction: vi.fn(async (operation: (tx: typeof transaction) => Promise<unknown>) => operation(transaction)),
    };
    return {
      repository: new PrismaSearchConsoleControlRepository(database as never),
      database,
      transaction,
    };
  }

  it("resolves only an enabled search_console integration inside the owned run scope", async () => {
    const { repository, database, transaction } = harness();

    await expect(repository.getCredentialReference(scope))
      .resolves.toBe("file:google/search-console");

    expect(database.$transaction).toHaveBeenCalledTimes(1);
    expect(transaction.analysisRun.findFirst).toHaveBeenCalledWith({
      where: {
        id: scope.runId,
        clientId: scope.clientId,
        brandId: scope.brandId,
        siteId: scope.siteId,
        siteMarketId: scope.siteMarketId,
        source: "search-console",
      },
      select: { id: true },
    });
    expect(transaction.integration.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: scope.integrationId,
        siteId: scope.siteId,
        siteMarketId: scope.siteMarketId,
        type: "search_console",
        endpoint: scope.property,
        healthState: { not: "disabled" },
        site: {
          brandId: scope.brandId,
          brand: { clientId: scope.clientId },
        },
      }),
      select: { id: true, secretRef: true },
    });
  });

  it.each([
    ["missing run", { run: null }],
    ["disabled or cross-scope integration", { integration: null }],
  ])("returns the same not-found error for %s", async (_label, options) => {
    const { repository } = harness(options);

    await expect(repository.getCredentialReference(scope)).rejects.toMatchObject({
      name: "SearchConsoleControlError",
      code: "RESOURCE_NOT_FOUND",
    });
  });

  it("does not return a secretless integration", async () => {
    const { repository } = harness({ integration: { id: scope.integrationId, secretRef: null } });

    await expect(repository.getCredentialReference(scope)).rejects.toMatchObject({
      name: "SearchConsoleControlError",
      code: "CREDENTIAL_UNAVAILABLE",
    });
  });

  it("atomically disables the one owned integration and deterministically upserts one run recommendation", async () => {
    const { repository, database, transaction } = harness();

    const first = await repository.disableForAuthenticationFailure(scope);
    const second = await repository.disableForAuthenticationFailure(scope);

    expect(database.$transaction).toHaveBeenCalledTimes(2);
    expect(first).toEqual(second);
    expect(transaction.integration.update).toHaveBeenCalledTimes(2);
    expect(transaction.integration.update).toHaveBeenCalledWith({
      where: { id: scope.integrationId },
      data: { healthState: "disabled", lastCheckedAt: expect.any(Date) },
    });
    expect(transaction.recommendation.upsert).toHaveBeenCalledTimes(2);
    const calls = transaction.recommendation.upsert.mock.calls;
    expect(calls[0]?.[0].where.id).toBe(calls[1]?.[0].where.id);
    expect(calls[0]?.[0]).toMatchObject({
      where: { id: first.recommendationId },
      create: {
        id: first.recommendationId,
        runId: scope.runId,
        clientId: scope.clientId,
        siteId: scope.siteId,
        formulaVersion: "search-console-auth-v1",
      },
      update: {},
    });
  });
});
