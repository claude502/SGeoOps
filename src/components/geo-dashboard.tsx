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
  { label: "Overview", icon: BarChart3 },
  { label: "Assets", icon: FileText },
  { label: "GEO Runs", icon: Bot },
  { label: "Channels", icon: Megaphone },
  { label: "Settings", icon: Settings },
];

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
    return "Unscheduled";
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
        <strong>Postiz handoff</strong>
        <p>Variants stay in review until a Postiz webhook is configured.</p>
      </div>
    </aside>
  );
}

function Header({
  snapshot,
  action,
  onAudit,
  onBrief,
  onVariant,
}: {
  snapshot: DashboardSnapshot;
  action: ActionState;
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
          disabled={isBusy}
          icon={action === "audit" ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
          onClick={onAudit}
        >
          Run GEO Audit
        </Button>
        <Button
          disabled={isBusy}
          icon={action === "brief" ? <Loader2 className="spin" size={16} /> : <BookOpenText size={16} />}
          onClick={onBrief}
          variant="secondary"
        >
          Create Brief
        </Button>
        <Button
          disabled={isBusy}
          icon={action === "variant" ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
          onClick={onVariant}
          variant="secondary"
        >
          Generate Variants
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
          <p>Provider coverage</p>
          <h2>AI answer engine status</h2>
        </div>
        <Chip tone="info">{runs.length} stored runs</Chip>
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
              {provider.runs} runs - {provider.latencyMs}ms - {formatDate(provider.lastRunAt)}
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
  onSelect,
}: {
  assets: ContentAsset[];
  selectedAssetId: string;
  onSelect: (assetId: string) => void;
}) {
  return (
    <section className="panel asset-panel">
      <div className="panel-heading">
        <div>
          <p>Content assets</p>
          <h2>Canonical source queue</h2>
        </div>
        <Button icon={<Plus size={16} />} variant="ghost">
          Add Asset
        </Button>
      </div>

      <div aria-label="Content assets" className="asset-table" role="listbox">
        <div className="table-row table-head">
          <span>Title</span>
          <span>Keywords</span>
          <span>Status</span>
          <span>GEO</span>
        </div>
        {assets.map((asset) => (
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
        ))}
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
          <p>Channel variants</p>
          <h2>Knowledge site to accounts</h2>
        </div>
        <Chip tone="info">{visible.length} variants</Chip>
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
          <p>Recent GEO runs</p>
          <h2>Visibility evidence</h2>
        </div>
        <Button icon={<RefreshCw size={16} />} onClick={onRefresh} variant="ghost">
          Refresh
        </Button>
      </div>
      <div className="run-list">
        {runs.slice(0, 5).map((run) => (
          <article className="run-item" key={run.id}>
            <div className={clsx("run-icon", providerPalette[run.provider])}>
              <Bot size={16} />
            </div>
            <div>
              <div className="run-line">
                <strong>{run.provider}</strong>
                <Chip tone={run.brandMentioned ? "success" : "warning"}>
                  {run.brandMentioned ? "Brand found" : "Brand missing"}
                </Chip>
                <span>{run.score}/100</span>
              </div>
              <p>{run.prompt}</p>
              <small>{run.citedDomains.length ? run.citedDomains.join(", ") : "No citations"}</small>
            </div>
          </article>
        ))}
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
            <p>Selected asset</p>
            <h2>{selectedAsset.title}</h2>
          </div>
          <Chip tone={statusTone(selectedAsset.status)}>{selectedAsset.status}</Chip>
        </div>
        <p className="asset-summary">{selectedAsset.summary}</p>
        <div className="asset-score-box">
          <Gauge size={18} />
          <span>GEO score</span>
          <strong>{selectedAsset.geoScore}</strong>
        </div>
      </section>

      <section className="panel geoflow-panel">
        <div className="panel-heading">
          <div>
            <p>GEOFlow bridge</p>
            <h2>Content factory handoff</h2>
          </div>
          <Chip tone={statusTone(geoFlowStatus)}>{geoFlowStatusLabel(geoFlowStatus)}</Chip>
        </div>
        <div className="geoflow-body">
          <div className="geoflow-state">
            <span>Task</span>
            <strong>{geoFlowLink?.geoFlowTaskId ?? "Not sent"}</strong>
          </div>
          <div className="geoflow-state">
            <span>Job</span>
            <strong>{geoFlowLink?.geoFlowJobId ?? "No job"}</strong>
          </div>
          {geoFlowLink?.geoFlowArticleUrl ? (
            <a className="external-link" href={geoFlowLink.geoFlowArticleUrl} rel="noreferrer" target="_blank">
              Open published article
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
              Send to GEOFlow
            </Button>
            <Button
              disabled={isBusy}
              icon={action === "sync" ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
              onClick={onSyncGeoFlow}
              variant="ghost"
            >
              Sync GEOFlow
            </Button>
          </div>
        </div>
      </section>

      <section className="panel recommendations">
        <div className="panel-heading">
          <div>
            <p>Recommendations</p>
            <h2>Next fixes</h2>
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
            <p>Content brief</p>
            <h2>{brief?.title ?? "Ready to generate"}</h2>
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
          <p className="muted">Create Brief will generate entity coverage, outline, FAQ, comparison angles, and schema suggestions.</p>
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

export function GeoDashboard({ initialSnapshot }: { initialSnapshot: DashboardSnapshot }) {
  const [snapshot, setSnapshot] = useState({
    ...initialSnapshot,
    geoFlowLinks: initialSnapshot.geoFlowLinks ?? [],
  });
  const [selectedAssetId, setSelectedAssetId] = useState(initialSnapshot.assets[0]?.id ?? "");
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
    setSnapshot({
      project: next.project,
      assets: next.assets,
      variants: next.variants,
      runs: next.runs,
      providerHealth: next.providerHealth,
      geoFlowLinks: next.geoFlowLinks ?? [],
    });
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

  function handleRefresh() {
    runAction("refresh", async () => {
      await refreshSnapshot();
      return "Snapshot refreshed.";
    });
  }

  function handleAudit() {
    runAction("audit", async () => {
      const response = await fetch("/api/geo/audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: snapshot.project.id,
          content: selectedAsset.body,
          provider: "All",
        }),
      });

      if (!response.ok) {
        throw new Error("GEO audit failed.");
      }

      const payload = await response.json();
      await refreshSnapshot();
      return `${payload.runs.length} GEO runs completed in ${payload.mode} mode.`;
    });
  }

  function handleBrief() {
    runAction("brief", async () => {
      const response = await fetch("/api/geo/brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: snapshot.project.id,
          keywords: selectedAsset.targetKeywords,
          audience: "content and revenue operations teams",
        }),
      });

      if (!response.ok) {
        throw new Error("Brief generation failed.");
      }

      const payload = (await response.json()) as { brief: GeoBrief };
      setBrief(payload.brief);
      return "Content brief created with outline, FAQ, comparison angles, and schema suggestions.";
    });
  }

  function handleVariants() {
    runAction("variant", async () => {
      const response = await fetch("/api/geo/variant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contentAssetId: selectedAsset.id,
          platforms: ["Knowledge Site", "LinkedIn", "X", "WeChat"] satisfies ChannelPlatform[],
          handoffToPostiz: true,
        }),
      });

      if (!response.ok) {
        throw new Error("Variant generation failed.");
      }

      const payload = await response.json();
      await refreshSnapshot();
      return `${payload.variants.length} variants generated. ${payload.handoff.message}`;
    });
  }

  function handleSendToGeoFlow() {
    runAction("geoflow", async () => {
      const response = await fetch("/api/integrations/geoflow/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contentAssetId: selectedAsset.id,
          brief,
        }),
      });

      if (!response.ok) {
        throw new Error(await parseApiError(response, "GEOFlow handoff failed."));
      }

      const payload = await response.json();
      await refreshSnapshot();
      return payload.reused
        ? "Existing GEOFlow task link reused."
        : `GEOFlow task ${payload.link.geoFlowTaskId} queued for generation.`;
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
      return `GEOFlow sync complete: ${payload.successCount} updated, ${payload.failureCount} failed.`;
    });
  }

  return (
    <main className="app-shell">
      <a className="skip-link" href="#main-workspace">
        Skip to content
      </a>
      <Sidebar />
      <div className="workspace" id="main-workspace">
        <Header
          action={action}
          onAudit={handleAudit}
          onBrief={handleBrief}
          onVariant={handleVariants}
          snapshot={snapshot}
        />

        <section className="metrics-grid" aria-label="GEO operating metrics">
          <MetricTile
            icon={<Activity size={18} />}
            label="Visibility"
            tone="teal"
            trend="+8 from last benchmark"
            value={`${topScore}/100`}
          />
          <MetricTile
            icon={<Layers3 size={18} />}
            label="Ready assets"
            tone="cobalt"
            trend={`${snapshot.assets.length} total canonical items`}
            value={`${readyAssets}`}
          />
          <MetricTile
            icon={<CalendarClock size={18} />}
            label="Scheduled"
            tone="amber"
            trend="Across Knowledge Site, LinkedIn, X, WeChat"
            value={`${scheduledVariants}`}
          />
        </section>

        <ProviderStrip runs={snapshot.runs} snapshot={snapshot} />

        <div className="content-grid">
          <div className="content-stack">
            <AssetTable
              assets={snapshot.assets}
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

    </main>
  );
}
