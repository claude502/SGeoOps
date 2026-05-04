"use client";

import {
  Activity,
  BarChart3,
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
  Megaphone,
  Network,
  Play,
  Plus,
  RefreshCw,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import clsx from "clsx";
import type {
  ChannelPlatform,
  ChannelVariant,
  ContentAsset,
  DashboardSnapshot,
  GEORun,
  GeoFlowTaskLinkView,
  GeoBrief,
  Provider,
} from "@/types/geo";

type ActionState = "idle" | "audit" | "brief" | "variant" | "refresh" | "geoflow" | "sync";

const navItems = [
  { label: "总览 / Overview", icon: BarChart3 },
  { label: "资产 / Assets", icon: FileText },
  { label: "监测 / GEO Runs", icon: Bot },
  { label: "渠道 / Channels", icon: Megaphone },
  { label: "设置 / Settings", icon: Settings },
];

const emptyAssetDraft = {
  title: "",
  brandEntity: "",
  canonicalUrl: "",
  sourceUrl: "",
  targetKeywords: "",
  summary: "",
  body: "",
  owner: "",
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

function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Network size={22} strokeWidth={2.2} />
        </div>
        <span>GEO Ops</span>
      </div>

      <nav aria-label="Primary navigation" className="nav-list">
        {navItems.map((item, index) => {
          const Icon = item.icon;
          return (
            <button
              className={clsx("nav-item", index === 0 && "nav-item-active")}
              key={item.label}
              type="button"
            >
              <Icon size={18} />
              <span>{item.label}</span>
            </button>
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
  message: string;
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
        <div className="toast" role="status">
          {message}
        </div>
      ) : null}
    </aside>
  );
}

function AssetFormModal({
  draft,
  onChange,
  onClose,
  onSubmit,
  submitting,
}: {
  draft: typeof emptyAssetDraft;
  onChange: (draft: typeof emptyAssetDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  function update(field: keyof typeof emptyAssetDraft, value: string) {
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
              onChange={(event) => update("title", event.target.value)}
              placeholder="例如：品牌 GEO 内容策略 / Brand GEO content strategy"
              value={draft.title}
            />
          </label>
          <label>
            <span>品牌实体 / Brand entity</span>
            <input
              onChange={(event) => update("brandEntity", event.target.value)}
              placeholder="你的真实品牌名 / Your real brand"
              value={draft.brandEntity}
            />
          </label>
          <label>
            <span>Canonical URL</span>
            <input
              onChange={(event) => update("canonicalUrl", event.target.value)}
              placeholder="https://www.example.com/article"
              value={draft.canonicalUrl}
            />
          </label>
          <label>
            <span>来源 URL / Source URL</span>
            <input
              onChange={(event) => update("sourceUrl", event.target.value)}
              placeholder="https://www.example.com/source"
              value={draft.sourceUrl}
            />
          </label>
          <label>
            <span>目标关键词 / Target keywords</span>
            <input
              onChange={(event) => update("targetKeywords", event.target.value)}
              placeholder="GEO, AI 搜索优化, 品牌监测"
              value={draft.targetKeywords}
            />
          </label>
          <label>
            <span>负责人 / Owner</span>
            <input
              onChange={(event) => update("owner", event.target.value)}
              placeholder="团队成员 / Team member"
              value={draft.owner}
            />
          </label>
          <label className="wide">
            <span>摘要 / Summary</span>
            <textarea
              onChange={(event) => update("summary", event.target.value)}
              placeholder="一句话说明这条内容资产的真实用途。 / One sentence about this asset."
              value={draft.summary}
            />
          </label>
          <label className="wide">
            <span>正文 / Body</span>
            <textarea
              onChange={(event) => update("body", event.target.value)}
              placeholder="粘贴真实文章、官网页面、知识库内容或 brief。 / Paste real article, page copy, knowledge base content, or brief."
              rows={7}
              value={draft.body}
            />
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

export function GeoDashboard({ initialSnapshot }: { initialSnapshot: DashboardSnapshot }) {
  const [snapshot, setSnapshot] = useState({
    ...initialSnapshot,
    geoFlowLinks: initialSnapshot.geoFlowLinks ?? [],
  });
  const [selectedAssetId, setSelectedAssetId] = useState(initialSnapshot.assets[0]?.id ?? "");
  const [assetDraft, setAssetDraft] = useState(emptyAssetDraft);
  const [isAssetFormOpen, setIsAssetFormOpen] = useState(false);
  const [brief, setBrief] = useState<GeoBrief | null>(null);
  const [message, setMessage] = useState("");
  const [action, setAction] = useState<ActionState>("idle");

  const selectedAsset =
    snapshot.assets.find((asset) => asset.id === selectedAssetId) ?? snapshot.assets[0];
  const latestRun = snapshot.runs[0];
  const topScore = averageScore(snapshot.runs);
  const readyAssets = snapshot.assets.filter((asset) =>
    ["Ready", "Scheduled"].includes(asset.status),
  ).length;
  const scheduledVariants = snapshot.variants.filter(
    (variant) => variant.status === "Scheduled",
  ).length;
  const selectedAssetLink = snapshot.geoFlowLinks.find(
    (link) => link.contentAssetId === selectedAssetId,
  );

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
    setMessage("");
    void callback()
      .then((nextMessage) => {
        setMessage(nextMessage);
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : "Action failed.");
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
      await refreshSnapshot();
      return "数据已刷新 / Snapshot refreshed.";
    });
  }

  function handleAudit() {
    runAction("audit", async () => {
      const asset = requireSelectedAsset();
      const response = await fetch("/api/geo/audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: snapshot.project.id,
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: snapshot.project.id,
          keywords: asset.targetKeywords,
          audience: "content and revenue operations teams",
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
        headers: { "content-type": "application/json" },
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contentAssetId: asset.id,
          brief,
        }),
      });

      if (!response.ok) {
        throw new Error(await parseApiError(response, "GEOFlow handoff failed."));
      }

      const payload = await response.json();
      await refreshSnapshot();
      return payload.reused
        ? "已复用 GEOFlow 任务 / Existing GEOFlow task link reused."
        : `GEOFlow 任务 ${payload.link.geoFlowTaskId} 已入队 / queued for generation.`;
    });
  }

  function handleSyncGeoFlow() {
    runAction("sync", async () => {
      const response = await fetch("/api/integrations/geoflow/sync", {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(await parseApiError(response, "GEOFlow sync failed."));
      }

      const payload = await response.json();
      await refreshSnapshot();
      return `GEOFlow 同步完成 / sync complete: ${payload.successCount} updated, ${payload.failureCount} failed.`;
    });
  }

  function handleCreateAsset() {
    runAction("refresh", async () => {
      const response = await fetch("/api/content-assets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(assetDraft),
      });

      if (!response.ok) {
        throw new Error(await parseApiError(response, "Content asset creation failed."));
      }

      const payload = await response.json();
      setSelectedAssetId(payload.asset.id);
      setAssetDraft(emptyAssetDraft);
      setIsAssetFormOpen(false);
      await refreshSnapshot();
      return "真实内容资产已添加 / Real content asset added.";
    });
  }

  return (
    <main className="app-shell">
      <a className="skip-link" href="#main-workspace">
        跳到内容 / Skip to content
      </a>
      <Sidebar />
      <div className="workspace" id="main-workspace">
        <Header
          action={action}
          hasAsset={Boolean(selectedAsset)}
          onAudit={handleAudit}
          onBrief={handleBrief}
          onVariant={handleVariants}
          snapshot={snapshot}
        />

        <section className="metrics-grid" aria-label="GEO operating metrics">
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
            <AssetTable
              assets={snapshot.assets}
              onAdd={() => setIsAssetFormOpen(true)}
              onSelect={setSelectedAssetId}
              selectedAssetId={selectedAssetId}
            />
            <VariantWorkflow selectedAssetId={selectedAssetId} variants={snapshot.variants} />
          </div>
          <RunTimeline onRefresh={handleRefresh} runs={snapshot.runs} />
        </div>
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
          onChange={setAssetDraft}
          onClose={() => setIsAssetFormOpen(false)}
          onSubmit={handleCreateAsset}
          submitting={action !== "idle"}
        />
      ) : null}

    </main>
  );
}
