import { Prisma } from "@prisma/client";

const eventTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const maximumJsonDepth = 100;
const maximumJsonNodes = 10_000;

export interface CreateOutboxEvent {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  availableAt?: Date;
}

export type OutboxEventErrorCode =
  | "OUTBOX_INPUT_INVALID"
  | "OUTBOX_PAYLOAD_INVALID";

export class OutboxEventError extends Error {
  constructor(
    readonly code: OutboxEventErrorCode,
    message: string = code,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OutboxEventError";
  }
}

type NormalizedJson =
  | null
  | boolean
  | number
  | string
  | NormalizedJson[]
  | { [key: string]: NormalizedJson };

function validateToken(value: string, field: string) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 200 ||
    !eventTokenPattern.test(value)
  ) {
    throw new OutboxEventError(
      "OUTBOX_INPUT_INVALID",
      `Invalid outbox ${field}.`,
    );
  }
}

function normalizeJsonValue(
  value: unknown,
): Prisma.InputJsonValue | Prisma.JsonNullValueInput {
  let nodes = 0;
  const active = new WeakSet<object>();

  const visit = (input: unknown, depth: number): NormalizedJson => {
    nodes += 1;
    if (nodes > maximumJsonNodes || depth > maximumJsonDepth) {
      throw new OutboxEventError(
        "OUTBOX_PAYLOAD_INVALID",
        "Outbox payload exceeds JSON complexity limits.",
      );
    }
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean"
    ) {
      return input;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        throw new OutboxEventError(
          "OUTBOX_PAYLOAD_INVALID",
          "Outbox payload numbers must be finite.",
        );
      }
      return input;
    }
    if (typeof input !== "object") {
      throw new OutboxEventError(
        "OUTBOX_PAYLOAD_INVALID",
        "Outbox payload must contain only JSON values.",
      );
    }
    if (active.has(input)) {
      throw new OutboxEventError(
        "OUTBOX_PAYLOAD_INVALID",
        "Outbox payload must not be circular.",
      );
    }

    active.add(input);
    try {
      if (Array.isArray(input)) {
        const descriptors = Object.getOwnPropertyDescriptors(input);
        const normalized: NormalizedJson[] = [];
        for (let index = 0; index < input.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (
            !descriptor ||
            !descriptor.enumerable ||
            !("value" in descriptor)
          ) {
            throw new OutboxEventError(
              "OUTBOX_PAYLOAD_INVALID",
              "Outbox payload arrays must be dense data arrays.",
            );
          }
          normalized.push(visit(descriptor.value, depth + 1));
        }
        const unexpected = Reflect.ownKeys(descriptors).filter((key) =>
          key !== "length" &&
          !(typeof key === "string" && /^(0|[1-9]\d*)$/.test(key))
        );
        if (unexpected.length > 0) {
          throw new OutboxEventError(
            "OUTBOX_PAYLOAD_INVALID",
            "Outbox payload arrays must not have custom properties.",
          );
        }
        return normalized;
      }

      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new OutboxEventError(
          "OUTBOX_PAYLOAD_INVALID",
          "Outbox payload objects must be plain JSON objects.",
        );
      }
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== "string")) {
        throw new OutboxEventError(
          "OUTBOX_PAYLOAD_INVALID",
          "Outbox payload must not contain symbol keys.",
        );
      }
      const normalized: Record<string, NormalizedJson> = {};
      for (const key of (keys as string[]).sort()) {
        const descriptor = descriptors[key];
        if (
          key === "__proto__" ||
          !descriptor?.enumerable ||
          !("value" in descriptor)
        ) {
          throw new OutboxEventError(
            "OUTBOX_PAYLOAD_INVALID",
            "Outbox payload contains an unsafe object property.",
          );
        }
        normalized[key] = visit(descriptor.value, depth + 1);
      }
      return normalized;
    } finally {
      active.delete(input);
    }
  };

  const normalized = visit(value, 0);
  if (normalized === null) {
    return Prisma.JsonNull;
  }
  if (Array.isArray(normalized)) {
    return normalized as Prisma.InputJsonValue;
  }
  return normalized as Prisma.InputJsonValue;
}

export async function createOutboxEvent(
  tx: Prisma.TransactionClient,
  event: CreateOutboxEvent,
): Promise<void> {
  validateToken(event.aggregateType, "aggregateType");
  validateToken(event.aggregateId, "aggregateId");
  validateToken(event.eventType, "eventType");
  if (
    event.availableAt !== undefined &&
    (!(event.availableAt instanceof Date) ||
      !Number.isFinite(event.availableAt.getTime()))
  ) {
    throw new OutboxEventError(
      "OUTBOX_INPUT_INVALID",
      "Invalid outbox availableAt.",
    );
  }
  const payload = normalizeJsonValue(event.payload);
  await tx.outboxEvent.create({
    data: {
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload,
      ...(event.availableAt === undefined
        ? {}
        : { availableAt: event.availableAt }),
    },
  });
}
