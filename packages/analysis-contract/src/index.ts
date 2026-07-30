import { z } from "zod";

function compareUtcIsoDatetimes(left: string, right: string): number {
  const [leftBody, leftFraction = ""] = left.slice(0, -1).split(".");
  const [rightBody, rightFraction = ""] = right.slice(0, -1).split(".");
  const leftWholeSecond = leftBody.length === 16 ? `${leftBody}:00` : leftBody;
  const rightWholeSecond = rightBody.length === 16 ? `${rightBody}:00` : rightBody;

  if (leftWholeSecond !== rightWholeSecond) {
    return leftWholeSecond < rightWholeSecond ? -1 : 1;
  }

  const precision = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeftFraction = leftFraction.padEnd(precision, "0");
  const normalizedRightFraction = rightFraction.padEnd(precision, "0");

  if (normalizedLeftFraction === normalizedRightFraction) {
    return 0;
  }
  return normalizedLeftFraction < normalizedRightFraction ? -1 : 1;
}

export const analysisStatusSchema = z.enum([
  "queued", "running", "succeeded", "partial",
  "retrying", "failed", "cancelled",
]);
export const observationSurfaceSchema = z.enum(["api", "consumer_ui", "manual"]);
export const normalizedObservationSchema = z.object({
  kind: z.string().min(1),
  subject: z.string().min(1),
  value: z.record(z.string(), z.json()),
  observedAt: z.string().datetime(),
  surface: observationSurfaceSchema.optional(),
});
export const analysisEnvelopeSchema = z.object({
  contractVersion: z.literal("1"),
  runId: z.string().min(1),
  clientId: z.string().min(1),
  brandId: z.string().min(1),
  siteId: z.string().min(1),
  siteMarketId: z.string().min(1).nullable(),
  source: z.string().min(1),
  sourceVersion: z.string().min(1),
  adapterVersion: z.string().min(1),
  status: analysisStatusSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  rawArtifact: z.object({
    uri: z.string().min(1),
    checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    mediaType: z.string().min(1),
    byteSize: z.number().int().nonnegative(),
  }).nullable(),
  observations: z.array(normalizedObservationSchema),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
  }).nullable(),
}).superRefine((value, context) => {
  if (value.status === "failed" && value.error === null) {
    context.addIssue({ code: "custom", path: ["error"], message: "failed envelopes require an error" });
  }
  if (
    value.finishedAt !== null &&
    compareUtcIsoDatetimes(value.finishedAt, value.startedAt) < 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["finishedAt"],
      message: "finishedAt must not precede startedAt",
    });
  }
});
export type AnalysisStatus = z.infer<typeof analysisStatusSchema>;
export type ObservationSurface = z.infer<typeof observationSurfaceSchema>;
export type AnalysisEnvelope = z.infer<typeof analysisEnvelopeSchema>;
export type NormalizedObservation = z.infer<typeof normalizedObservationSchema>;
