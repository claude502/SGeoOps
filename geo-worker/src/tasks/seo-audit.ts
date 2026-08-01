import { logger, schedules } from "@trigger.dev/sdk";

export const seoAuditTask = schedules.task({
  id: "seo-audit",
  cron: "0 3 * * *",
  run: async () => {
    logger.info("SEO audit started");
    return { audited: 0 };
  },
});
