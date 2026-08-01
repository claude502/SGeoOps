import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scheduledTask: vi.fn((definition: { id: string }) => ({ id: definition.id })),
  info: vi.fn(),
}));

vi.mock("@trigger.dev/sdk", () => ({
  schedules: { task: mocks.scheduledTask },
  logger: { info: mocks.info },
}));

type ScheduledTaskDefinition = {
  id: string;
  cron: string;
  run: () => Promise<{ audited: number }>;
};

const { seoAuditTask } = await import("./seo-audit");

describe("seoAuditTask", () => {
  it("registers the legacy daily audit through the Trigger v4 schedules API", () => {
    expect(seoAuditTask.id).toBe("seo-audit");
    expect(mocks.scheduledTask).toHaveBeenCalledTimes(1);

    const [definition] = mocks.scheduledTask.mock.calls[0] as [
      ScheduledTaskDefinition,
    ];
    expect(definition).toMatchObject({
      id: "seo-audit",
      cron: "0 3 * * *",
    });
  });

  it("logs the audit start and preserves the daily audit result", async () => {
    const [definition] = mocks.scheduledTask.mock.calls[0] as [
      ScheduledTaskDefinition,
    ];

    await expect(definition.run()).resolves.toEqual({ audited: 0 });
    expect(mocks.info).toHaveBeenCalledWith("SEO audit started");
  });
});
