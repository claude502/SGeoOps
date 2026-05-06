declare module "@trigger.dev/sdk" {
  export type JobLogger = {
    info(message: string, payload?: unknown): Promise<void> | void;
  };

  export type JobIO = {
    logger: JobLogger;
  };

  export class TriggerClient {
    constructor(config: { id: string; apiKey: string; apiUrl: string });
    defineJob<T>(definition: T): T;
  }

  export function cronTrigger(config: { cron: string }): { cron: string };
  export function eventTrigger<T>(config: { name: string; schema: T }): {
    name: string;
    schema: T;
  };
}
