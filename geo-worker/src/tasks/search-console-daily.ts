import { schedules } from "@trigger.dev/sdk";

import {
  parseSearchConsoleInput,
  type SearchConsoleInput,
} from "../adapters/search-console";
import { type SgeoOpsClient } from "../clients/sgeo-ops";
import {
  createDefaultSgeoOpsClient,
  SEARCH_CONSOLE_DAILY_DISPATCH_CRON,
  searchConsoleSyncTask,
} from "./search-console-sync";

type DailyDispatchClient = Pick<SgeoOpsClient, "dispatchSearchConsolePage">;
type BatchItem = {
  payload: SearchConsoleInput;
  options: { idempotencyKey: string };
};

export type SearchConsoleDailyDependencies = {
  client?: DailyDispatchClient;
  batchTrigger?: (items: BatchItem[]) => Promise<unknown>;
};

export async function runSearchConsoleDailyDispatch(
  scheduledAt: Date,
  dependencies: SearchConsoleDailyDependencies = {},
) {
  if (!(scheduledAt instanceof Date) || !Number.isFinite(scheduledAt.getTime())) {
    throw new TypeError("Search Console scheduled time is invalid.");
  }
  const client = dependencies.client ?? await createDefaultSgeoOpsClient();
  const scheduledAtIso = scheduledAt.toISOString();
  const batchTrigger = dependencies.batchTrigger ??
    ((items: BatchItem[]) => searchConsoleSyncTask.batchTrigger(items));
  const runIds: string[] = [];
  const dispatchedRunIds = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await client.dispatchSearchConsolePage(scheduledAtIso, cursor);
    const runs = page.runs.map((run) => parseSearchConsoleInput(run));
    for (const run of runs) {
      if (dispatchedRunIds.has(run.runId)) {
        throw new TypeError("Search Console dispatch returned a duplicate run.");
      }
      dispatchedRunIds.add(run.runId);
      runIds.push(run.runId);
    }
    if (runs.length > 0) {
      await batchTrigger(runs.map((payload) => ({
        payload,
        options: { idempotencyKey: payload.runId },
      })));
    }
    cursor = page.cursor;
  } while (cursor !== null);

  return {
    dispatched: runIds.length,
    runIds,
  }
}

export const searchConsoleDailyDispatchTask = schedules.task({
  id: "search-console-daily-dispatch",
  cron: {
    pattern: SEARCH_CONSOLE_DAILY_DISPATCH_CRON,
    timezone: "UTC",
  },
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: (payload) => runSearchConsoleDailyDispatch(payload.timestamp),
});
