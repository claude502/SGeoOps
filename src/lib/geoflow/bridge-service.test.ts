import { describe, expect, it, vi } from "vitest";
import { GeoFlowBridgeService, type GeoFlowApi } from "@/lib/geoflow/bridge-service";
import { GeoFlowClient } from "@/lib/geoflow/client";
import { readGeoFlowConfig, type GeoFlowConfig } from "@/lib/geoflow/config";
import { InMemoryGeoFlowBridgeRepository } from "@/lib/geoflow/repository";
import { seedAssets } from "@/lib/sample-data";

const config: GeoFlowConfig = {
  baseUrl: "https://geoflow.example",
  apiToken: "token",
  publicBaseUrl: "https://content.example",
  titleLibraryId: 1,
  promptId: 2,
  aiModelId: 3,
  authorId: null,
  knowledgeBaseId: null,
  fixedCategoryId: null,
};

function mockApi(overrides: Partial<GeoFlowApi> = {}): GeoFlowApi {
  return {
    getCatalog: vi.fn(async () => ({})),
    createTask: vi.fn(async () => ({ id: 101 })),
    enqueueTask: vi.fn(async () => ({ task_id: 101, job_id: 202, status: "pending" })),
    listTaskJobs: vi.fn(async () => ({ items: [] })),
    listArticles: vi.fn(async () => ({ items: [] })),
    ...overrides,
  };
}

describe("GeoFlowClient", () => {
  it("sends bearer token, base URL, and idempotency headers", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, data: { id: 1 }, error: null }), {
        status: 201,
      }),
    );
    const client = new GeoFlowClient(config, fetchFn);

    await client.createTask({ name: "Task" }, "idem-key");

    expect(fetchFn).toHaveBeenCalledWith(
      "https://geoflow.example/api/v1/tasks",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer token",
          "x-idempotency-key": "idem-key",
        }),
      }),
    );
  });
});

describe("readGeoFlowConfig", () => {
  it("reports missing catalog and auth configuration", () => {
    const result = readGeoFlowConfig({});

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(
      expect.arrayContaining([
        "GEOFLOW_BASE_URL",
        "GEOFLOW_API_TOKEN",
        "GEOFLOW_TITLE_LIBRARY_ID",
        "GEOFLOW_PROMPT_ID",
        "GEOFLOW_AI_MODEL_ID",
      ]),
    );
  });
});

describe("GeoFlowBridgeService", () => {
  it("creates and enqueues a GEOFlow task once per asset and brief", async () => {
    const repository = new InMemoryGeoFlowBridgeRepository();
    const api = mockApi();
    const service = new GeoFlowBridgeService(repository, api, config);

    const first = await service.sendToGeoFlow({ asset: seedAssets[0] });
    const second = await service.sendToGeoFlow({ asset: seedAssets[0] });

    expect(first.reused).toBe(false);
    expect(first.link.status).toBe("generating");
    expect(first.link.geoFlowTaskId).toBe(101);
    expect(first.link.geoFlowJobId).toBe(202);
    expect(second.reused).toBe(true);
    expect(api.createTask).toHaveBeenCalledTimes(1);
    expect(api.enqueueTask).toHaveBeenCalledTimes(1);
  });

  it("keeps the task link and marks it failed when enqueue fails", async () => {
    const repository = new InMemoryGeoFlowBridgeRepository();
    const api = mockApi({
      enqueueTask: vi.fn(async () => {
        throw new Error("enqueue failed");
      }),
    });
    const service = new GeoFlowBridgeService(repository, api, config);

    await expect(service.sendToGeoFlow({ asset: seedAssets[0] })).rejects.toThrow("enqueue failed");
    const links = await repository.listLinks();

    expect(links).toHaveLength(1);
    expect(links[0].geoFlowTaskId).toBe(101);
    expect(links[0].status).toBe("failed");
    expect(links[0].lastError).toBe("enqueue failed");
  });

  it("syncs a published GEOFlow article back onto the content asset link", async () => {
    const repository = new InMemoryGeoFlowBridgeRepository();
    const api = mockApi({
      listTaskJobs: vi.fn(async () => ({
        items: [{ id: 202, status: "completed", task_run_summary: { article_id: 303 } }],
      })),
      listArticles: vi.fn(async () => ({
        items: [{ id: 303, task_id: 101, slug: "aurora-guide", status: "published" }],
      })),
    });
    const service = new GeoFlowBridgeService(repository, api, config);

    await service.sendToGeoFlow({ asset: seedAssets[0] });
    const result = await service.sync();

    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(0);
    expect(result.links[0].status).toBe("published");
    expect(result.links[0].geoFlowArticleUrl).toBe("https://content.example/articles/aurora-guide");
  });
});
