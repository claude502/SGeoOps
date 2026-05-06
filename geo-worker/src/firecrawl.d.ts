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
