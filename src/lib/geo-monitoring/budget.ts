export interface BudgetReservationInput {
  dailyLimit: number;
  used: number;
  requested: number;
  dailyTokenLimit?: number | null;
  usedTokens?: number;
  requestedTokens?: number;
}

export type BudgetReservationDecision =
  | { allowed: true; remaining: number; remainingTokens?: number }
  | { allowed: false; remaining: number; remainingTokens?: number };

type ProviderBudgetTransaction = Pick<
  Prisma.TransactionClient,
  "$queryRaw" | "providerBudget" | "providerUsage"
>;

export interface ProviderBudgetReservationInput {
  clientId: string;
  provider: string;
  usageDate: Date;
  requested: {
    requests: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export type ProviderBudgetReservation =
  | (Extract<BudgetReservationDecision, { allowed: false }> & {
    reason: "BUDGET_NOT_CONFIGURED" | "BUDGET_INACTIVE" | "BUDGET_EXHAUSTED" | "INVALID_REQUEST";
  })
  | (Extract<BudgetReservationDecision, { allowed: true }> & {
    budgetId: string;
    usageId: string;
    release(transaction: ProviderBudgetTransaction): Promise<boolean>;
  });

type LockedUsage = {
  id: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
};

function count(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function reserveBudget(input: BudgetReservationInput): BudgetReservationDecision {
  const requestInputIsValid =
    count(input.dailyLimit) && count(input.used) && count(input.requested);
  if (!requestInputIsValid) return { allowed: false, remaining: 0 };

  const remaining = Math.max(0, input.dailyLimit - input.used);
  const requestAllowed = input.requested <= remaining;
  if (input.dailyTokenLimit === undefined || input.dailyTokenLimit === null) {
    return requestAllowed ? { allowed: true, remaining: remaining - input.requested } : {
      allowed: false,
      remaining,
    };
  }

  const usedTokens = input.usedTokens;
  const requestedTokens = input.requestedTokens;
  const tokenInputIsValid =
    count(input.dailyTokenLimit) &&
    usedTokens !== undefined &&
    requestedTokens !== undefined &&
    count(usedTokens) &&
    count(requestedTokens);
  if (!tokenInputIsValid) return { allowed: false, remaining, remainingTokens: 0 };

  const remainingTokens = Math.max(0, input.dailyTokenLimit - usedTokens);
  const tokenAllowed = requestedTokens <= remainingTokens;
  if (!requestAllowed || !tokenAllowed) {
    return { allowed: false, remaining, remainingTokens };
  }
  return {
    allowed: true,
    remaining: remaining - input.requested,
    remainingTokens: remainingTokens - requestedTokens,
  };
}

function utcDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function requestedCounts(input: ProviderBudgetReservationInput["requested"]) {
  const counts = {
    requests: input.requests,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
  };
  return count(counts.requests) && count(counts.inputTokens) && count(counts.outputTokens)
    ? counts
    : null;
}

export async function reserveProviderBudget(
  transaction: ProviderBudgetTransaction,
  input: ProviderBudgetReservationInput,
): Promise<ProviderBudgetReservation> {
  const usageDate = utcDate(input.usageDate);
  const requested = requestedCounts(input.requested);
  if (
    usageDate === null ||
    requested === null ||
    input.clientId.trim().length === 0 ||
    input.provider.trim().length === 0
  ) {
    return { allowed: false, remaining: 0, reason: "INVALID_REQUEST" };
  }
  const provider = input.provider.trim();
  const usageKey = `${input.clientId}\u0000${provider}\u0000${usageDate.toISOString().slice(0, 10)}`;

  // This covers the no-row-yet case; the row lock below protects existing usage.
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${usageKey}, 7192::bigint))
  `;

  const budget = await transaction.providerBudget.findUnique({
    where: { clientId_provider: { clientId: input.clientId, provider } },
    select: {
      id: true,
      dailyRequestLimit: true,
      dailyTokenLimit: true,
      active: true,
    },
  });
  if (budget === null) {
    return { allowed: false, remaining: 0, reason: "BUDGET_NOT_CONFIGURED" };
  }
  if (!budget.active) {
    return { allowed: false, remaining: 0, reason: "BUDGET_INACTIVE" };
  }

  const usageReference = await transaction.providerUsage.upsert({
    where: { budgetId_usageDate: { budgetId: budget.id, usageDate } },
    create: { budgetId: budget.id, usageDate },
    update: {},
    select: { id: true },
  });
  const locked = await transaction.$queryRaw<LockedUsage[]>`
    SELECT "id", "requestCount", "inputTokens", "outputTokens"
    FROM "ProviderUsage"
    WHERE "id" = ${usageReference.id}
    FOR UPDATE
  `;
  const usage = locked[0];
  if (usage === undefined || locked.length !== 1) {
    throw new Error("Provider budget usage row could not be locked.");
  }

  const decision = reserveBudget({
    dailyLimit: budget.dailyRequestLimit,
    used: usage.requestCount,
    requested: requested.requests,
    dailyTokenLimit: budget.dailyTokenLimit,
    usedTokens: usage.inputTokens + usage.outputTokens,
    requestedTokens: requested.inputTokens + requested.outputTokens,
  });
  if (!decision.allowed) return { ...decision, reason: "BUDGET_EXHAUSTED" };

  await transaction.providerUsage.update({
    where: { id: usage.id },
    data: {
      requestCount: { increment: requested.requests },
      inputTokens: { increment: requested.inputTokens },
      outputTokens: { increment: requested.outputTokens },
    },
  });

  let released = false;
  return {
    ...decision,
    budgetId: budget.id,
    usageId: usage.id,
    async release(releaseTransaction) {
      if (released) return false;
      released = true;
      try {
        await releaseTransaction.providerUsage.update({
          where: { id: usage.id },
          data: {
            requestCount: { decrement: requested.requests },
            inputTokens: { decrement: requested.inputTokens },
            outputTokens: { decrement: requested.outputTokens },
          },
        });
        return true;
      } catch (error) {
        released = false;
        throw error;
      }
    },
  };
}
import { Prisma } from "@prisma/client";
