export const LEGACY_WORKER_DISABLED_CODE =
  "LEGACY_WORKER_DISABLED_USE_SGEO_API" as const;

export class LegacyWorkerDisabledError extends Error {
  readonly code = LEGACY_WORKER_DISABLED_CODE;
  readonly retryable = false;

  constructor() {
    super(LEGACY_WORKER_DISABLED_CODE);
    this.name = "LegacyWorkerDisabledError";
  }
}

export function failLegacyWorker(): never {
  throw new LegacyWorkerDisabledError();
}
