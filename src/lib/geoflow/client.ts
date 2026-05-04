import type { GeoFlowConfig } from "@/lib/geoflow/config";

type FetchLike = typeof fetch;

export interface GeoFlowEnvelope<T> {
  success: boolean;
  data: T | null;
  error: { code: string; message: string; details?: unknown } | null;
  meta?: { request_id?: string; timestamp?: string };
}

export interface GeoFlowTaskResponse {
  id?: number;
  task?: { id?: number };
  [key: string]: unknown;
}

export interface GeoFlowEnqueueResponse {
  task_id?: number;
  job_id?: number;
  status?: string;
  [key: string]: unknown;
}

export interface GeoFlowJobResponse {
  id?: number;
  task_id?: number;
  job_type?: string;
  status?: string;
  task_run_summary?: {
    article_id?: number | null;
    status?: string | null;
    error_message?: string | null;
  };
  [key: string]: unknown;
}

export interface GeoFlowArticleResponse {
  id?: number;
  task_id?: number;
  title?: string;
  slug?: string;
  url?: string;
  public_url?: string;
  status?: string;
  review_status?: string;
  published_at?: string | null;
  updated_at?: string | null;
  content?: string;
  excerpt?: string;
  summary?: string;
  [key: string]: unknown;
}

export class GeoFlowHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code = "geoflow_http_error",
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "GeoFlowHttpError";
  }
}

function isEnvelope<T>(value: unknown): value is GeoFlowEnvelope<T> {
  return Boolean(value && typeof value === "object" && "success" in value && "data" in value);
}

function withLeadingSlash(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}

export class GeoFlowClient {
  constructor(
    private readonly config: Pick<GeoFlowConfig, "baseUrl" | "apiToken">,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  getCatalog() {
    return this.request<unknown>("/api/v1/catalog", { method: "GET" });
  }

  createTask(payload: Record<string, unknown>, idempotencyKey: string) {
    return this.request<GeoFlowTaskResponse>("/api/v1/tasks", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "x-idempotency-key": idempotencyKey },
    });
  }

  enqueueTask(taskId: number, payload: Record<string, unknown>, idempotencyKey: string) {
    return this.request<GeoFlowEnqueueResponse>(`/api/v1/tasks/${taskId}/enqueue`, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "x-idempotency-key": idempotencyKey },
    });
  }

  listTaskJobs(taskId: number) {
    return this.request<{ items?: GeoFlowJobResponse[] }>(`/api/v1/tasks/${taskId}/jobs`, {
      method: "GET",
    });
  }

  listArticles(taskId: number) {
    return this.request<{ items?: GeoFlowArticleResponse[] }>(
      `/api/v1/articles?task_id=${encodeURIComponent(String(taskId))}&per_page=20`,
      { method: "GET" },
    );
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchFn(`${this.config.baseUrl}${withLeadingSlash(path)}`, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiToken}`,
        ...(init.headers || {}),
      },
    });

    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    const envelope = isEnvelope<T>(parsed) ? parsed : null;

    if (!response.ok || envelope?.success === false) {
      throw new GeoFlowHttpError(
        envelope?.error?.message || `GEOFlow request failed with ${response.status}`,
        response.status,
        envelope?.error?.code,
        envelope?.error?.details,
      );
    }

    return (envelope ? envelope.data : parsed) as T;
  }
}

export function extractTaskId(response: GeoFlowTaskResponse) {
  const id = response.id ?? response.task?.id;
  if (!Number.isFinite(id)) {
    throw new GeoFlowHttpError("GEOFlow task response did not include a task id.", 502);
  }

  return Number(id);
}

export function extractJobId(response: GeoFlowEnqueueResponse) {
  if (!Number.isFinite(response.job_id)) {
    throw new GeoFlowHttpError("GEOFlow enqueue response did not include a job id.", 502);
  }

  return Number(response.job_id);
}
