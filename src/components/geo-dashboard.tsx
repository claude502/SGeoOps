"use client";

import {
  Activity,
  BookOpenText,
  Bot,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  FileText,
  Gauge,
  Globe2,
  Layers3,
  Lightbulb,
  Link2,
  Loader2,
  Network,
  Play,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import {
  LOCAL_PANEL_NAV_ITEMS,
  OPERATIONS_NAV_ITEMS,
  type NavSection,
} from "@/components/geo-navigation";
import type {
  ChannelPlatform,
  ChannelVariant,
  ContentAsset,
  ContentAssetType,
  ContentLocale,
  DashboardSnapshot,
  GEORun,
  AuditEventView,
  GeoFlowTaskLinkView,
  GeoBrief,
  PublishTarget,
  Provider,
} from "@/types/geo";

type ActionState =
  | "idle"
  | "audit"
  | "brief"
  | "variant"
  | "refresh"
  | "geoflow"
  | "sync"
  | "workspace";
type ToastTone = "info" | "success" | "danger";
type ToastMessage = { text: string; tone: ToastTone } | null;

const actionHeaders = {
  "content-type": "application/json",
};

const emptyAssetDraft = {
  title: "",
  brandEntity: "",
  canonicalUrl: "",
  sourceUrl: "",
  targetKeywords: "",
  summary: "",
  body: "",
  owner: "",
  slug: "",
  locale: "zh-CN" as ContentLocale,
  assetType: "guide-page" as ContentAssetType,
  audience: "",
  isPublic: false,
  publishTarget: "geo_ops_internal" as PublishTarget,
};

type AssetDraft = typeof emptyAssetDraft;
type AssetDraftErrors = Partial<Record<keyof AssetDraft, string>>;
type IntegrationStatus = {
  checkedAt?: string;
  databaseConfigured: boolean;
  databaseReachable?: boolean;
  databaseError?: string | null;
  geoFlowConfigured: boolean;
  missing: string[];
  catalogReachable: boolean;
  catalogError: string | null;
  geoFlowStatusTimeoutMs?: number;
  links: GeoFlowTaskLinkView[];
  postizConfigured?: boolean;
};
type TxpuroInitPayload = {
  project: DashboardSnapshot["project"];
  prompts: string[];
  assets: ContentAsset[];
};

const providerPalette: Record<Provider, string> = {
  ChatGPT: "teal",
  Perplexity: "cobalt",
  Gemini: "amber",
  Claude: "ink",
};

function averageScore(runs: GEORun[]) {
  if (!runs.length) {
    return 0;
  }

  return Math.round(runs.reduce((sum, run) => sum + run.score, 0) / runs.length);
}

function formatDate(value: string | null) {
  if (!value) {
    return "未排期 / Unscheduled";
  }

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusTone(status: string) {
  if (["Ready", "Published", "Configured", "published"].includes(status)) {
    return "success";
  }

  if (["Review", "Simulated", "reviewing", "not_sent"].includes(status)) {
    return "warning";
  }

  if (["Scheduled", "queued", "generating"].includes(status)) {
    return "info";
  }

  if (["failed"].includes(status)) {
    return "danger";
  }

  return "neutral";
}

function geoFlowStatusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function Button({
  children,
  icon,
  onClick,
  variant = "primary",
  disabled,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
}) {
  return (
    <button
      className={clsx("button", `button-${variant}`)}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

function Chip({ children, tone = "neutral" }: { children: React.ReactNode; tone?: string }) {
  return <span className={clsx("chip", `chip-${tone}`)}>{children}</span>;
}

function MetricTile({
  icon,
  label,
  value,
  trend,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  trend: string;
  tone: "teal" | "cobalt" | "amber";
}) {
  return (
    <section className="metric-tile">
      <div className={clsx("metric-icon", `metric-${tone}`)}>{icon}</div>
      <div>
        <p className="metric-label">{label}</p>
        <strong>{value}</strong>
        <span>{trend}</span>
      </div>
    </section>
  );
}

export function Sidebar({
  activeSection,
  onSelect,
}: {
  activeSection: NavSection;
  onSelect: (section: NavSection) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Network size={22} strokeWidth={2.2} />
        </div>
        <span>GEO Ops</span>
      </div>

      <nav aria-label="Primary navigation" className="nav-list">
        {LOCAL_PANEL_NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              aria-label={item.label}
              aria-current={activeSection === item.id ? "page" : undefined}
              className={clsx("nav-item", activeSection === item.id && "nav-item-active")}
              key={item.label}
              onClick={() => onSelect(item.id)}
              type="button"
            >
              <Icon size={18} />
              <span>{item.label}</span>
            </button>
          );
        })}
        {OPERATIONS_NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              aria-label={item.label}
              className="nav-item"
              href={item.href}
              key={item.href}
            >
              <Icon aria-hidden="true" size={18} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-callout">
        <ShieldCheck size={18} />
        <strong>Postiz 交接 / Postiz handoff</strong>
        <p>配置 Postiz webhook 前，渠道版本会保留在审核队列。 / Variants stay in review until configured.</p>
      </div>
    </aside>
  );
}

function Header({
  snapshot,
  action,
  hasAsset,
  onAudit,
  onBrief,
  onVariant,
}: {
  snapshot: DashboardSnapshot;
  action: ActionState;
  hasAsset: boolean;
  onAudit: () => void;
  onBrief: () => void;
  onVariant: () => void;
}) {
  const isBusy = action !== "idle";

  return (
    <header className="topbar">
      <div>
        <p className="crumb">
          <Globe2 size={15} />
          {snapshot.project.canonicalDomain}
        </p>
        <h1>{snapshot.project.name}</h1>
      </div>
      <div className="top-actions">
        <Button
          disabled={isBusy || !hasAsset}
          icon={action === "audit" ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
          onClick={onAudit}
        >
          运行 GEO 审计 / Run GEO Audit
        </Button>
        <Button
          disabled={isBusy || !hasAsset}
          icon={action === "brief" ? <Loader2 className="spin" size={16} /> : <BookOpenText size={16} />}
          onClick={onBrief}
          variant="secondary"
        >
          创建 Brief / Create Brief
        </Button>
        <Button
          disabled={isBusy || !hasAsset}
          icon={action === "variant" ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
          onClick={onVariant}
          variant="secondary"
        >
          生成渠道版本 / Generate Variants
        </Button>
      </div>
    </header>
  );
}

function ProviderStrip({ runs, snapshot }: { runs: GEORun[]; snapshot: DashboardSnapshot }) {
  const providerScores = useMemo(() => {
    return snapshot.providerHealth.map((health) => {
      const matchingRuns = runs.filter((run) => run.provider === health.provider);
      return {
        ...health,
        average: averageScore(matchingRuns),
        runs: matchingRuns.length,
      };
    });
  }, [runs, snapshot.providerHealth]);

  return (
    <section className="panel provider-panel">
      <div className="panel-heading">
        <div>
          <p>Provider 覆盖 / Provider coverage</p>
          <h2>AI 答案引擎状态 / AI answer engine status</h2>
        </div>
        <Chip tone="info">{runs.length} 次监测 / stored runs</Chip>
      </div>
      <div className="provider-grid">
        {providerScores.map((provider) => (
          <div className="provider-card" key={provider.provider}>
            <div className="provider-head">
              <span className={clsx("provider-dot", providerPalette[provider.provider])} />
              <strong>{provider.provider}</strong>
              <Chip tone={statusTone(provider.status)}>{provider.status}</Chip>
            </div>
            <div className="provider-score">
              <span>{provider.average || "--"}</span>
              <div className="score-track">
                <div style={{ width: `${provider.average || 12}%` }} />
              </div>
            </div>
            <p>
              {provider.runs} 次 / runs - {provider.latencyMs}ms - {formatDate(provider.lastRunAt)}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function AssetTable({
  assets,
  selectedAssetId,
  onAdd,
  onSelect,
}: {
  assets: ContentAsset[];
  selectedAssetId: string;
  onAdd: () => void;
  onSelect: (assetId: string) => void;
}) {
  return (
    <section className="panel asset-panel">
      <div className="panel-heading">
        <div>
          <p>内容资产 / Content assets</p>
          <h2>真实信源队列 / Real source queue</h2>
        </div>
        <Button icon={<Plus size={16} />} onClick={onAdd} variant="ghost">
          添加真实资产 / Add Asset
        </Button>
      </div>

      <div aria-label="Content assets" className="asset-table" role="listbox">
        <div className="table-row table-head">
          <span>标题 / Title</span>
          <span>关键词 / Keywords</span>
          <span>状态 / Status</span>
          <span>GEO</span>
        </div>
        {assets.length ? assets.map((asset) => (
          <button
            className={clsx("table-row asset-row", selectedAssetId === asset.id && "row-active")}
            key={asset.id}
            onClick={() => onSelect(asset.id)}
            aria-selected={selectedAssetId === asset.id}
            role="option"
            type="button"
          >
            <span>
              <strong>{asset.title}</strong>
              <small>
                <Link2 size={13} />
                {asset.canonicalUrl.replace("https://", "")}
              </small>
              <small>
                {asset.locale ?? "zh-CN"} · {asset.assetType ?? "guide-page"} · {asset.isPublic ? "txpuro public" : "internal"}
              </small>
            </span>
            <span className="keyword-stack">
              {asset.targetKeywords.slice(0, 2).map((keyword) => (
                <Chip key={keyword}>{keyword}</Chip>
              ))}
            </span>
            <span>
              <Chip tone={statusTone(asset.status)}>{asset.status}</Chip>
            </span>
            <span className="score-cell">
              <strong>{asset.geoScore}</strong>
              <small>/100</small>
            </span>
          </button>
        )) : (
          <div className="empty-state">
            <FileText size={28} />
            <strong>还没有真实内容资产 / No real content assets yet</strong>
            <p>添加你的品牌文章、官网页面或 GEO brief，系统将只展示真实录入的数据。 / Add your real brand content, source page, or brief.</p>
            <Button icon={<Plus size={16} />} onClick={onAdd} variant="secondary">
              添加第一条资产 / Add first asset
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function VariantWorkflow({
  variants,
  selectedAssetId,
}: {
  variants: ChannelVariant[];
  selectedAssetId: string;
}) {
  const related = variants.filter((variant) => variant.contentAssetId === selectedAssetId);
  const visible = related.length ? related : variants.slice(0, 4);

  return (
    <section className="panel variant-panel">
      <div className="panel-heading">
        <div>
          <p>渠道版本 / Channel variants</p>
          <h2>知识站到账号 / Knowledge site to accounts</h2>
        </div>
        <Chip tone="info">{visible.length} 个版本 / variants</Chip>
      </div>
      <div className="variant-flow">
        {visible.map((variant) => (
          <article className="variant-card" key={variant.id}>
            <div className="variant-platform">
              <span>{variant.platform}</span>
              <Chip tone={statusTone(variant.status)}>{variant.status}</Chip>
            </div>
            <p>{variant.copy}</p>
            <div className="variant-meta">
              <span>
                <CalendarClock size={14} />
                {formatDate(variant.scheduledAt)}
              </span>
              <span>{variant.accountId}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function RunTimeline({ onRefresh, runs }: { onRefresh: () => void; runs: GEORun[] }) {
  return (
    <section className="panel run-panel">
      <div className="panel-heading">
        <div>
          <p>近期 GEO 监测 / Recent GEO runs</p>
          <h2>可见性证据 / Visibility evidence</h2>
        </div>
        <Button icon={<RefreshCw size={16} />} onClick={onRefresh} variant="ghost">
          刷新 / Refresh
        </Button>
      </div>
      <div className="run-list">
        {runs.length ? runs.slice(0, 5).map((run) => (
          <article className="run-item" key={run.id}>
            <div className={clsx("run-icon", providerPalette[run.provider])}>
              <Bot size={16} />
            </div>
            <div>
              <div className="run-line">
                <strong>{run.provider}</strong>
                <Chip tone={run.brandMentioned ? "success" : "warning"}>
                  {run.brandMentioned ? "品牌出现 / Brand found" : "品牌缺失 / Brand missing"}
                </Chip>
                <span>{run.score}/100</span>
              </div>
              <p>{run.prompt}</p>
              <small>{run.citedDomains.length ? run.citedDomains.join(", ") : "无引用 / No citations"}</small>
            </div>
          </article>
        )) : (
          <div className="empty-state compact">
            <Bot size={24} />
            <strong>暂无真实 GEO 监测 / No real GEO runs yet</strong>
            <p>添加真实资产后运行 GEO 审计。 / Add a real asset, then run an audit.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function RightRail({
  selectedAsset,
  latestRun,
  brief,
  message,
  geoFlowLink,
  action,
  onSendToGeoFlow,
  onSyncGeoFlow,
}: {
  selectedAsset: ContentAsset;
  latestRun: GEORun | undefined;
  brief: GeoBrief | null;
  message: ToastMessage;
  geoFlowLink: GeoFlowTaskLinkView | undefined;
  action: ActionState;
  onSendToGeoFlow: () => void;
  onSyncGeoFlow: () => void;
}) {
  const recommendations = latestRun?.recommendations ?? [];
  const geoFlowStatus = geoFlowLink?.status ?? "not_sent";
  const isBusy = action !== "idle";

  return (
    <aside className="right-rail">
      <section className="panel action-panel">
        <div className="panel-heading">
          <div>
            <p>当前资产 / Selected asset</p>
            <h2>{selectedAsset.title}</h2>
          </div>
          <Chip tone={statusTone(selectedAsset.status)}>{selectedAsset.status}</Chip>
        </div>
        <p className="asset-summary">{selectedAsset.summary}</p>
        <div className="asset-score-box">
          <Gauge size={18} />
          <span>GEO 分数 / GEO score</span>
          <strong>{selectedAsset.geoScore}</strong>
        </div>
      </section>

      <section className="panel geoflow-panel">
        <div className="panel-heading">
          <div>
            <p>GEOFlow 桥接 / GEOFlow bridge</p>
            <h2>内容工厂交接 / Content factory handoff</h2>
          </div>
          <Chip tone={statusTone(geoFlowStatus)}>{geoFlowStatusLabel(geoFlowStatus)}</Chip>
        </div>
        <div className="geoflow-body">
          <div className="geoflow-state">
            <span>任务 / Task</span>
            <strong>{geoFlowLink?.geoFlowTaskId ?? "未发送 / Not sent"}</strong>
          </div>
          <div className="geoflow-state">
            <span>作业 / Job</span>
            <strong>{geoFlowLink?.geoFlowJobId ?? "无作业 / No job"}</strong>
          </div>
          {geoFlowLink?.geoFlowArticleUrl ? (
            <a className="external-link" href={geoFlowLink.geoFlowArticleUrl} rel="noreferrer" target="_blank">
              打开已发布文章 / Open published article
              <ExternalLink size={14} />
            </a>
          ) : null}
          {geoFlowLink?.lastError ? <p className="error-text">{geoFlowLink.lastError}</p> : null}
          <div className="geoflow-actions">
            <Button
              disabled={isBusy}
              icon={action === "geoflow" ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
              onClick={onSendToGeoFlow}
              variant="secondary"
            >
              发送到 GEOFlow / Send to GEOFlow
            </Button>
            <Button
              disabled={isBusy}
              icon={action === "sync" ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
              onClick={onSyncGeoFlow}
              variant="ghost"
            >
              同步 GEOFlow / Sync GEOFlow
            </Button>
          </div>
        </div>
      </section>

      <section className="panel recommendations">
        <div className="panel-heading">
          <div>
            <p>建议 / Recommendations</p>
            <h2>下一步修复 / Next fixes</h2>
          </div>
          <Lightbulb size={18} />
        </div>
        {recommendations.map((recommendation) => (
          <article className="rec-item" key={recommendation.id}>
            <div>
              <Chip tone={recommendation.priority === "High" ? "warning" : "neutral"}>
                {recommendation.kind}
              </Chip>
              <strong>{recommendation.title}</strong>
            </div>
            <p>{recommendation.detail}</p>
          </article>
        ))}
      </section>

      <section className="panel brief-panel">
        <div className="panel-heading">
          <div>
            <p>内容 Brief / Content brief</p>
            <h2>{brief?.title ?? "可生成 / Ready to generate"}</h2>
          </div>
          <ClipboardList size={18} />
        </div>
        {brief ? (
          <div className="brief-body">
            <p>{brief.objective}</p>
            <div>
              {brief.outline.slice(0, 3).map((item) => (
                <span key={item}>
                  <CheckCircle2 size={14} />
                  {item}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <p className="muted">创建 Brief 会生成实体覆盖、提纲、FAQ、对比角度和 schema 建议。 / Create Brief will generate entity coverage, outline, FAQ, comparison angles, and schema suggestions.</p>
        )}
      </section>

      {message ? (
        <div className={clsx("toast", `toast-${message.tone}`)} role="status">
          {message.text}
        </div>
      ) : null}
    </aside>
  );
}

function FieldError({ error }: { error?: string }) {
  return error ? <small className="field-error">{error}</small> : null;
}

function AssetFormModal({
  draft,
  errors,
  onChange,
  onClearError,
  onClose,
  onSubmit,
  submitting,
}: {
  draft: AssetDraft;
  errors: AssetDraftErrors;
  onChange: (draft: AssetDraft) => void;
  onClearError: (field: keyof AssetDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  function update(field: keyof AssetDraft, value: AssetDraft[keyof AssetDraft]) {
    onClearError(field);
    onChange({ ...draft, [field]: value });
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-modal="true" className="modal-panel" role="dialog">
        <div className="panel-heading">
          <div>
            <p>真实内容资产 / Real content asset</p>
            <h2>添加品牌信源 / Add brand source</h2>
          </div>
          <button className="icon-button" onClick={onClose} type="button">
            ×
          </button>
        </div>
        <div className="asset-form">
          <label>
            <span>标题 / Title</span>
            <input
              aria-invalid={Boolean(errors.title)}
              onChange={(event) => update("title", event.target.value)}
              placeholder="例如：品牌 GEO 内容策略 / Brand GEO content strategy"
              value={draft.title}
            />
            <FieldError error={errors.title} />
          </label>
          <label>
            <span>品牌实体 / Brand entity</span>
            <input
              aria-invalid={Boolean(errors.brandEntity)}
              onChange={(event) => update("brandEntity", event.target.value)}
              placeholder="你的真实品牌名 / Your real brand"
              value={draft.brandEntity}
            />
            <FieldError error={errors.brandEntity} />
          </label>
          <label>
            <span>Canonical URL</span>
            <input
              aria-invalid={Boolean(errors.canonicalUrl)}
              onChange={(event) => update("canonicalUrl", event.target.value)}
              placeholder="https://www.example.com/article"
              value={draft.canonicalUrl}
            />
            <FieldError error={errors.canonicalUrl} />
          </label>
          <label>
            <span>来源 URL / Source URL</span>
            <input
              aria-invalid={Boolean(errors.sourceUrl)}
              onChange={(event) => update("sourceUrl", event.target.value)}
              placeholder="https://www.example.com/source"
              value={draft.sourceUrl}
            />
            <FieldError error={errors.sourceUrl} />
          </label>
          <label>
            <span>目标关键词 / Target keywords</span>
            <input
              aria-invalid={Boolean(errors.targetKeywords)}
              onChange={(event) => update("targetKeywords", event.target.value)}
              placeholder="GEO, AI 搜索优化, 品牌监测"
              value={draft.targetKeywords}
            />
            <FieldError error={errors.targetKeywords} />
          </label>
          <label>
            <span>负责人 / Owner</span>
            <input
              aria-invalid={Boolean(errors.owner)}
              onChange={(event) => update("owner", event.target.value)}
              placeholder="团队成员 / Team member"
              value={draft.owner}
            />
            <FieldError error={errors.owner} />
          </label>
          <label>
            <span>Slug</span>
            <input
              aria-invalid={Boolean(errors.slug)}
              onChange={(event) => update("slug", event.target.value)}
              placeholder="what-is-myinvois"
              value={draft.slug}
            />
            <FieldError error={errors.slug} />
          </label>
          <label>
            <span>语言 / Locale</span>
            <select onChange={(event) => update("locale", event.target.value as ContentLocale)} value={draft.locale}>
              <option value="zh-CN">zh-CN</option>
              <option value="en">en</option>
            </select>
          </label>
          <label>
            <span>类型 / Asset type</span>
            <select
              onChange={(event) => update("assetType", event.target.value as ContentAssetType)}
              value={draft.assetType}
            >
              <option value="money-page">money-page</option>
              <option value="feature-page">feature-page</option>
              <option value="guide-page">guide-page</option>
              <option value="compare-page">compare-page</option>
              <option value="faq-page">faq-page</option>
            </select>
          </label>
          <label>
            <span>受众 / Audience</span>
            <input
              aria-invalid={Boolean(errors.audience)}
              onChange={(event) => update("audience", event.target.value)}
              placeholder="SMEs, finance teams, ERP owners"
              value={draft.audience}
            />
            <FieldError error={errors.audience} />
          </label>
          <label className="wide checkbox-row">
            <input
              checked={draft.isPublic}
              onChange={(event) => {
                const checked = event.target.checked;
                update("isPublic", checked);
                update("publishTarget", checked ? "txpuro" : "geo_ops_internal");
              }}
              type="checkbox"
            />
            <span>公开到 Txpuro 产品站 / Publish on Txpuro public site</span>
          </label>
          <label className="wide">
            <span>摘要 / Summary</span>
            <textarea
              aria-invalid={Boolean(errors.summary)}
              onChange={(event) => update("summary", event.target.value)}
              placeholder="一句话说明这条内容资产的真实用途。 / One sentence about this asset."
              value={draft.summary}
            />
            <FieldError error={errors.summary} />
          </label>
          <label className="wide">
            <span>正文 / Body</span>
            <textarea
              aria-invalid={Boolean(errors.body)}
              onChange={(event) => update("body", event.target.value)}
              placeholder="粘贴真实文章、官网页面、知识库内容或 brief。 / Paste real article, page copy, knowledge base content, or brief."
              rows={7}
              value={draft.body}
            />
            <FieldError error={errors.body} />
          </label>
        </div>
        <div className="modal-actions">
          <Button disabled={submitting} onClick={onClose} variant="ghost">
            取消 / Cancel
          </Button>
          <Button
            disabled={submitting}
            icon={submitting ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
            onClick={onSubmit}
          >
            保存真实资产 / Save real asset
          </Button>
        </div>
      </section>
    </div>
  );
}

function SettingsPanel({
  action,
  auditEvents,
  onRefresh,
  onInitializeTxpuro,
  status,
  txpuroAssetCount,
}: {
  action: ActionState;
  auditEvents: AuditEventView[];
  onRefresh: () => void;
  onInitializeTxpuro: () => void;
  status: IntegrationStatus | null;
  txpuroAssetCount: number;
}) {
  const missing = status?.missing ?? [];
  const databaseHealthy = Boolean(status?.databaseConfigured && status?.databaseReachable);
  const geoFlowHealthy = Boolean(status?.geoFlowConfigured && status?.catalogReachable);
  const latestAudit = auditEvents[0];

  return (
    <section className="panel settings-panel workspace-section" id="section-settings">
      <div className="panel-heading">
        <div>
          <p>系统设置 / Settings</p>
          <h2>运行状态与集成配置 / Runtime and integration status</h2>
        </div>
        <Button
          disabled={action !== "idle"}
          icon={action === "refresh" ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
          onClick={onRefresh}
          variant="ghost"
        >
          刷新状态 / Refresh status
        </Button>
      </div>

      <div className="settings-grid">
        <article className="settings-card">
          <div>
            <strong>Txpuro Workspace</strong>
            <Chip tone={txpuroAssetCount ? "success" : "warning"}>
              {txpuroAssetCount ? `${txpuroAssetCount} assets` : "Not initialized"}
            </Chip>
          </div>
          <p>初始化 Txpuro 项目模板、公开内容资产和首批 GEO prompts。 / Initialize the Txpuro workspace, public assets, and GEO prompts.</p>
          <small>Public host: txpuro.com / www.txpuro.com</small>
          <Button
            disabled={action !== "idle"}
            icon={action === "refresh" ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
            onClick={onInitializeTxpuro}
            variant="secondary"
          >
            初始化 Txpuro / Init Txpuro
          </Button>
        </article>

        <article className="settings-card">
          <div>
            <strong>Auth</strong>
            <Chip tone="success">Session required</Chip>
          </div>
          <p>
            Better Auth sessions protect operational pages and tenant-scoped APIs.
          </p>
          <small>Public brand routes remain anonymous.</small>
        </article>

        <article className="settings-card">
          <div>
            <strong>Database</strong>
            <Chip tone={databaseHealthy ? "success" : "danger"}>
              {databaseHealthy ? "Reachable" : status?.databaseConfigured ? "Error" : "缺失 / Missing"}
            </Chip>
          </div>
          <p>内容资产、GEO runs、渠道版本和 GEOFlow 映射持久化。 / Persistent assets, runs, variants, and bridge links.</p>
          <small>
            {status?.databaseError ||
              (databaseHealthy ? "DATABASE_URL configured and reachable" : "DATABASE_URL not configured")}
          </small>
        </article>

        <article className="settings-card">
          <div>
            <strong>GEOFlow</strong>
            <Chip tone={geoFlowHealthy ? "success" : "warning"}>
              {geoFlowHealthy ? "Catalog ready" : status?.geoFlowConfigured ? "Configured" : "待配置 / Pending"}
            </Chip>
          </div>
          <p>通过 REST API 创建任务、入队生成，并由 GEO Ops 同步状态。 / Creates and syncs GEOFlow tasks through REST APIs.</p>
          <small>
            {status?.catalogReachable
              ? `Catalog reachable within ${status.geoFlowStatusTimeoutMs ?? 2500}ms timeout`
              : status?.catalogError || (missing.length ? `Missing: ${missing.join(", ")}` : "Not checked")}
          </small>
        </article>

        <article className="settings-card">
          <div>
            <strong>Postiz</strong>
            <Chip tone={status?.postizConfigured ? "success" : "warning"}>
              {status?.postizConfigured ? "Webhook ready" : "Review queue"}
            </Chip>
          </div>
          <p>社媒渠道版本可以继续交给 Postiz 排期发布。 / Social variants can be handed off to Postiz scheduling.</p>
          <small>{status?.postizConfigured ? "POSTIZ_WEBHOOK_URL configured" : "POSTIZ_WEBHOOK_URL not configured"}</small>
        </article>

        <article className="settings-card">
          <div>
            <strong>Backup</strong>
            <Chip tone="info">pg_dump</Chip>
          </div>
          <p>服务器备份目录：/opt/geo-content-ops/backups。 / Server backup directory: /opt/geo-content-ops/backups.</p>
          <small>
            建议每日运行 deploy/backup-postgres.sh，保留 14 天。 / Last checked:{" "}
            {status?.checkedAt ? formatDate(status.checkedAt) : "loading"}
          </small>
        </article>

        <article className="settings-card">
          <div>
            <strong>Audit</strong>
            <Chip tone={auditEvents.length ? "success" : "warning"}>
              {auditEvents.length ? `${auditEvents.length} events` : "No events"}
            </Chip>
          </div>
          <p>关键写入动作会记录 actor、request ID、对象和结果。 / Critical write actions record actor, request ID, entity, and outcome.</p>
          <small>
            {latestAudit
              ? `${latestAudit.action} · ${latestAudit.outcome} · ${formatDate(latestAudit.createdAt)}`
              : "Waiting for the first write action."}
          </small>
        </article>
      </div>

      {auditEvents.length ? (
        <div className="audit-list" aria-label="Recent audit events">
          {auditEvents.slice(0, 6).map((event) => (
            <article className="audit-item" key={event.id}>
              <div>
                <strong>{event.action}</strong>
                <span>{event.actor}</span>
              </div>
              <Chip tone={event.outcome === "success" ? "success" : "danger"}>
                {event.outcome}
              </Chip>
              <small>{event.entityId ?? event.entityType}</small>
              <small>{formatDate(event.createdAt)}</small>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function GeoDashboard({ initialSnapshot }: { initialSnapshot: DashboardSnapshot }) {
  const [snapshot, setSnapshot] = useState({
    ...initialSnapshot,
    geoFlowLinks: initialSnapshot.geoFlowLinks ?? [],
  });
  const [activeSection, setActiveSection] = useState<NavSection>("overview");
  const [selectedAssetId, setSelectedAssetId] = useState(initialSnapshot.assets[0]?.id ?? "");
  const [assetDraft, setAssetDraft] = useState(emptyAssetDraft);
  const [assetErrors, setAssetErrors] = useState<AssetDraftErrors>({});
  const [isAssetFormOpen, setIsAssetFormOpen] = useState(false);
  const [brief, setBrief] = useState<GeoBrief | null>(null);
  const [message, setMessage] = useState<ToastMessage>(null);
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus | null>(null);
  const [action, setAction] = useState<ActionState>("idle");

  const selectedAsset =
    snapshot.assets.find((asset) => asset.id === selectedAssetId) ?? snapshot.assets[0];
  const latestRun =
    snapshot.runs.find((run) => run.contentAssetId === selectedAssetId) ?? snapshot.runs[0];
  const topScore = averageScore(snapshot.runs);
  const readyAssets = snapshot.assets.filter((asset) =>
    ["Ready", "Scheduled"].includes(asset.status),
  ).length;
  const scheduledVariants = snapshot.variants.filter(
    (variant) => variant.status === "Scheduled",
  ).length;
  const txpuroAssetCount = snapshot.assets.filter((asset) => asset.publishTarget === "txpuro").length;
  const selectedAssetLink = snapshot.geoFlowLinks.find(
    (link) => link.contentAssetId === selectedAssetId,
  );

  useEffect(() => {
    void refreshIntegrationStatus().catch(() => {
      setIntegrationStatus(null);
    });
  }, []);

  function jumpToSection(section: NavSection) {
    setActiveSection(section);
    document.getElementById(`section-${section}`)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  function clearAssetError(field: keyof AssetDraft) {
    setAssetErrors((current) => {
      if (!current[field]) {
        return current;
      }
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function isHttpUrl(value: string) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  function validateAssetDraft(draft: AssetDraft) {
    const errors: AssetDraftErrors = {};
    const keywords = draft.targetKeywords
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    if (!draft.title.trim()) {
      errors.title = "请输入标题 / Title is required.";
    }
    if (!draft.brandEntity.trim()) {
      errors.brandEntity = "请输入品牌实体 / Brand entity is required.";
    }
    if (!draft.canonicalUrl.trim()) {
      errors.canonicalUrl = "请输入 canonical URL / Canonical URL is required.";
    } else if (!isHttpUrl(draft.canonicalUrl.trim())) {
      errors.canonicalUrl = "请输入有效的 http(s) URL / Use a valid http(s) URL.";
    }
    if (draft.sourceUrl.trim() && !isHttpUrl(draft.sourceUrl.trim())) {
      errors.sourceUrl = "请输入有效的 http(s) URL / Use a valid http(s) URL.";
    }
    if (!keywords.length) {
      errors.targetKeywords = "至少输入一个关键词 / Add at least one keyword.";
    }
    if (!draft.body.trim()) {
      errors.body = "请输入真实正文或 brief / Body or brief is required.";
    }
    if (draft.slug.trim() && !/^[a-z0-9/-]+$/.test(draft.slug.trim())) {
      errors.slug = "Slug 只能包含小写字母、数字、-、/ 。 / Use lowercase letters, numbers, - and /.";
    }
    if (draft.isPublic && !draft.audience.trim()) {
      errors.audience = "公开页面请填写受众 / Audience is required for public pages.";
    }

    return errors;
  }

  async function refreshIntegrationStatus() {
    const response = await fetch("/api/integrations/geoflow/status");
    if (!response.ok) {
      throw new Error("Integration status refresh failed.");
    }
    setIntegrationStatus((await response.json()) as IntegrationStatus);
  }

  async function refreshSnapshot() {
    const response = await fetch("/api/geo/runs");
    if (!response.ok) {
      throw new Error("Snapshot refresh failed.");
    }
    const next = await response.json();
    const nextAssets = next.assets as ContentAsset[];
    setSnapshot({
      project: next.project,
      assets: nextAssets,
      variants: next.variants,
      runs: next.runs,
      providerHealth: next.providerHealth,
      geoFlowLinks: next.geoFlowLinks ?? [],
      auditEvents: next.auditEvents ?? [],
    });
    if (!nextAssets.some((asset) => asset.id === selectedAssetId)) {
      setSelectedAssetId(nextAssets[0]?.id ?? "");
    }
  }

  async function parseApiError(response: Response, fallback: string) {
    const payload = await response.json().catch(() => null);
    if (payload?.missing?.length) {
      return `${payload.error || fallback} Missing: ${payload.missing.join(", ")}.`;
    }
    return payload?.error || fallback;
  }

  function runAction(nextAction: ActionState, callback: () => Promise<string>) {
    setAction(nextAction);
    setMessage(null);
    void callback()
      .then((nextMessage) => {
        setMessage({ text: nextMessage, tone: "success" });
      })
      .catch((error: unknown) => {
        setMessage({
          text: error instanceof Error ? error.message : "Action failed.",
          tone: "danger",
        });
      })
      .finally(() => {
        setAction("idle");
      });
  }

  function requireSelectedAsset() {
    if (!selectedAsset) {
      throw new Error("请先添加真实内容资产 / Add a real content asset first.");
    }
    return selectedAsset;
  }

  function handleRefresh() {
    runAction("refresh", async () => {
      await Promise.all([refreshSnapshot(), refreshIntegrationStatus()]);
      return "数据已刷新 / Snapshot refreshed.";
    });
  }

  function handleAudit() {
    runAction("audit", async () => {
      const asset = requireSelectedAsset();
      const response = await fetch("/api/geo/audit", {
        method: "POST",
        headers: actionHeaders,
        body: JSON.stringify({
          projectId: snapshot.project.id,
          contentAssetId: asset.id,
          content: asset.body,
          provider: "All",
        }),
      });

      if (!response.ok) {
        throw new Error("GEO audit failed.");
      }

      const payload = await response.json();
      await refreshSnapshot();
      return `${payload.runs.length} 次 GEO 监测完成 / runs completed in ${payload.mode} mode.`;
    });
  }

  function handleBrief() {
    runAction("brief", async () => {
      const asset = requireSelectedAsset();
      const response = await fetch("/api/geo/brief", {
        method: "POST",
        headers: actionHeaders,
        body: JSON.stringify({
          projectId: snapshot.project.id,
          keywords: asset.targetKeywords,
          audience: asset.audience || "content and revenue operations teams",
          locale: asset.locale || "zh-CN",
          assetType: asset.assetType || "guide-page",
        }),
      });

      if (!response.ok) {
        throw new Error("Brief generation failed.");
      }

      const payload = (await response.json()) as { brief: GeoBrief };
      setBrief(payload.brief);
      return "内容 Brief 已创建 / Content brief created.";
    });
  }

  function handleVariants() {
    runAction("variant", async () => {
      const asset = requireSelectedAsset();
      const response = await fetch("/api/geo/variant", {
        method: "POST",
        headers: actionHeaders,
        body: JSON.stringify({
          contentAssetId: asset.id,
          platforms: ["Knowledge Site", "LinkedIn", "X", "WeChat"] satisfies ChannelPlatform[],
          handoffToPostiz: true,
        }),
      });

      if (!response.ok) {
        throw new Error("Variant generation failed.");
      }

      const payload = await response.json();
      await refreshSnapshot();
      return `${payload.variants.length} 个渠道版本已生成 / variants generated. ${payload.handoff.message}`;
    });
  }

  function handleSendToGeoFlow() {
    runAction("geoflow", async () => {
      const asset = requireSelectedAsset();
      const response = await fetch("/api/integrations/geoflow/tasks", {
        method: "POST",
        headers: actionHeaders,
        body: JSON.stringify({
          contentAssetId: asset.id,
          brief,
        }),
      });

      if (!response.ok) {
        throw new Error(await parseApiError(response, "GEOFlow handoff failed."));
      }

      const payload = await response.json();
      await Promise.all([refreshSnapshot(), refreshIntegrationStatus()]);
      return payload.reused
        ? "已复用 GEOFlow 任务 / Existing GEOFlow task link reused."
        : `GEOFlow 任务 ${payload.link.geoFlowTaskId} 已入队 / queued for generation.`;
    });
  }

  function handleSyncGeoFlow() {
    runAction("sync", async () => {
      const response = await fetch("/api/integrations/geoflow/sync", {
        method: "POST",
        headers: actionHeaders,
      });

      if (!response.ok) {
        throw new Error(await parseApiError(response, "GEOFlow sync failed."));
      }

      const payload = await response.json();
      await Promise.all([refreshSnapshot(), refreshIntegrationStatus()]);
      return `GEOFlow 同步完成 / sync complete: ${payload.successCount} updated, ${payload.failureCount} failed.`;
    });
  }

  function handleCreateAsset() {
    const errors = validateAssetDraft(assetDraft);
    setAssetErrors(errors);

    if (Object.keys(errors).length) {
      setMessage({
        text: "请修正表单里的错误 / Please fix the highlighted fields.",
        tone: "danger",
      });
      return;
    }

    runAction("refresh", async () => {
      const response = await fetch("/api/content-assets", {
        method: "POST",
        headers: actionHeaders,
        body: JSON.stringify(assetDraft),
      });

      if (!response.ok) {
        throw new Error(await parseApiError(response, "Content asset creation failed."));
      }

      const payload = await response.json();
      setSelectedAssetId(payload.asset.id);
      setAssetDraft(emptyAssetDraft);
      setAssetErrors({});
      setIsAssetFormOpen(false);
      await Promise.all([refreshSnapshot(), refreshIntegrationStatus()]);
      return "真实内容资产已添加 / Real content asset added.";
    });
  }

  function handleInitializeTxpuro() {
    runAction("workspace", async () => {
      const response = await fetch("/api/workspaces/txpuro/init", {
        method: "POST",
        headers: actionHeaders,
      });

      if (!response.ok) {
        throw new Error(await parseApiError(response, "Txpuro workspace initialization failed."));
      }

      const payload = (await response.json()) as TxpuroInitPayload;
      await Promise.all([refreshSnapshot(), refreshIntegrationStatus()]);
      setSelectedAssetId(payload.assets[0]?.id ?? "");
      return `Txpuro Workspace 已初始化 / initialized with ${payload.assets.length} assets and ${payload.prompts.length} prompts.`;
    });
  }

  return (
    <main className="app-shell">
      <a className="skip-link" href="#main-workspace">
        跳到内容 / Skip to content
      </a>
      <Sidebar activeSection={activeSection} onSelect={jumpToSection} />
      <div className="workspace" id="main-workspace">
        <Header
          action={action}
          hasAsset={Boolean(selectedAsset)}
          onAudit={handleAudit}
          onBrief={handleBrief}
          onVariant={handleVariants}
          snapshot={snapshot}
        />

        <section
          aria-label="GEO operating metrics"
          className="metrics-grid workspace-section"
          id="section-overview"
        >
          <MetricTile
            icon={<Activity size={18} />}
            label="可见性 / Visibility"
            tone="teal"
            trend="基于真实监测 / from real runs"
            value={`${topScore}/100`}
          />
          <MetricTile
            icon={<Layers3 size={18} />}
            label="就绪资产 / Ready assets"
            tone="cobalt"
            trend={`${snapshot.assets.length} 条真实资产 / real canonical items`}
            value={`${readyAssets}`}
          />
          <MetricTile
            icon={<CalendarClock size={18} />}
            label="已排期 / Scheduled"
            tone="amber"
            trend="知识站、LinkedIn、X、微信 / channels"
            value={`${scheduledVariants}`}
          />
        </section>

        <ProviderStrip runs={snapshot.runs} snapshot={snapshot} />

        <div className="content-grid">
          <div className="content-stack">
            <div className="workspace-section" id="section-assets">
              <AssetTable
                assets={snapshot.assets}
                onAdd={() => setIsAssetFormOpen(true)}
                onSelect={setSelectedAssetId}
                selectedAssetId={selectedAssetId}
              />
            </div>
            <div className="workspace-section" id="section-channels">
              <VariantWorkflow selectedAssetId={selectedAssetId} variants={snapshot.variants} />
            </div>
          </div>
          <div className="workspace-section" id="section-runs">
            <RunTimeline onRefresh={handleRefresh} runs={snapshot.runs} />
          </div>
        </div>

        <SettingsPanel
          action={action}
          auditEvents={snapshot.auditEvents}
          onInitializeTxpuro={handleInitializeTxpuro}
          onRefresh={handleRefresh}
          status={integrationStatus}
          txpuroAssetCount={txpuroAssetCount}
        />
      </div>

      {selectedAsset ? (
        <RightRail
          brief={brief}
          action={action}
          geoFlowLink={selectedAssetLink}
          latestRun={latestRun}
          message={message}
          onSendToGeoFlow={handleSendToGeoFlow}
          onSyncGeoFlow={handleSyncGeoFlow}
          selectedAsset={selectedAsset}
        />
      ) : null}

      {isAssetFormOpen ? (
        <AssetFormModal
          draft={assetDraft}
          errors={assetErrors}
          onClearError={clearAssetError}
          onChange={setAssetDraft}
          onClose={() => {
            setAssetErrors({});
            setIsAssetFormOpen(false);
          }}
          onSubmit={handleCreateAsset}
          submitting={action !== "idle"}
        />
      ) : null}

    </main>
  );
}
