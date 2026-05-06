declare module "@trigger.dev/sdk" {
  export interface JobLogger {
    info(message: string, metadata?: unknown): Promise<void> | void;
  }

  export interface JobIO {
    logger: JobLogger;
  }

  export class TriggerClient {
    constructor(config: {
      id: string;
      apiKey: string;
      apiUrl?: string;
    });

    defineJob(config: {
      id: string;
      name: string;
      version: string;
      trigger: unknown;
      run: (payload: unknown, io: JobIO) => Promise<unknown> | unknown;
    }): void;
  }

  export function cronTrigger(config: { cron: string }): unknown;
  export function eventTrigger<T>(config: { name: string; schema: T }): unknown;
}

declare module "@mendable/firecrawl-js" {
  export default class FirecrawlApp {
    constructor(config: { apiKey: string });

    scrapeUrl(
      url: string,
      options: {
        formats: string[];
        extract: {
          schema: Record<string, unknown>;
        };
      },
    ): Promise<{ extract?: unknown }>;
  }
}
