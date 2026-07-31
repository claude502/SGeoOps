import type { Prisma } from "@prisma/client";

const inboxTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export type InboxEventErrorCode =
  | "INBOX_INPUT_INVALID"
  | "INBOX_PAYLOAD_CONFLICT"
  | "INBOX_CLAIM_INDETERMINATE";

export class InboxEventError extends Error {
  constructor(
    readonly code: InboxEventErrorCode,
    message: string = code,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InboxEventError";
  }
}

function validateToken(
  value: string,
  field: string,
  maximumLength: number,
) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    !inboxTokenPattern.test(value)
  ) {
    throw new InboxEventError(
      "INBOX_INPUT_INVALID",
      `Invalid inbox ${field}.`,
    );
  }
}

export class Inbox {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async claim(
    source: string,
    externalId: string,
    payloadHash: string,
    eventType = "event",
  ): Promise<boolean> {
    validateToken(source, "source", 100);
    validateToken(externalId, "externalId", 200);
    validateToken(payloadHash, "payloadHash", 256);
    validateToken(eventType, "eventType", 200);

    const result = await this.tx.inboxEvent.createMany({
      data: { source, externalId, eventType, payloadHash },
      skipDuplicates: true,
    });
    if (result.count === 1) {
      return true;
    }
    if (result.count !== 0) {
      throw new InboxEventError(
        "INBOX_CLAIM_INDETERMINATE",
        "Inbox claim returned an invalid affected-row count.",
      );
    }

    const existing = await this.tx.inboxEvent.findUnique({
      where: { source_externalId: { source, externalId } },
      select: { payloadHash: true, eventType: true },
    });
    if (!existing) {
      throw new InboxEventError(
        "INBOX_CLAIM_INDETERMINATE",
        "Inbox claim conflict did not resolve to a stored event.",
      );
    }
    if (
      existing.payloadHash !== payloadHash ||
      existing.eventType !== eventType
    ) {
      throw new InboxEventError(
        "INBOX_PAYLOAD_CONFLICT",
        "Inbox key was already claimed with another payload.",
      );
    }
    return false;
  }
}
