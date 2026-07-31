import { describe, expect, it, vi } from "vitest";

import {
  createRunWithOutbox,
  type CreateAnalysisRun,
} from "@/lib/analysis/repository";
import {
  Inbox,
  InboxEventError,
} from "@/lib/events/inbox";
import {
  createOutboxEvent,
  OutboxEventError,
  type CreateOutboxEvent,
} from "@/lib/events/outbox";

const run: CreateAnalysisRun = {
  id: "run_1",
  clientId: "client_1",
  brandId: "brand_1",
  siteId: "site_1",
  siteMarketId: null,
  kind: "site-audit",
  source: "siteone",
  sourceVersion: "2.0.0",
  adapterVersion: "1.0.0",
  status: "queued",
  inputHash: "sha256:input",
  idempotencyKey: "siteone:site_1:2026-07-31",
  trigger: "manual",
};

const event: CreateOutboxEvent = {
  aggregateType: "AnalysisRun",
  aggregateId: "run_1",
  eventType: "analysis_run.created",
  payload: { runId: "run_1" },
};

function eventDatabase() {
  return {
    analysisRun: { create: vi.fn().mockResolvedValue({ id: "run_1" }) },
    outboxEvent: { create: vi.fn().mockResolvedValue({ id: "outbox_1" }) },
    inboxEvent: {
      createMany: vi.fn(),
      findUnique: vi.fn(),
    },
  };
}

describe("outbox", () => {
  it("creates the business run before the event on the supplied transaction", async () => {
    const database = eventDatabase();
    const order: string[] = [];
    database.analysisRun.create.mockImplementation(async () => {
      order.push("run");
      return { id: "run_1" };
    });
    database.outboxEvent.create.mockImplementation(async () => {
      order.push("outbox");
      return { id: "outbox_1" };
    });

    await createRunWithOutbox(database as never, run, event);

    expect(order).toEqual(["run", "outbox"]);
    expect(database.analysisRun.create).toHaveBeenCalledWith({ data: run });
    expect(database.outboxEvent.create).toHaveBeenCalledWith({
      data: {
        aggregateType: "AnalysisRun",
        aggregateId: "run_1",
        eventType: "analysis_run.created",
        payload: { runId: "run_1" },
      },
    });
  });

  it("propagates an outbox failure so the caller transaction can roll back", async () => {
    const database = eventDatabase();
    database.outboxEvent.create.mockRejectedValue(new Error("write failed"));

    await expect(
      createRunWithOutbox(database as never, run, event),
    ).rejects.toThrow("write failed");
  });

  it("rejects non-JSON-safe payloads before writing", async () => {
    const database = eventDatabase();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      createOutboxEvent(database as never, {
        ...event,
        payload: circular,
      }),
    ).rejects.toBeInstanceOf(OutboxEventError);
    expect(database.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("accepts JSON null as a payload", async () => {
    const database = eventDatabase();

    await createOutboxEvent(database as never, {
      ...event,
      payload: null,
    });

    expect(database.outboxEvent.create).toHaveBeenCalledOnce();
  });
});

describe("Inbox", () => {
  it("claims once and returns false for the same payload", async () => {
    const database = eventDatabase();
    database.inboxEvent.createMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    database.inboxEvent.findUnique.mockResolvedValue({
      source: "geoflow",
      externalId: "event_1",
      eventType: "event",
      payloadHash: "hash_1",
    });
    const inbox = new Inbox(database as never);

    await expect(
      inbox.claim("geoflow", "event_1", "hash_1"),
    ).resolves.toBe(true);
    await expect(
      inbox.claim("geoflow", "event_1", "hash_1"),
    ).resolves.toBe(false);
    expect(database.inboxEvent.createMany).toHaveBeenCalledWith({
      data: {
        source: "geoflow",
        externalId: "event_1",
        eventType: "event",
        payloadHash: "hash_1",
      },
      skipDuplicates: true,
    });
  });

  it("throws a stable conflict for the same key with another payload", async () => {
    const database = eventDatabase();
    database.inboxEvent.createMany.mockResolvedValue({ count: 0 });
    database.inboxEvent.findUnique.mockResolvedValue({
      source: "geoflow",
      externalId: "event_1",
      eventType: "event",
      payloadHash: "hash_other",
    });
    const inbox = new Inbox(database as never);

    await expect(
      inbox.claim("geoflow", "event_1", "hash_1"),
    ).rejects.toMatchObject({ code: "INBOX_PAYLOAD_CONFLICT" });
  });

  it.each([
    ["source", "", "event_1", "hash_1", "event"],
    ["external id", "geoflow", "../event", "hash_1", "event"],
    ["hash", "geoflow", "event_1", "bad hash", "event"],
    ["event type", "geoflow", "event_1", "hash_1", ""],
  ])(
    "validates %s before claiming",
    async (_label, source, externalId, payloadHash, eventType) => {
      const database = eventDatabase();
      const inbox = new Inbox(database as never);

      await expect(
        inbox.claim(source, externalId, payloadHash, eventType),
      ).rejects.toBeInstanceOf(InboxEventError);
      expect(database.inboxEvent.createMany).not.toHaveBeenCalled();
    },
  );
});
