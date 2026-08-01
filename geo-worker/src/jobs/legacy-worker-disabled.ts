export const LEGACY_WORKER_DISABLED_CODE =
  "LEGACY_WORKER_DISABLED_USE_SGEO_API" as const;

export function failLegacyWorker(): never {
  throw new Error(LEGACY_WORKER_DISABLED_CODE);
}
