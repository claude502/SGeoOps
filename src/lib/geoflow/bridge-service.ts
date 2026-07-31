import { createHash } from "node:crypto";
import type { ContentAsset, GeoBrief, GeoFlowTaskLinkView, GeoFlowTaskStatus } from "@/types/geo";
import type {
  GeoFlowArticleResponse,
  GeoFlowEnqueueResponse,
  GeoFlowJobResponse,
  GeoFlowTaskResponse,
} from "@/lib/geoflow/client";
import { extractJobId, extractTaskId } from "@/lib/geoflow/client";
import type { GeoFlowConfig } from "@/lib/geoflow/config";
import type {
  GeoFlowBridgeRepository,
  GeoFlowTaskLinkRecord,
  ListSyncableLinksOptions,
} from "@/lib/geoflow/repository";
import { toPublicGeoFlowLink } from "@/lib/geoflow/repository";

export interface GeoFlowApi {
  getCatalog(): Promise<unknown>;
  createTask(payload: Record<string, unknown>, idempotencyKey: string): Promise<GeoFlowTaskResponse>;
  enqueueTask(
    taskId: number,
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<GeoFlowEnqueueResponse>;
  listTaskJobs(taskId: number): Promise<{ items?: GeoFlowJobResponse[] }>;
  listArticles(taskId: number): Promise<{ items?: GeoFlowArticleResponse[] }>;
}

export interface SendToGeoFlowInput {
  asset: ContentAsset;
  brief?: GeoBrief | null;
}

export interface SendToGeoFlowResult {
  link: GeoFlowTaskLinkView;
  reused: boolean;
}

export interface SyncGeoFlowResult {
  syncRunId: string;
  successCount: number;
  failureCount: number;
  links: GeoFlowTaskLinkView[];
  errors: string[];
  hasMore: boolean;
  nextCursor: string | null;
}

const GEOFLOW_CREATE_FAILED = "GEOFLOW_CREATE_FAILED";
const GEOFLOW_ENQUEUE_FAILED = "GEOFLOW_ENQUEUE_FAILED";
const GEOFLOW_READ_FAILED = "GEOFLOW_READ_FAILED";

function deterministicKey(parts: string[]) {
  const digest = createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 24);
  return `geoflow_${digest}`;
}

function titleFor(asset: ContentAsset, brief?: GeoBrief | null) {
  return brief?.title?.trim() || asset.title;
}

export function buildGeoFlowTaskPayload(
  asset: ContentAsset,
  config: GeoFlowConfig,
  brief?: GeoBrief | null,
) {
  return {
    name: titleFor(asset, brief),
    title_library_id: config.titleLibraryId,
    prompt_id: config.promptId,
    ai_model_id: config.aiModelId,
    need_review: 1,
    auto_keywords: 1,
    auto_description: 1,
    draft_limit: 1,
    article_limit: 1,
    status: "active",
    category_mode: config.fixedCategoryId ? "fixed" : "smart",
    model_selection_mode: "fixed",
    ...(config.authorId ? { author_id: config.authorId } : {}),
    ...(config.knowledgeBaseId ? { knowledge_base_id: config.knowledgeBaseId } : {}),
    ...(config.fixedCategoryId ? { fixed_category_id: config.fixedCategoryId } : {}),
    geo_ops: {
      content_asset_id: asset.id,
      title: asset.title,
      summary: asset.summary,
      canonical_url: asset.canonicalUrl,
      keywords: asset.targetKeywords,
      brief_objective: brief?.objective ?? null,
      outline: brief?.outline ?? [],
      faq: brief?.faq ?? [],
    },
  };
}

function buildEnqueuePayload(asset: ContentAsset, brief?: GeoBrief | null) {
  return {
    job_type: "generate_article",
    source: "geo_ops",
    geo_ops_content_asset_id: asset.id,
    keywords: asset.targetKeywords,
    canonical_url: asset.canonicalUrl,
    brief_objective: brief?.objective ?? asset.summary,
    outline: brief?.outline ?? [],
    faq: brief?.faq ?? [],
  };
}

function normalizeJobStatus(status: string | undefined | null): GeoFlowTaskStatus {
  const normalized = (status || "").toLowerCase();
  if (["pending", "queued"].includes(normalized)) {
    return "queued";
  }
  if (["running", "processing", "started"].includes(normalized)) {
    return "generating";
  }
  if (["failed", "error", "cancelled", "canceled"].includes(normalized)) {
    return "failed";
  }
  if (["completed", "complete", "succeeded", "success", "done"].includes(normalized)) {
    return "reviewing";
  }
  return "reviewing";
}

function isPublishedArticle(article: GeoFlowArticleResponse) {
  return (
    Boolean(article.published_at) ||
    ["published", "publish", "online"].includes(String(article.status || "").toLowerCase())
  );
}

function articleUrl(article: GeoFlowArticleResponse, publicBaseUrl: string | null) {
  if (article.public_url) {
    return article.public_url;
  }
  if (article.url) {
    return article.url;
  }
  if (!publicBaseUrl) {
    return null;
  }
  const slugOrId = article.slug || article.id;
  return slugOrId ? `${publicBaseUrl}/articles/${slugOrId}` : null;
}

