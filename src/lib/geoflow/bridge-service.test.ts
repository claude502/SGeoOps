import { describe, expect, it, vi } from "vitest";
import { GeoFlowBridgeService, type GeoFlowApi } from "@/lib/geoflow/bridge-service";
import { GeoFlowClient, GeoFlowHttpError } from "@/lib/geoflow/client";
import { readGeoFlowConfig, type GeoFlowConfig } from "@/lib/geoflow/config";
import { InMemoryGeoFlowBridgeRepository } from "@/lib/geoflow/repository";
import { safeGeoFlowErrorSummary } from "@/lib/geoflow/repository";
import { integrationErrorResponse } from "@/lib/geoflow/server";
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

  it("wraps non-JSON success responses in a stable client error", async () => {
    const client = new GeoFlowClient(
      config,
      vi.fn(async () => new Response("<html>ok</html>", { status: 200 })),
    );

    await expect(client.getCatalog()).rejects.toMatchObject({
      name: "GeoFlowHttpError",
      status: 502,
      code: "geoflow_invalid_json",
    } satisfies Partial<GeoFlowHttpError>);
  });

  it("wraps non-JSON HTTP failures without leaking parser errors", async () => {
    const client = new GeoFlowClient(
      config,
      vi.fn(async () => new Response("<html>server error</html>", { status: 500 })),
    );

    await expect(client.getCatalog()).rejects.toMatchObject({
      name: "GeoFlowHttpError",
      status: 500,
      code: "geoflow_http_error",
    } satisfies Partial<GeoFlowHttpError>);
  });

  it("turns slow upstream calls into timeout errors", async () => {
    const fetchFn = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );
    const client = new GeoFlowClient(config, fetchFn, { timeoutMs: 1 });

    await expect(client.getCatalog()).rejects.toMatchObject({
      name: "GeoFlowHttpError",
      status: 504,
      code: "geoflow_timeout",
    } satisfies Partial<GeoFlowHttpError>);
  });

  it("wraps network failures in stable client errors", async () => {
    const client = new GeoFlowClient(
      config,
      vi.fn(async () => {
        throw new Error("connection reset");
      }),
    );

    await expect(client.getCatalog()).rejects.toMatchObject({
      name: "GeoFlowHttpError",
      status: 502,
      code: "geoflow_network_error",
    } satisfies Partial<GeoFlowHttpError>);
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

describe("integrationErrorResponse", () => {
  it("maps upstream authentication failures to a safe internal failure", () => {
    const response = integrationErrorResponse(
      new GeoFlowHttpError(
        "authorization=top-secret",
        401,
        "geoflow_auth_failed",
        { responseBody: "full upstream content" },
      ),
    );

    expect(response).toEqual({
      body: {
        error: "GEOFlow integration request failed.",
        code: "geoflow_auth_failed",
      },
      status: 500,
    });
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
    expect(links[0].lastError).toBe("GEOFLOW_ENQUEUE_FAILED");
    expect(links[0]).not.toHaveProperty("taskPayload");
  });

  it("concurrently retries a failed enqueue with the same key without recreating the task", async () => {
    const repository = new InMemoryGeoFlowBridgeRepository();
    let enqueueAttempt = 0;
    const api = mockApi({
      createTask: vi.fn(async () => ({ id: 101 })),
      enqueueTask: vi.fn(async (_taskId, _payload, idempotencyKey) => {
        enqueueAttempt += 1;
        if (enqueueAttempt === 1) {
          throw new Error("authorization=Bearer top-secret");
        }
        return { task_id: 101, job_id: 202, status: "pending", idempotencyKey };
      }),
    });
    const service = new GeoFlowBridgeService(repository, api, config);

    await expect(service.sendToGeoFlow({ asset: seedAssets[0] })).rejects.toThrow();
    const recovered = await Promise.all([
      service.sendToGeoFlow({ asset: seedAssets[0] }),
      service.sendToGeoFlow({ asset: seedAssets[0] }),
    ]);

    expect(recovered[0]).toMatchObject({
      reused: false,
      link: { geoFlowTaskId: 101, geoFlowJobId: 202, status: "generating" },
    });
    expect(recovered[1]).toMatchObject({
      reused: false,
      link: { geoFlowTaskId: 101, geoFlowJobId: 202, status: "generating" },
    });
    expect(api.createTask).toHaveBeenCalledTimes(1);
    expect(api.enqueueTask).toHaveBeenCalledTimes(3);
    const enqueueKeys = (api.enqueueTask as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[2]);
    expect(new Set(enqueueKeys).size).toBe(1);
    expect(enqueueKeys[0]).toMatch(/_enqueue$/);
  });

  it("re-enqueues a failed link even when it retains a stale job id", async () => {
    const repository = new InMemoryGeoFlowBridgeRepository();
    const api = mockApi();
    const service = new GeoFlowBridgeService(repository, api, config);
    const first = await service.sendToGeoFlow({ asset: seedAssets[0] });
    await repository.updateLink(first.link.id, {
      status: "failed",
      lastError: "GEOFLOW_READ_FAILED",
    });

    const recovered = await service.sendToGeoFlow({ asset: seedAssets[0] });

    expect(recovered.reused).toBe(false);
    expect(recovered.link).toMatchObject({ status: "generating", geoFlowJobId: 202 });
    expect(api.createTask).toHaveBeenCalledTimes(1);
    expect(api.enqueueTask).toHaveBeenCalledTimes(2);
    expect(
      (api.enqueueTask as ReturnType<typeof vi.fn>).mock.calls[0]?.[2],
    ).toBe((api.enqueueTask as ReturnType<typeof vi.fn>).mock.calls[1]?.[2]);
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

  it("returns stable read errors without retaining upstream credentials", async () => {
    const repository = new InMemoryGeoFlowBridgeRepository();
    const api = mockApi({
      listTaskJobs: vi.fn(async () => {
        throw new Error("authorization=Bearer top-secret full upstream body");
      }),
    });
    const service = new GeoFlowBridgeService(repository, api, config);
    await service.sendToGeoFlow({ asset: seedAssets[0] });

    const result = await service.sync();

    expect(result.errors).toEqual([
      `${seedAssets[0].id}: GEOFLOW_READ_FAILED`,
    ]);
    expect(result.links[0].lastError).toBe("GEOFLOW_READ_FAILED");
    expect(JSON.stringify(result)).not.toContain("top-secret");
  });

  it("processes one bounded sync page and returns a continuation cursor", async () => {
    const repository = new InMemoryGeoFlowBridgeRepository();
    for (let index = 0; index < 30; index += 1) {
      const link = await repository.createLink({
        contentAssetId: `asset_${index.toString().padStart(2, "0")}`,
        idempotencyKey: `idem_${index.toString().padStart(2, "0")}`,
        status: "queued",
        taskPayload: {},
      });
      await repository.updateLink(link.id, { geoFlowTaskId: index + 1 });
    }
    const api = mockApi();
    const service = new GeoFlowBridgeService(repository, api, config);

    const first = await service.sync({ limit: 25 });
    const second = await service.sync({ cursor: first.nextCursor ?? undefined, limit: 25 });

    expect(first.links).toHaveLength(25);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    expect(second.links).toHaveLength(5);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(api.listTaskJobs).toHaveBeenCalledTimes(30);
  });
});

describe("safeGeoFlowErrorSummary", () => {
  it("redacts a Bearer credential including the token after the scheme", () => {
    const sanitized = safeGeoFlowErrorSummary(
      "authorization=Bearer top-secret response body",
    );

    expect(sanitized).not.toContain("top-secret");
    expect(sanitized).toBe("authorization=[redacted] response body");
  });
});
