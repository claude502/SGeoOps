import { describe, expect, it, vi } from "vitest";

import { reserveBudget, reserveProviderBudget } from "./budget";

describe("reserveBudget", () => {
  it("allows a request that exactly consumes the daily request limit", () => {
    expect(reserveBudget({ dailyLimit: 100, used: 90, requested: 10 }))
      .toEqual({ allowed: true, remaining: 0 });
  });

  it("rejects a request that would exceed the daily request limit", () => {
    expect(reserveBudget({ dailyLimit: 100, used: 91, requested: 10 }))
      .toEqual({ allowed: false, remaining: 9 });
  });

  it("requires finite non-negative counts and enforces an optional token limit", () => {
    expect(reserveBudget({ dailyLimit: 10, used: -1, requested: 1 }))
      .toEqual({ allowed: false, remaining: 0 });
    expect(reserveBudget({
      dailyLimit: 10,
      used: 3,
      requested: 1,
      dailyTokenLimit: 1_000,
      usedTokens: 950,
      requestedTokens: 51,
    })).toEqual({ allowed: false, remaining: 7, remainingTokens: 50 });
    expect(reserveBudget({
      dailyLimit: 10,
      used: 3,
      requested: 1,
      dailyTokenLimit: 1_000,
      usedTokens: 950,
      requestedTokens: 50,
    })).toEqual({ allowed: true, remaining: 6, remainingTokens: 0 });
  });
});

describe("reserveProviderBudget", () => {
  it("serializes one provider-day, locks its usage row, and returns a single-use release token", async () => {
    const usageDate = new Date("2026-08-04T00:00:00.000Z");
    const database = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          id: "usage_1",
          requestCount: 90,
          inputTokens: 100,
          outputTokens: 50,
        }]),
      providerBudget: {
        findUnique: vi.fn().mockResolvedValue({
          id: "budget_1",
          dailyRequestLimit: 100,
          dailyTokenLimit: 500,
          active: true,
        }),
      },
      providerUsage: {
        upsert: vi.fn().mockResolvedValue({ id: "usage_1" }),
        update: vi.fn().mockResolvedValue({ id: "usage_1" }),
      },
    };

    const result = await reserveProviderBudget(database as never, {
      clientId: "client_1",
      provider: "openai",
      usageDate,
      requested: { requests: 10, inputTokens: 200, outputTokens: 150 },
    });

    expect(result).toMatchObject({ allowed: true, remaining: 0, remainingTokens: 0 });
    if (!result.allowed) throw new Error("expected an allowed reservation");
    expect(database.providerBudget.findUnique).toHaveBeenCalledWith({
      where: { clientId_provider: { clientId: "client_1", provider: "openai" } },
      select: {
        id: true,
        dailyRequestLimit: true,
        dailyTokenLimit: true,
        active: true,
      },
    });
    expect(database.providerUsage.upsert).toHaveBeenCalledWith({
      where: { budgetId_usageDate: { budgetId: "budget_1", usageDate } },
      create: { budgetId: "budget_1", usageDate },
      update: {},
      select: { id: true },
    });
    expect(database.providerUsage.update).toHaveBeenCalledWith({
      where: { id: "usage_1" },
      data: {
        requestCount: { increment: 10 },
        inputTokens: { increment: 200 },
        outputTokens: { increment: 150 },
      },
    });

    await expect(result.release(database as never)).resolves.toBe(true);
    await expect(result.release(database as never)).resolves.toBe(false);
    expect(database.providerUsage.update).toHaveBeenLastCalledWith({
      where: { id: "usage_1" },
      data: {
        requestCount: { decrement: 10 },
        inputTokens: { decrement: 200 },
        outputTokens: { decrement: 150 },
      },
    });
  });
});