function latestJob(jobs: GeoFlowJobResponse[]) {
  return jobs[0] ?? null;
}

export class GeoFlowBridgeService {
  constructor(
    private readonly repository: GeoFlowBridgeRepository,
    private readonly client: GeoFlowApi,
    private readonly config: GeoFlowConfig,
  ) {}

  async sendToGeoFlow(input: SendToGeoFlowInput): Promise<SendToGeoFlowResult> {
    const { asset, brief } = input;
    const idempotencyKey = deterministicKey([asset.id, titleFor(asset, brief)]);
    const existing = await this.repository.findLinkByIdempotencyKey(idempotencyKey);
    if (
      existing?.geoFlowTaskId &&
      existing.geoFlowJobId &&
      existing.status !== "failed"
    ) {
      return { link: toPublicGeoFlowLink(existing), reused: true };
    }

    const taskPayload = buildGeoFlowTaskPayload(asset, this.config, brief);
    await this.repository.ensureContentAsset(asset);
    let link =
      existing ??
      (await this.repository.createLink({
        contentAssetId: asset.id,
        idempotencyKey,
        status: "not_sent",
        taskPayload,
      }));

    let taskId = link.geoFlowTaskId;
    if (!taskId) {
      try {
        const task = await this.client.createTask(taskPayload, idempotencyKey);
        taskId = extractTaskId(task);
      } catch (error) {
        await this.repository.updateLink(link.id, {
          status: "failed",
          lastError: GEOFLOW_CREATE_FAILED,
        });
        throw error;
      }
      link = await this.repository.updateLink(link.id, {
        geoFlowTaskId: taskId,
        status: "queued",
        lastError: null,
      });
    }

    try {
      const enqueue = await this.client.enqueueTask(
        taskId,
        buildEnqueuePayload(asset, brief),
        `${idempotencyKey}_enqueue`,
      );
      const jobId = extractJobId(enqueue);

      link = await this.repository.updateLink(link.id, {
        geoFlowJobId: jobId,
        status: "generating",
        lastError: null,
      });

      return { link: toPublicGeoFlowLink(link), reused: false };
    } catch (error) {
      await this.repository.updateLink(link.id, {
        status: "failed",
        lastError: GEOFLOW_ENQUEUE_FAILED,
      });
      throw error;
    }
  }

  async sync(options?: ListSyncableLinksOptions): Promise<SyncGeoFlowResult> {
    const page = await this.repository.listSyncableLinks(options);
    const syncRun = await this.repository.createSyncRun();
    const updated: GeoFlowTaskLinkView[] = [];
    const errors: string[] = [];
    let successCount = 0;
    let failureCount = 0;

    for (const link of page.links) {
      try {
        const next = await this.syncLink(link);
        updated.push(next);
        successCount += 1;
      } catch (error) {
        failureCount += 1;
        errors.push(`${link.contentAssetId}: ${GEOFLOW_READ_FAILED}`);
        updated.push(
          toPublicGeoFlowLink(
            await this.repository.updateLink(link.id, {
              status: "failed",
              lastSyncedAt: new Date(),
              lastError: GEOFLOW_READ_FAILED,
            }),
          ),
        );
      }
    }

    await this.repository.finishSyncRun(syncRun.id, {
      successCount,
      failureCount,
      errorSummary: errors.length ? errors.join("; ") : null,
    });

    return {
      syncRunId: syncRun.id,
      successCount,
      failureCount,
      links: updated,
      errors,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
  }

  private async syncLink(link: GeoFlowTaskLinkRecord) {
    if (!link.geoFlowTaskId) {
      return toPublicGeoFlowLink(
        await this.repository.updateLink(link.id, {
          status: "queued",
          lastSyncedAt: new Date(),
        }),
      );
    }

    const [jobsPayload, articlesPayload] = await Promise.all([
      this.client.listTaskJobs(link.geoFlowTaskId),
      this.client.listArticles(link.geoFlowTaskId),
    ]);
    const job = latestJob(jobsPayload.items ?? []);
    const articles = articlesPayload.items ?? [];
    const published = articles.find(isPublishedArticle);

    if (published) {
      const url = articleUrl(published, this.config.publicBaseUrl);
      if (!url) {
        throw new Error(GEOFLOW_READ_FAILED);
      }
      return toPublicGeoFlowLink(await this.repository.commitPublishedLink(link.id, {
        geoFlowJobId: job?.id ?? link.geoFlowJobId,
        geoFlowArticleId: Number(published.id),
        geoFlowArticleUrl: url,
        publishedAt: published.published_at || new Date(),
      }));
    }

    const jobArticleId = job?.task_run_summary?.article_id;
    return toPublicGeoFlowLink(
      await this.repository.updateLink(link.id, {
        geoFlowJobId: job?.id ?? link.geoFlowJobId,
        geoFlowArticleId: Number.isFinite(jobArticleId)
          ? Number(jobArticleId)
          : link.geoFlowArticleId,
        status: normalizeJobStatus(job?.status),
        lastSyncedAt: new Date(),
        lastError: job?.task_run_summary?.error_message
          ? GEOFLOW_READ_FAILED
          : null,
      }),
    );
  }
}
